"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const puppeteer = require("puppeteer-core");
const { CPU_PROFILE, detectEncoder, globalEncoderArgs, encoderFilterSuffix, videoEncoderArgs } = require("./gpu-encoder");
const { cpuX264Preset, liveMuxArgs } = require("./rtmp-pipeline");
const { PcmAudioRelay } = require("./audio-relay");
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

function audioTransportFor(accountId, runtimeDir, platform = process.platform) {
  if (platform !== "win32") return {
    live:{ input:path.join(runtimeDir,"live-audio.fifo"), output:path.join(runtimeDir,"live-audio.fifo") },
    music:{ input:path.join(runtimeDir,"music-audio.fifo"), output:path.join(runtimeDir,"music-audio.fifo") },
    fifo:true,
  };
  let hash=2166136261;
  for(const char of String(accountId||"castnexus")){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}
  const base=30000+((hash>>>0)%8000)*4;
  const endpoint=(inputPort,outputPort)=>({input:`tcp://127.0.0.1:${outputPort}`,output:`tcp://127.0.0.1:${inputPort}`,inputPort,outputPort});
  return { live:endpoint(base,base+1), music:endpoint(base+2,base+3), fifo:false, paced:true };
}

function buildChromiumGpuArgs(gpuEnabled, platform = process.platform) {
  // CPU-only hosts still need Chromium's software rasterizer in order to
  // produce compositor frames. Disabling both GPU and software rasterization
  // can leave Page.startScreencast() alive but with no frames at all, which in
  // turn leaves FFmpeg waiting forever and Music 24/7 stuck at Idle.
  // "--use-gl=swiftshader" is a legacy GL selector that current Chromium no
  // longer recognizes and silently falls back to "--use-gl=disabled" (no
  // rendering at all). The ANGLE-routed selector below is what still works.
  if (!gpuEnabled) return ["--disable-gpu", "--enable-software-rasterization", "--use-gl=angle", "--use-angle=swiftshader"];
  const backend = platform === "win32" ? ["--use-gl=angle", "--use-angle=d3d11"] : ["--use-gl=egl"];
  return ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy", ...backend, "--disable-frame-rate-limit"];
}

function useElectronOffscreen(installType = process.env.CASTNEXUS_INSTALL_TYPE, versions = process.versions) {
  return String(installType || "").toLowerCase() === "electron" && !!versions?.electron;
}

function watchdogActivityAt(electronOffscreen, lastPaintAt, lastFrameAt) {
  return electronOffscreen ? lastPaintAt : lastFrameAt;
}

function audioInputPlan(includeLiveAudio, live, music) {
  const pcm=input=>["-thread_queue_size","1024","-f","s16le","-ar","48000","-ac","2","-i",input];
  if(!includeLiveAudio)return {
    args:pcm(music),
    filter:"[1:a]aresample=async=1:first_pts=0[a]",
  };
  return {
    args:[...pcm(live),...pcm(music)],
    filter:"[1:a][2:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,aresample=async=1:first_pts=0[a]",
  };
}

function compositorFilterGraph({ fps, encoder, audioPlan }) {
  return [`[0:v]fps=${fps},setsar=1[vbase]`,encoderFilterSuffix(encoder,"vbase","v"),audioPlan.filter].join(";");
}

function videoInputArgs({electronOffscreen,fps,width,height}){
  if(electronOffscreen)return ["-thread_queue_size","1024","-framerate",String(fps),"-f","rawvideo","-pixel_format","bgra","-video_size",`${width}x${height}`,"-i","-"];
  return ["-thread_queue_size","1024","-framerate",String(fps),"-use_wallclock_as_timestamps","1","-f","image2pipe","-vcodec","mjpeg","-i","-"];
}

function electronOffscreenWindowOptions(width, height) {
  return {
    width,
    height,
    // BrowserWindow normally interprets width/height as the outer window.
    // Windows reserved 30 px even for this hidden offscreen window, producing
    // a real 1920x1050 Twitch stream. Make these dimensions the page itself.
    useContentSize:true,
    show:false,
    frame:false,
    webPreferences:{
      offscreen:true,
      backgroundThrottling:false,
      nodeIntegration:false,
      contextIsolation:true,
      sandbox:true,
    },
  };
}

function defaultVideoConfig() {
  const detected = detectEncoder();
  const mode = String(process.env.COMPOSITOR_GPU || "auto").toLowerCase();
  return {
    width:Number(process.env.COMPOSITOR_WIDTH || 1280),
    height:Number(process.env.COMPOSITOR_HEIGHT || 720),
    fps:Number(process.env.COMPOSITOR_FPS || 30),
    gpuEnabled:mode === "true" || (mode === "auto" && detected.hardware),
    // JPEG is an intermediate transport into FFmpeg, not the final stream
    // quality. 70 materially reduces main-process encode work at 1080p while
    // the final NVENC/x264 bitrate remains unchanged.
    screencastQuality:Number(process.env.COMPOSITOR_JPEG_QUALITY || 70),
  };
}

class Compositor extends EventEmitter {
  constructor({ accountId, pageUrl, audioSourceUrl, outputUrl, getMusicNow, musicFilePathFor, video, runtimeDir, logger, includeLiveAudio = true }) {
    super();
    this.accountId=accountId;
    this.pageUrl=pageUrl;
    this.audioSourceUrl=audioSourceUrl;
    this.includeLiveAudio=includeLiveAudio!==false;
    this.outputUrl=outputUrl;
    this.getMusicNow=getMusicNow;
    this.musicFilePathFor=musicFilePathFor;
    this.video={...defaultVideoConfig(),...(video||{})};
    this.runtimeDir=runtimeDir||path.join(os.tmpdir(),"restreamnode-compositor",accountId);
    this.audioTransport=audioTransportFor(accountId,this.runtimeDir);
    this.audioRelays=[];
    if(!this.audioTransport.fifo){
      for(const name of ["live-audio.fifo","music-audio.fifo"]){try{fs.rmSync(path.join(this.runtimeDir,name),{force:true});}catch{}}
    }
    this.logger=logger||console;
    this.debug=String(process.env.COMPOSITOR_DEBUG||"").toLowerCase()==="true";
    this.encoder=detectEncoder();
    this.forceCpu=false;
    this.state="idle";
    this.shouldRun=false;
    this.error=null;
    this.frameCount=0;
    this.framesDropped=0;
    this.lastFrameAt=null;
    this.lastPaintAt=null;
    this.latestFrame=null;
    this.framePumpTimer=null;
    this.paintKeepaliveTimer=null;
    this.electronOffscreen=useElectronOffscreen();
    this.offscreenWindow=null;
    this.browser=null;
    this.browserProfileDir=null;
    this.page=null;
    this.client=null;
    this.ffmpeg=null;
    this.liveAudioTap=null;
    this.liveAudioFifoFd=null;
    this.musicAudioTap=null;
    this.musicAudioFifoFd=null;
    this.currentMusicTrackId=null;
    this.musicPollTimer=null;
    this.restartTimer=null;
    this.reconnecting=false;
    this.reconnectBackoffMs=1000;
    this.watchdogTimer=null;
  }

  status(){
    const enc=this.forceCpu?CPU_PROFILE:this.encoder;
    return {
      state:this.state,
      error:this.error,
      frameCount:this.frameCount,
      framesDropped:this.framesDropped,
      lastFrameAt:this.lastFrameAt,
      firstFrameReady:!!this.latestFrame,
      encoder:enc.label,
      hardwareEncoder:!!enc.hardware,
    };
  }

  async start(){
    if(this.state==="running"||this.state==="starting")return;
    this.shouldRun=true;
    this.error=null;
    this._setState("starting");
    try{
      await this._runOnce();
      this.reconnectBackoffMs=1000;
      this._setState("running");
    }catch(err){
      this.logger.error(`[compositor:${this.accountId}] start failed: ${err.message}`);
      this.error=err.message;
      this._setState("idle");
      this._scheduleReconnect();
    }
  }

  async stop(){
    this.shouldRun=false;
    this._setState("stopping");
    if(this.restartTimer){clearTimeout(this.restartTimer);this.restartTimer=null;}
    await this._teardown();
    this._setState("idle");
  }

  _setState(s){if(this.state===s)return;this.state=s;this.emit("status",this.status());}

  async _runOnce(){
    fs.mkdirSync(this.runtimeDir,{recursive:true});
    this._startAudioRelays();
    if(this.includeLiveAudio)this._startLiveAudioTap();
    await this._startMusicAudioTap();
    await this._launchBrowser();
    await this._openScene();
    this._spawnFfmpeg();
    await this._startScreencast();
    this._startWatchdog();
    this._startMusicPoll();
    const enc=this.forceCpu?CPU_PROFILE:this.encoder;
    const renderer=this.electronOffscreen?"electron-offscreen":"chromium-cdp";
    this.logger.log(`[compositor:${this.accountId}] running (${this.video.width}x${this.video.height}@${this.video.fps}, encoder=${enc.label}, renderer=${renderer}, chromiumGpu=${this.video.gpuEnabled})`);
  }

  async _launchBrowser(){
    if(this.electronOffscreen){
      const { BrowserWindow }=require("electron");
      this.offscreenWindow=new BrowserWindow(electronOffscreenWindowOptions(this.video.width,this.video.height));
      this.offscreenWindow.setContentSize(this.video.width,this.video.height);
      this.offscreenWindow.webContents.setFrameRate(Math.max(1,Math.min(Number(this.video.fps||30),60)));
      this.offscreenWindow.once("closed",()=>{
        this.offscreenWindow=null;
        if(this.shouldRun&&this.state!=="stopping")this._scheduleReconnect();
      });
      return;
    }
    const execPath=process.env.PUPPETEER_EXECUTABLE_PATH||"/usr/bin/chromium-browser";
    const profileRoot=path.join(this.runtimeDir,"profiles");
    fs.mkdirSync(profileRoot,{recursive:true});
    this.browserProfileDir=fs.mkdtempSync(path.join(profileRoot,"profile-"));
    try{
      this.browser=await puppeteer.launch({
        executablePath:execPath,
        headless:"new",
        userDataDir:this.browserProfileDir,
        defaultViewport:{width:this.video.width,height:this.video.height,deviceScaleFactor:1},
        args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",...buildChromiumGpuArgs(this.video.gpuEnabled),"--no-zygote","--disable-background-timer-throttling","--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding","--autoplay-policy=no-user-gesture-required","--hide-scrollbars","--mute-audio","--disable-features=Translate,BackForwardCache,PaintHolding","--no-first-run","--no-default-browser-check","--disable-extensions","--disable-notifications","--disable-sync","--metrics-recording-only","--no-pings",`--window-size=${this.video.width},${this.video.height}`],
      });
    }catch(err){
      this._cleanupBrowserProfile();
      throw err;
    }
    this.browser.on("disconnected",()=>{
      if(this.shouldRun&&this.state!=="stopping"){
        this.logger.warn(`[compositor:${this.accountId}] chromium disconnected`);
        this._scheduleReconnect();
      }
    });
  }

  async _openScene(){
    if(this.electronOffscreen){
      await this.offscreenWindow.webContents.loadURL(this.pageUrl);
      if(this.debug)this.logger.log(`[compositor:${this.accountId}] scene loaded ${this.pageUrl} in Electron offscreen renderer`);
      return;
    }
    this.page=await this.browser.newPage();
    await this.page.setViewport({width:this.video.width,height:this.video.height,deviceScaleFactor:1});
    await this.page.goto(this.pageUrl,{waitUntil:"domcontentloaded",timeout:30000});
    if(this.debug)this.logger.log(`[compositor:${this.accountId}] scene loaded ${this.pageUrl}`);
  }

  async _startScreencast(){
    this._stopFramePump();
    this.latestFrame=null;
    this.lastPaintAt=null;
    if(this.electronOffscreen){
      const wc=this.offscreenWindow.webContents;
      let firstCapture=true;
      const onPaint=(_event,_dirty,image)=>{
        this.lastPaintAt=Date.now();
        const ffmpeg=this.ffmpeg;
        const stdin=ffmpeg?.stdin;
        if(!stdin?.writable)return;
        if(stdin.writableLength>32*1024*1024){this.framesDropped++;return;}
        let frame;
        try{
          const size=image.getSize();
          const exact=size.width===this.video.width&&size.height===this.video.height
            ? image
            : image.resize({width:this.video.width,height:this.video.height,quality:"good"});
          if(firstCapture&&exact!==image)this.logger.warn(`[compositor:${this.accountId}] Electron painted ${size.width}x${size.height}; correcting to ${this.video.width}x${this.video.height}`);
          // NativeImage bitmaps are tightly packed BGRA on Windows/Linux.
          // Passing them directly avoids synchronously JPEG-compressing every
          // 1080p frame in Electron's main process, which reduced complete
          // scene motion to a few updates per second despite a 30 fps page.
          frame=exact.getBitmap();
        }catch{return;}
        if(!frame?.length)return;
        this.latestFrame=frame;
        this.frameCount++;
        this.lastFrameAt=Date.now();
        if(this.debug&&firstCapture){
          firstCapture=false;
          this.logger.log(`[compositor:${this.accountId}] first Electron offscreen frame (${frame.length} bytes)`);
        }
        try{stdin.write(frame);}catch(err){if(err?.code!=="EPIPE")this.logger.warn(`[compositor:${this.accountId}] offscreen paint error: ${err.message}`);}
      };
      this.electronPaintHandler=onPaint;
      wc.on("paint",onPaint);
      this.paintKeepaliveTimer=setInterval(()=>{
        try{if(this.offscreenWindow&&!this.offscreenWindow.isDestroyed())this.offscreenWindow.webContents.invalidate();}catch{}
      },1000);
      wc.invalidate();
      const firstFrameTimeout=Math.max(1000,Number(process.env.COMPOSITOR_FIRST_FRAME_TIMEOUT_MS||10000));
      const deadline=Date.now()+firstFrameTimeout;
      while(!this.latestFrame&&this.shouldRun&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
      if(!this.latestFrame)throw new Error(`Electron did not produce an offscreen compositor frame within ${firstFrameTimeout}ms`);
      return;
    }
    this.client=await this.page.target().createCDPSession();
    const cdp=this.client;
    let firstCapture=true;
    this.client.on("Page.screencastFrame",({data,sessionId})=>{
      cdp.send("Page.screencastFrameAck",{sessionId}).catch(()=>{});
      try{
        this.latestFrame=Buffer.from(data,"base64");
        if(this.debug&&firstCapture){
          firstCapture=false;
          this.logger.log(`[compositor:${this.accountId}] first Chromium frame (${this.latestFrame.length} bytes)`);
        }
      }catch{}
    });
    await this.client.send("Page.startScreencast",{format:"jpeg",quality:this.video.screencastQuality,maxWidth:this.video.width,maxHeight:this.video.height});

    const firstFrameTimeout=Math.max(1000,Number(process.env.COMPOSITOR_FIRST_FRAME_TIMEOUT_MS||10000));
    const deadline=Date.now()+firstFrameTimeout;
    while(!this.latestFrame&&this.shouldRun&&Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    if(!this.latestFrame){
      throw new Error(`Chromium did not produce a compositor frame within ${firstFrameTimeout}ms`);
    }

    this._startFramePump();
  }

  _startFramePump(){
    this._stopFramePump();
    const interval=Math.max(10,Math.round(1000/Math.max(1,Number(this.video.fps||30))));
    const pump=()=>{
      const ffmpeg=this.ffmpeg;
      const frame=this.latestFrame;
      if(!ffmpeg||!frame)return;
      const stdin=ffmpeg.stdin;
      if(!stdin?.writable)return;
      if(stdin.writableLength>256*1024){this.framesDropped++;return;}
      try{
        stdin.write(frame);
        this.frameCount++;
        this.lastFrameAt=Date.now();
      }catch(err){
        if(err?.code!=="EPIPE")this.logger.warn(`[compositor:${this.accountId}] frame pump error: ${err.message}`);
      }
    };
    this.framePumpTimer=setInterval(pump,interval);
    pump();
  }

  _stopFramePump(){
    if(this.framePumpTimer){clearInterval(this.framePumpTimer);this.framePumpTimer=null;}
    if(this.paintKeepaliveTimer){clearInterval(this.paintKeepaliveTimer);this.paintKeepaliveTimer=null;}
    if(this.offscreenWindow&&this.electronPaintHandler){
      try{this.offscreenWindow.webContents.removeListener("paint",this.electronPaintHandler);}catch{}
    }
    this.electronPaintHandler=null;
    this.latestFrame=null;
    this.lastPaintAt=null;
  }

  _fifoPath(name){return path.join(this.runtimeDir,`${name}.fifo`);}

  _startAudioRelays(){
    if(!this.audioTransport.paced||this.audioRelays.length)return;
    for(const endpoint of [this.audioTransport.live,this.audioTransport.music]){
      const relay=new PcmAudioRelay({inputPort:endpoint.inputPort,outputPort:endpoint.outputPort,logger:this.logger});
      relay.start();
      this.audioRelays.push(relay);
    }
  }

  _stopAudioRelays(){
    for(const relay of this.audioRelays){try{relay.stop();}catch{}}
    this.audioRelays=[];
  }

  _ensureFifo(fifoPath){
    try{
      const stat=fs.statSync(fifoPath);
      if(stat.isFIFO()){
        try{fs.chmodSync(fifoPath,0o666);}catch{}
        return;
      }
      fs.unlinkSync(fifoPath);
    }catch(err){
      if(err.code!=="ENOENT")this.logger.warn(`[compositor:${this.accountId}] fifo stat failed: ${err.message}`);
    }
    fs.mkdirSync(path.dirname(fifoPath),{recursive:true});
    const r=spawnSync("mkfifo",["-m","666",fifoPath]);
    if(r.status!==0)this.logger.warn(`[compositor:${this.accountId}] mkfifo failed: ${r.stderr?.toString()}`);
    try{fs.chmodSync(fifoPath,0o666);}catch{}
  }

  _startLiveAudioTap(){
    const fifo=this.audioTransport.live.output;
    if(this.audioTransport.fifo)this._ensureFifo(fifo);
    if(this.audioTransport.fifo&&this.liveAudioFifoFd==null){
      try{
        this.liveAudioFifoFd=fs.openSync(fifo,fs.constants.O_RDWR|fs.constants.O_NONBLOCK);
      }catch(err){
        this.logger.warn(`[compositor:${this.accountId}] could not keep-alive live fifo: ${err.message}`);
        this.liveAudioFifoFd=null;
      }
    }
    // The live source (including the Music 24/7 silence placeholder) is intentionally
    // tiny (~20KB/s). FFmpeg's default probesize (5MB) can take minutes to satisfy at
    // that bitrate, so this tap sits producing zero audio well past the compositor's
    // watchdog timeout unless probing is explicitly bounded to something it can hit fast.
    const child=spawn(FFMPEG_BIN,["-hide_banner","-loglevel",this.debug?"info":"warning","-nostdin","-y","-analyzeduration","1000000","-probesize","32768","-thread_queue_size","1024","-i",this.audioSourceUrl,"-vn","-af","aresample=async=1:first_pts=0","-f","s16le","-ar","48000","-ac","2",fifo]);
    child.stderr.on("data",chunk=>{if(this.debug){const line=chunk.toString().trim();if(line)this.logger.log(`[compositor:${this.accountId}] live-audio: ${line}`);}});
    child.on("exit",()=>{
      if(this.liveAudioTap===child)this.liveAudioTap=null;
      if(this.shouldRun&&this.state!=="stopping")setTimeout(()=>{if(this.shouldRun)this._startLiveAudioTap();},1200);
    });
    this.liveAudioTap=child;
  }

  _stopLiveAudioTap(){
    if(this.liveAudioTap){
      const child=this.liveAudioTap;
      this.liveAudioTap=null;
      child.removeAllListeners("exit");
      try{child.kill("SIGTERM");}catch{}
    }
    if(this.liveAudioFifoFd!=null){
      try{fs.closeSync(this.liveAudioFifoFd);}catch{}
      this.liveAudioFifoFd=null;
    }
  }

  async _startMusicAudioTap(){
    const fifo=this.audioTransport.music.output;
    if(this.audioTransport.fifo)this._ensureFifo(fifo);
    if(this.musicAudioFifoFd!=null){try{fs.closeSync(this.musicAudioFifoFd);}catch{}}
    this.musicAudioFifoFd=null;
    if(this.audioTransport.fifo){
      try{
        this.musicAudioFifoFd=fs.openSync(fifo,fs.constants.O_RDWR|fs.constants.O_NONBLOCK);
      }catch(err){
        this.logger.warn(`[compositor:${this.accountId}] could not keep-alive music fifo: ${err.message}`);
      }
    }
    this._syncMusicTap();
  }

  _syncMusicTap(){
    let now;
    try{now=this.getMusicNow();}catch{now=null;}
    const trackId=now?.mode==="playing"?now.track?.id:null;
    const sourceId=trackId||"__silence__";
    if(sourceId===this.currentMusicTrackId&&this.musicAudioTap)return;
    this.currentMusicTrackId=sourceId;
    if(this.musicAudioTap){
      const old=this.musicAudioTap;
      this.musicAudioTap=null;
      old.removeAllListeners("exit");
      old.kill("SIGTERM");
    }
    const fifo=this.audioTransport.music.output;
    let args;
    if(trackId){
      let filePath;
      try{filePath=this.musicFilePathFor(trackId);}catch{filePath=null;}
      if(filePath&&fs.existsSync(filePath)){
        args=["-hide_banner","-loglevel",this.debug?"info":"warning","-nostdin","-y","-re","-ss",String(Math.max(0,now.positionS||0)),"-i",filePath,"-vn","-af","aresample=async=1:first_pts=0","-f","s16le","-ar","48000","-ac","2",fifo];
      }else{
        this.currentMusicTrackId="__silence__";
        args=["-hide_banner","-loglevel",this.debug?"info":"warning","-nostdin","-y","-re","-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-f","s16le","-ar","48000","-ac","2",fifo];
      }
    }else{
      args=["-hide_banner","-loglevel",this.debug?"info":"warning","-nostdin","-y","-re","-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-f","s16le","-ar","48000","-ac","2",fifo];
    }
    const child=spawn(FFMPEG_BIN,args);
    child.stderr.on("data",chunk=>{if(this.debug){const line=chunk.toString().trim();if(line)this.logger.log(`[compositor:${this.accountId}] music-audio: ${line}`);}});
    child.on("exit",()=>{
      if(this.musicAudioTap===child){
        this.musicAudioTap=null;
        if(this.shouldRun&&this.state!=="stopping")setTimeout(()=>this._syncMusicTap(),250);
      }
    });
    this.musicAudioTap=child;
  }

  _startMusicPoll(){this._stopMusicPoll();this.musicPollTimer=setInterval(()=>this._syncMusicTap(),1000);}
  _stopMusicPoll(){if(this.musicPollTimer){clearInterval(this.musicPollTimer);this.musicPollTimer=null;}}

  _spawnFfmpeg(){
    const live=this.audioTransport.live.input,music=this.audioTransport.music.input,enc=this.forceCpu?CPU_PROFILE:this.encoder;
    const audioPlan=audioInputPlan(this.includeLiveAudio,live,music);
    const lowPower=!enc.hardware&&(process.arch==="arm64"||process.arch==="arm");
    const bitrate=this.video.bitrate||process.env.COMPOSITOR_VIDEO_BITRATE||(this.video.width<=1280&&this.video.height<=1280?"4000k":"6000k");
    const maxrate=this.video.maxrate||process.env.COMPOSITOR_VIDEO_MAXRATE||bitrate;
    const bufsize=this.video.bufsize||process.env.COMPOSITOR_VIDEO_BUFSIZE||(this.video.width<=1280&&this.video.height<=1280?"8000k":"12000k");
    const filter=compositorFilterGraph({fps:this.video.fps,width:this.video.width,height:this.video.height,encoder:enc,audioPlan,musicOnly:!this.includeLiveAudio});
    const args=["-hide_banner","-loglevel",this.debug?"info":"warning","-nostats",...globalEncoderArgs(enc),...videoInputArgs({electronOffscreen:this.electronOffscreen,fps:this.video.fps,width:this.video.width,height:this.video.height}),...audioPlan.args,"-filter_complex",filter,"-map","[v]","-map","[a]","-r",String(this.video.fps),"-fps_mode","cfr",...videoEncoderArgs(enc,{fps:this.video.fps,gop:this.video.fps,bitrate,maxrate,bufsize,x264Preset:process.env.COMPOSITOR_X264_PRESET||cpuX264Preset({hardwareEncoder:enc.hardware,explicit:lowPower?"ultrafast":null})}),"-c:a","aac","-b:a",process.env.COMPOSITOR_AUDIO_BITRATE||"128k","-ar","48000","-ac","2",...liveMuxArgs(this.outputUrl,"flv"),this.outputUrl];
    if(this.debug)this.logger.log(`[compositor:${this.accountId}] ffmpeg command: ffmpeg ${args.join(" ")}`);
    const started=Date.now();
    this.ffmpeg=spawn(FFMPEG_BIN,args,{stdio:["pipe","ignore","pipe"]});
    this.ffmpeg.on("spawn",()=>{if(this.debug)this.logger.log(`[compositor:${this.accountId}] ffmpeg spawned pid=${this.ffmpeg?.pid}`);});
    this.ffmpeg.on("error",err=>{this.logger.warn(`[compositor:${this.accountId}] ffmpeg process error: ${err.message}`);});
    this.ffmpeg.stderr.on("data",chunk=>{
      const line=chunk.toString().trim();
      if(!line)return;
      if(this.debug)this.logger.log(`[compositor:${this.accountId}] ffmpeg: ${line}`);
      else if(/error|failed|cannot|buffer|queue/i.test(line))this.logger.warn(`[compositor:${this.accountId}] ffmpeg: ${line}`);
    });
    this.ffmpeg.on("exit",(code,signal)=>{
      this.logger.warn(`[compositor:${this.accountId}] ffmpeg exited (code ${code}, signal ${signal})`);
      if(code!==0&&enc.hardware&&!this.forceCpu&&Date.now()-started<8000){
        this.forceCpu=true;
        this.logger.warn(`[compositor:${this.accountId}] ${enc.label} failed quickly - switching compositor to CPU x264`);
      }
      if(this.shouldRun&&this.state!=="stopping")this._scheduleReconnect();
    });
    this.ffmpeg.stdin.on("error",err=>{if(err.code!=="EPIPE")this.logger.warn(`[compositor:${this.accountId}] ffmpeg stdin error: ${err.message}`);});
  }

  _startWatchdog(){
    this._stopWatchdog();
    this.watchdogTimer=setInterval(()=>{
      if(this.state!=="running")return;
      const timeout=Number(process.env.COMPOSITOR_WATCHDOG_MS||15000);
      const activityAt=watchdogActivityAt(this.electronOffscreen,this.lastPaintAt,this.lastFrameAt);
      if(!activityAt){
        if(this.frameCount===0)this.logger.warn(`[compositor:${this.accountId}] watchdog: waiting for first frame`);
        return;
      }
      const idle=Date.now()-activityAt;
      if(idle>timeout){
        const source=this.electronOffscreen?"Electron paint loop":"frame pump";
        this.logger.warn(`[compositor:${this.accountId}] watchdog: ${source} stalled for ${idle}ms, forcing reconnect`);
        this._stopWatchdog();
        this._scheduleReconnect();
      }
    },5000);
  }

  _stopWatchdog(){if(this.watchdogTimer){clearInterval(this.watchdogTimer);this.watchdogTimer=null;}}

  _scheduleReconnect(){
    if(!this.shouldRun||this.restartTimer||this.reconnecting)return;
    const delay=this.reconnectBackoffMs;
    this.reconnectBackoffMs=Math.min(this.reconnectBackoffMs*2,30000);
    this._setState("reconnecting");
    this.restartTimer=setTimeout(async()=>{
      this.restartTimer=null;
      this.reconnecting=true;
      try{
        await this._teardown();
        if(!this.shouldRun){this.reconnecting=false;return;}
        await this._runOnce();
        this.reconnectBackoffMs=1000;
        this._setState("running");
      }catch(err){
        this.logger.error(`[compositor:${this.accountId}] reconnect failed: ${err.message}`);
        this.error=err.message;
        this.reconnecting=false;
        this._scheduleReconnect();
        return;
      }
      this.reconnecting=false;
    },delay);
  }

  async _teardown(){
    this._stopWatchdog();
    this._stopFramePump();
    this._stopMusicPoll();
    this._stopLiveAudioTap();
    if(this.musicAudioTap){
      const c=this.musicAudioTap;
      this.musicAudioTap=null;
      c.removeAllListeners("exit");
      try{c.kill("SIGTERM");}catch{}
    }
    if(this.musicAudioFifoFd!=null){try{fs.closeSync(this.musicAudioFifoFd);}catch{}this.musicAudioFifoFd=null;}
    this.currentMusicTrackId=null;
    const work=(async()=>{
      if(this.client){try{await this.client.send("Page.stopScreencast");}catch{}try{await this.client.detach();}catch{}this.client=null;}
      if(this.ffmpeg){
        const proc=this.ffmpeg;
        this.ffmpeg=null;
        try{proc.stdin.end();}catch{}
        await new Promise(resolve=>{
          const t=setTimeout(()=>{try{proc.kill("SIGKILL");}catch{}},3000);
          proc.once("exit",()=>{clearTimeout(t);resolve();});
          try{proc.kill("SIGTERM");}catch{resolve();}
        });
      }
      if(this.page){try{await this.page.close({runBeforeUnload:false});}catch{}this.page=null;}
      if(this.browser){const proc=this.browser.process?.();try{await this.browser.close();}catch{}try{proc?.kill?.("SIGKILL");}catch{}this.browser=null;}
      if(this.offscreenWindow){const win=this.offscreenWindow;this.offscreenWindow=null;try{win.destroy();}catch{}}
      this._cleanupBrowserProfile();
    })();
    let timedOut=false;
    await Promise.race([work,new Promise(resolve=>setTimeout(()=>{timedOut=true;resolve();},10000))]);
    if(timedOut){
      this.logger.warn(`[compositor:${this.accountId}] teardown exceeded deadline, force-killing`);
      try{this.ffmpeg?.kill?.("SIGKILL");}catch{}
      this.ffmpeg=null;
      try{this.browser?.process?.()?.kill?.("SIGKILL");}catch{}
      this.browser=null;
      this._cleanupBrowserProfile();
    }
    this._stopAudioRelays();
  }

  _cleanupBrowserProfile(){
    const dir=this.browserProfileDir;
    this.browserProfileDir=null;
    if(!dir)return;
    try{fs.rmSync(dir,{recursive:true,force:true});}catch{}
  }
}

module.exports={Compositor,defaultVideoConfig,buildChromiumGpuArgs,audioTransportFor,useElectronOffscreen,watchdogActivityAt,audioInputPlan,compositorFilterGraph,videoInputArgs,electronOffscreenWindowOptions};
