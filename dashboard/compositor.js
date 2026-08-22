"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const puppeteer = require("puppeteer-core");
const { CPU_PROFILE, detectEncoder, globalEncoderArgs, encoderFilterSuffix, videoEncoderArgs } = require("./gpu-encoder");
const { cpuX264Preset, liveMuxArgs } = require("./rtmp-pipeline");
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

function audioTransportFor(accountId, runtimeDir, platform = process.platform) {
  if (platform !== "win32") return {
    live:{ input:path.join(runtimeDir,"live-audio.fifo"), output:path.join(runtimeDir,"live-audio.fifo") },
    music:{ input:path.join(runtimeDir,"music-audio.fifo"), output:path.join(runtimeDir,"music-audio.fifo") },
    fifo:true,
  };
  let hash=2166136261;
  for(const char of String(accountId||"castnexus")){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}
  const base=30000+((hash>>>0)%14000)*2;
  const endpoint=port=>({input:`udp://127.0.0.1:${port}?fifo_size=262144&overrun_nonfatal=1`,output:`udp://127.0.0.1:${port}?pkt_size=3840`});
  return { live:endpoint(base), music:endpoint(base+1), fifo:false };
}

function buildChromiumGpuArgs(gpuEnabled) {
  // CPU-only hosts still need Chromium's software rasterizer in order to
  // produce compositor frames. Disabling both GPU and software rasterization
  // can leave Page.startScreencast() alive but with no frames at all, which in
  // turn leaves FFmpeg waiting forever and Music 24/7 stuck at Idle.
  // "--use-gl=swiftshader" is a legacy GL selector that current Chromium no
  // longer recognizes and silently falls back to "--use-gl=disabled" (no
  // rendering at all). The ANGLE-routed selector below is what still works.
  if (!gpuEnabled) return ["--disable-gpu", "--enable-software-rasterization", "--use-gl=angle", "--use-angle=swiftshader"];
  return ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy", "--use-gl=egl", "--disable-frame-rate-limit"];
}

function defaultVideoConfig() {
  const detected = detectEncoder();
  const mode = String(process.env.COMPOSITOR_GPU || "auto").toLowerCase();
  return {
    width:Number(process.env.COMPOSITOR_WIDTH || 1280),
    height:Number(process.env.COMPOSITOR_HEIGHT || 720),
    fps:Number(process.env.COMPOSITOR_FPS || 30),
    gpuEnabled:mode === "true" || (mode === "auto" && detected.hardware),
    screencastQuality:Number(process.env.COMPOSITOR_JPEG_QUALITY || 80),
  };
}

class Compositor extends EventEmitter {
  constructor({ accountId, pageUrl, audioSourceUrl, outputUrl, getMusicNow, musicFilePathFor, video, runtimeDir, logger }) {
    super();
    this.accountId=accountId;
    this.pageUrl=pageUrl;
    this.audioSourceUrl=audioSourceUrl;
    this.outputUrl=outputUrl;
    this.getMusicNow=getMusicNow;
    this.musicFilePathFor=musicFilePathFor;
    this.video={...defaultVideoConfig(),...(video||{})};
    this.runtimeDir=runtimeDir||path.join(os.tmpdir(),"restreamnode-compositor",accountId);
    this.audioTransport=audioTransportFor(accountId,this.runtimeDir);
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
    this.latestFrame=null;
    this.framePumpTimer=null;
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
    this._startLiveAudioTap();
    await this._startMusicAudioTap();
    await this._launchBrowser();
    await this._openScene();
    this._spawnFfmpeg();
    await this._startScreencast();
    this._startWatchdog();
    this._startMusicPoll();
    const enc=this.forceCpu?CPU_PROFILE:this.encoder;
    this.logger.log(`[compositor:${this.accountId}] running (${this.video.width}x${this.video.height}@${this.video.fps}, encoder=${enc.label}, chromiumGpu=${this.video.gpuEnabled})`);
  }

  async _launchBrowser(){
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
    this.page=await this.browser.newPage();
    await this.page.setViewport({width:this.video.width,height:this.video.height,deviceScaleFactor:1});
    await this.page.goto(this.pageUrl,{waitUntil:"domcontentloaded",timeout:30000});
    if(this.debug)this.logger.log(`[compositor:${this.accountId}] scene loaded ${this.pageUrl}`);
  }

  async _startScreencast(){
    this._stopFramePump();
    this.latestFrame=null;
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
    this.latestFrame=null;
  }

  _fifoPath(name){return path.join(this.runtimeDir,`${name}.fifo`);}

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
    try{
      this.musicAudioFifoFd=fs.openSync(fifo,fs.constants.O_RDWR|fs.constants.O_NONBLOCK);
    }catch(err){
      this.logger.warn(`[compositor:${this.accountId}] could not keep-alive music fifo: ${err.message}`);
      this.musicAudioFifoFd=null;
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
    const lowPower=!enc.hardware&&(process.arch==="arm64"||process.arch==="arm");
    const bitrate=process.env.COMPOSITOR_VIDEO_BITRATE||(this.video.width<=1280&&this.video.height<=1280?"4000k":"6000k");
    const maxrate=process.env.COMPOSITOR_VIDEO_MAXRATE||bitrate;
    const bufsize=process.env.COMPOSITOR_VIDEO_BUFSIZE||(this.video.width<=1280&&this.video.height<=1280?"8000k":"12000k");
    const filter=["[0:v]setsar=1[vbase]",encoderFilterSuffix(enc,"vbase","v"),"[1:a][2:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,aresample=async=1:first_pts=0[a]"].join(";");
    const args=["-hide_banner","-loglevel",this.debug?"info":"warning","-nostats",...globalEncoderArgs(enc),"-thread_queue_size","1024","-framerate",String(this.video.fps),"-use_wallclock_as_timestamps","1","-f","image2pipe","-vcodec","mjpeg","-i","-","-thread_queue_size","1024","-f","s16le","-ar","48000","-ac","2","-i",live,"-thread_queue_size","1024","-f","s16le","-ar","48000","-ac","2","-i",music,"-filter_complex",filter,"-map","[v]","-map","[a]","-r",String(this.video.fps),"-fps_mode","cfr",...videoEncoderArgs(enc,{fps:this.video.fps,bitrate,maxrate,bufsize,x264Preset:process.env.COMPOSITOR_X264_PRESET||cpuX264Preset({hardwareEncoder:enc.hardware,explicit:lowPower?"ultrafast":null})}),"-c:a","aac","-b:a",process.env.COMPOSITOR_AUDIO_BITRATE||"128k","-ar","48000","-ac","2",...liveMuxArgs(this.outputUrl,"flv"),this.outputUrl];
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
      if(!this.lastFrameAt){
        if(this.frameCount===0)this.logger.warn(`[compositor:${this.accountId}] watchdog: waiting for first frame`);
        return;
      }
      const idle=Date.now()-this.lastFrameAt;
      if(idle>timeout){
        this.logger.warn(`[compositor:${this.accountId}] watchdog: frame pump stalled for ${idle}ms, forcing reconnect`);
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
  }

  _cleanupBrowserProfile(){
    const dir=this.browserProfileDir;
    this.browserProfileDir=null;
    if(!dir)return;
    try{fs.rmSync(dir,{recursive:true,force:true});}catch{}
  }
}

module.exports={Compositor,defaultVideoConfig,buildChromiumGpuArgs,audioTransportFor};
