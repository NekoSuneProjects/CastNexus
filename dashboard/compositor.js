"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const puppeteer = require("puppeteer-core");
const { CPU_PROFILE, detectEncoder, resolveEncoder, nextWorkingEncoder, normalisePreference, globalEncoderArgs, encoderFilterSuffix, videoEncoderArgs } = require("./gpu-encoder");
const { cpuX264Preset, liveMuxArgs } = require("./rtmp-pipeline");
const { PcmAudioRelay } = require("./audio-relay");
const { BrowserAudioCapture, layerVolumeScript } = require("./browser-audio");
const monitor = require("./resource-monitor");
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

// Both Desktop and Docker now carry PCM over the independently paced relay.
// FFmpeg treats audio as the timing master, so the producer must never stall
// (video delivery stalls with it) and must never build a backlog (the backlog
// becomes A/V drift). A named pipe gave Docker neither guarantee: whatever the
// previous song's decoder had already written stayed buffered in the pipe and
// played on into the next track. Set COMPOSITOR_AUDIO_FIFO=true to fall back
// to the old Linux named pipes.
function audioTransportFor(accountId, runtimeDir, platform = process.platform, options = {}) {
  const forceFifo=String(options.forceFifo??process.env.COMPOSITOR_AUDIO_FIFO??"").toLowerCase()==="true";
  if (platform !== "win32" && forceFifo) return {
    live:{ input:path.join(runtimeDir,"live-audio.fifo"), output:path.join(runtimeDir,"live-audio.fifo") },
    music:{ input:path.join(runtimeDir,"music-audio.fifo"), output:path.join(runtimeDir,"music-audio.fifo") },
    browser:{ input:path.join(runtimeDir,"browser-audio.fifo"), output:path.join(runtimeDir,"browser-audio.fifo") },
    fifo:true,
  };
  let hash=2166136261;
  for(const char of String(accountId||"castnexus")){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}
  // Six ports per compositor: live, music and browser-source audio buses.
  const base=30000+((hash>>>0)%5000)*6;
  const endpoint=(inputPort,outputPort)=>({input:`tcp://127.0.0.1:${outputPort}`,output:`tcp://127.0.0.1:${inputPort}`,inputPort,outputPort});
  return { live:endpoint(base,base+1), music:endpoint(base+2,base+3), browser:endpoint(base+4,base+5), fifo:false, paced:true };
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

// Browser sources are untrusted web content. Private/Local Network Access
// protections stop a public overlay page from calling loopback services on
// the host (MediaMTX API :9997, the dashboard itself, other containers on the
// host network) while CastNexus' own local scene page keeps working.
function chromiumSecurityArgs({ blockLocalNetwork = String(process.env.CASTNEXUS_BROWSER_BLOCK_LOCAL_NETWORK ?? "true").toLowerCase() !== "false" } = {}) {
  const enable = blockLocalNetwork ? ["BlockInsecurePrivateNetworkRequests", "PrivateNetworkAccessSendPreflights", "PrivateNetworkAccessRespectPreflightResults", "LocalNetworkAccessChecks"] : [];
  return [
    ...(enable.length ? [`--enable-features=${enable.join(",")}`] : []),
    "--disable-features=Translate,BackForwardCache,PaintHolding",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--deny-permission-prompts",
  ];
}

function chromiumLaunchArgs({ width, height, gpuEnabled, browserAudio = false }) {
  return [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    ...buildChromiumGpuArgs(gpuEnabled),
    "--no-zygote", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    // Autoplay without a user gesture is what lets StreamElements alerts and
    // browser music play. It is a playback policy, not a privilege grant.
    "--autoplay-policy=no-user-gesture-required",
    "--hide-scrollbars",
    ...(browserAudio ? [] : ["--mute-audio"]),
    ...chromiumSecurityArgs(),
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-notifications", "--disable-sync", "--metrics-recording-only", "--no-pings",
    `--window-size=${width},${height}`,
  ];
}

function useElectronOffscreen(installType = process.env.CASTNEXUS_INSTALL_TYPE, versions = process.versions) {
  return String(installType || "").toLowerCase() === "electron" && !!versions?.electron;
}

function watchdogActivityAt(electronOffscreen, lastPaintAt, lastFrameAt) {
  return electronOffscreen ? lastPaintAt : lastFrameAt;
}

// PCM inputs are headerless s16le: there is nothing to probe, so skip the
// default 5 s analysis (it delayed first audio and let video frames pile up).
function pcmInputArgs(input) {
  return ["-thread_queue_size","1024","-analyzeduration","0","-probesize","32","-f","s16le","-ar","48000","-ac","2","-i",input];
}

function audioInputPlan(includeLiveAudio, live, music, browser = null, firstIndex = 1) {
  const inputs=[...(includeLiveAudio?[live]:[]),music,...(browser?[browser]:[])];
  const args=inputs.flatMap(pcmInputArgs);
  if(inputs.length===1)return { args, filter:`[${firstIndex}:a]aresample=async=1:first_pts=0[a]`, inputs:inputs.length };
  const labels=inputs.map((_,i)=>`[${i+firstIndex}:a]`).join("");
  return {
    args,
    filter:`${labels}amix=inputs=${inputs.length}:duration=first:dropout_transition=0:normalize=0,aresample=async=1:first_pts=0[a]`,
    inputs:inputs.length,
  };
}

// Hybrid audio: the source's own audio track (input 0) is used directly, so it
// shares one timeline with the gameplay video decoded from the same input and
// cannot drift. A separate tap process + relay starts on its own clock, which
// left voice/game audio out of sync with the picture. Music / browser audio
// (inputs 2..) are mixed on top.
// Input 0 keeps its own timestamps (FFmpeg already shifts every stream of an
// input by the same start offset). Resetting video and audio to zero
// separately misaligned them by the gap between the first audio packet and
// the first video keyframe.
function hybridAudioPlan(music, browser = null, liveGain = 1) {
  const inputs=[music,...(browser?[browser]:[])];
  const gain=Math.max(0,Math.min(4,Number(liveGain)));
  const live=`[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${Number.isFinite(gain)?gain.toFixed(3):"1.000"}[alive]`;
  const labels=inputs.map((_,i)=>`[${i+2}:a]`).join("");
  return {
    args:inputs.flatMap(pcmInputArgs),
    filter:`${live};[alive]${labels}amix=inputs=${inputs.length+1}:duration=first:dropout_transition=0:normalize=0,aresample=async=1[a]`,
    inputs:inputs.length+1,
    inline:true,
  };
}

// ---------------------------------------------------------------------------
// Hybrid program pipeline (gameplay + overlays).
//
// Rendering the OBS/console video inside Chromium (WebRTC decode, 30 fps
// software compositing, JPEG per frame) cost ~2.4 cores at 720p30 on a
// CPU-only VPS and still fell to a few fps. In hybrid mode FFmpeg decodes the
// source once and places it into the Gameplay layer's box (same fit / fill /
// crop / scale / offset as Overlay Studio), while Chromium renders ONLY the
// overlay layers on a transparent page, captured as PNG with alpha and only
// when something changes. FFmpeg overlays the two and encodes once.
// Source URLs may be given as a function so a long-lived program follows the
// current ingest path (profile switches) each time FFmpeg (re)starts.
function resolveUrl(value) { return typeof value === "function" ? value() : value; }

function hybridEnabled(value = process.env.COMPOSITOR_HYBRID) {
  return String(value ?? "auto").toLowerCase() !== "false";
}

function overlayFps(outputFps, value = process.env.COMPOSITOR_OVERLAY_FPS) {
  const n = Math.round(Number(value) || 15);
  return Math.max(1, Math.min(Number(outputFps) || 30, n));
}

function evenInt(n) { const v = Math.round(Number(n) || 0); return v - (v % 2); }

// plan = { box:{x,y,w,h} in output pixels, program:{fit,scale,offsetX,offsetY,crop} }
function hybridVideoGraph({ plan, width, height, fps }) {
  const W = evenInt(width), H = evenInt(height);
  const box = plan?.box || { x:0, y:0, w:W, h:H };
  const BW = Math.max(2, evenInt(box.w)), BH = Math.max(2, evenInt(box.h));
  const p = plan?.program || {}, c = p.crop || {};
  const l = +c.left || 0, r = +c.right || 0, t = +c.top || 0, b = +c.bottom || 0;
  const cw = Math.max(0.05, 1 - l - r), ch = Math.max(0.05, 1 - t - b);
  const k = Math.max(0.1, Number(p.scale) || 1);
  const crop = `crop=w='trunc(iw*${cw.toFixed(4)}/2)*2':h='trunc(ih*${ch.toFixed(4)}/2)*2':x='iw*${l.toFixed(4)}':y='ih*${t.toFixed(4)}'`;
  let scale;
  if (p.fit === "stretch") scale = `scale=w=${evenInt(BW * k)}:h=${evenInt(BH * k)}`;
  else {
    const pick = p.fit === "fit" ? "min" : "max";
    scale = `scale=w='trunc(${pick}(${BW}/iw,${BH}/ih)*iw*${k.toFixed(4)}/2)*2':h='trunc(${pick}(${BW}/iw,${BH}/ih)*ih*${k.toFixed(4)}/2)*2'`;
  }
  const ox = (Number(p.offsetX) || 0).toFixed(4), oy = (Number(p.offsetY) || 0).toFixed(4);
  return [
    `[0:v]fps=${fps},${crop},${scale}[hfg]`,
    `color=c=black:s=${BW}x${BH}:r=${fps}[hboxbg]`,
    `[hboxbg][hfg]overlay=x='(main_w-overlay_w)/2+${ox}*main_w':y='(main_h-overlay_h)/2+${oy}*main_h':eof_action=repeat:shortest=0[hbox]`,
    `color=c=black:s=${W}x${H}:r=${fps}[hcanvas]`,
    `[hcanvas][hbox]overlay=x=${Math.round(box.x)}:y=${Math.round(box.y)}:eof_action=repeat[hbase]`,
    `[1:v]setpts=PTS-STARTPTS[hov]`,
    `[hbase][hov]overlay=0:0:alpha=premultiplied:eof_action=repeat,fps=${fps},setsar=1[vbase]`,
  ].join(";");
}

function hybridPlanSignature(plan) {
  if (!plan) return "none";
  const b = plan.box || {};
  return JSON.stringify({ x:Math.round(b.x), y:Math.round(b.y), w:Math.round(b.w), h:Math.round(b.h), p:plan.program || null });
}

function compositorFilterGraph({ fps, encoder, audioPlan }) {
  // fps= is the OUTPUT rate. When the browser is captured at a lower render
  // rate, this filter repeats frames; repeated frames encode as near-free
  // P-skips, so viewers still get a steady 30 fps stream.
  return [`[0:v]fps=${fps},setsar=1[vbase]`,encoderFilterSuffix(encoder,"vbase","v"),audioPlan.filter].join(";");
}

// How the Chromium/CDP frame pump timestamps video.
//
// "cfr" (default): frames carry constant-rate timestamps (frame n = n/fps) and
// the pump itself is locked to the wall clock, repeating the latest frame to
// pay back any frames it owes. Benchmarks with FFmpeg 7/8's threaded
// scheduler showed that wallclock-stamped video next to a realtime-paced PCM
// input is permanently "ahead" of the audio by the input start-up delay, so
// the video demuxer is choked and only 5-6 of 20 fps got through (the rest
// were dropped by the pump). With CFR the two timelines start together.
//
// "wallclock": the previous behaviour, kept as an escape hatch.
// "auto" (default) picks by FFmpeg version: CFR is required on FFmpeg 7+ (the
// threaded scheduler), but FFmpeg 5.1/6 (Debian's, used by the Docker image)
// throttled CFR input to ~1-5 fps next to the realtime audio on a live VPS,
// while wallclock ran at a clean 30 fps there.
let ffmpegMajorCache;
function ffmpegMajorVersion(){
  if(ffmpegMajorCache!==undefined)return ffmpegMajorCache;
  try{
    const r=spawnSync(FFMPEG_BIN,["-hide_banner","-version"],{encoding:"utf8",timeout:5000});
    const m=/ffmpeg version\s+n?(\d+)\./i.exec(String(r.stdout||""));
    // Git snapshot builds ("N-12345-g..." / "2025-12-31-git-...") are current: treat as new.
    ffmpegMajorCache=m?Number(m[1]):(/ffmpeg version\s+(N-|\d{4}-\d{2}-\d{2}-git)/i.test(String(r.stdout||""))?99:null);
  }catch{ffmpegMajorCache=null;}
  return ffmpegMajorCache;
}

function pumpTimestampMode(value=process.env.COMPOSITOR_PUMP_TIMESTAMPS,major=null){
  const v=String(value||"auto").toLowerCase();
  if(v==="wallclock"||v==="cfr")return v;
  const version=major??ffmpegMajorVersion();
  return version!=null&&version<7?"wallclock":"cfr";
}

function videoInputArgs({electronOffscreen,fps,width,height,inputFps=null,timestamps=pumpTimestampMode(),format="mjpeg"}){
  const rate=String(Math.max(1,Number(inputFps||fps)||30));
  // Hybrid overlay layer: transparent PNG frames (alpha channel kept).
  if(!electronOffscreen&&format==="png")return ["-thread_queue_size","1024","-analyzeduration","0","-probesize",String(Math.max(2_000_000,width*height*4)),"-framerate",rate,...(timestamps==="wallclock"?["-use_wallclock_as_timestamps","1"]:[]),"-f","image2pipe","-vcodec","png","-i","-"];
  if(electronOffscreen)return ["-thread_queue_size","1024","-framerate",rate,"-use_wallclock_as_timestamps","1","-f","rawvideo","-pixel_format","bgra","-video_size",`${width}x${height}`,"-i","-"];
  // Bounded probing: one JPEG is enough to learn the frame size. The default
  // (5 s of stream) kept FFmpeg from reading stdin for several seconds on
  // start/restart while the pump dropped every frame.
  const clock=timestamps==="wallclock"?["-use_wallclock_as_timestamps","1"]:[];
  return ["-thread_queue_size","1024","-analyzeduration","0","-probesize",String(Math.max(2_000_000,width*height*2)),"-framerate",rate,...clock,"-f","image2pipe","-vcodec","mjpeg","-i","-"];
}

// CFR pump backlog: FFmpeg legitimately stops reading stdin for a second or
// two while its encoder and audio inputs start. Absorb about two seconds of
// frames instead of dropping them (a drop in CFR mode is A/V drift).
function cfrBacklogLimit(frameBytes, fps) {
  const bytes=(Number(frameBytes)||0)*Math.max(4,Math.round((Number(fps)||30)*2));
  return Math.max(4*1024*1024,Math.min(64*1024*1024,bytes));
}

// Frames the CFR pump still owes FFmpeg to stay locked to the wall clock.
function framesOwed(startedAt, written, intervalMs, now) {
  return Math.max(0,Math.floor((now-startedAt)/intervalMs)+1-written);
}

// Docker's Chromium path pumps the most recent screencast frame at the input
// cadence (CDP only emits on visual change). Two things decide whether that
// pump is actually realtime:
//
//   * the backlog cap. It used to be a flat 256 KB, but a single 1080p
//     screencast JPEG can exceed that on its own, so the pump dropped almost
//     every frame the moment the encoder blinked. Allow a few frames' worth,
//     matching what the Electron paint path allows for raw BGRA.
//   * the schedule. setInterval drifts and coalesces under Chromium + FFmpeg
//     load, which made complete Docker scenes render slower than realtime even
//     though no frame was missing. Anchor every tick on the wall clock instead.
function framePumpBacklogLimit(frameBytes, maxFrames = 4) {
  const bytes=(Number(frameBytes)||0)*maxFrames;
  return Math.max(512*1024,Math.min(32*1024*1024,bytes));
}

function nextFrameDelay(startedAt, frameIndex, intervalMs, now) {
  return Math.max(0,Math.round(startedAt+frameIndex*intervalMs-now));
}

// If the pump has fallen far behind, resynchronise the schedule rather than
// bursting the missed frames: the input uses wallclock timestamps, so a burst
// would only convert lateness into permanent latency.
function resyncFrameIndex(startedAt, frameIndex, intervalMs, now, maxLagFrames = 4) {
  const elapsed=(now-startedAt)/intervalMs;
  return elapsed-frameIndex>maxLagFrames?Math.floor(elapsed):frameIndex;
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

function chromiumGpuVerdict(hardwareEncoder) {
  try {
    const host = require("./hardware-profile").getHostProfile();
    return host?.probed ? !!host.chromiumGpu : !!hardwareEncoder;
  } catch {
    return !!hardwareEncoder;
  }
}

function defaultVideoConfig() {
  const detected = detectEncoder();
  const mode = String(process.env.COMPOSITOR_GPU || "auto").toLowerCase();
  const renderFps = Number(process.env.COMPOSITOR_RENDER_FPS || 0);
  return {
    width:Number(process.env.COMPOSITOR_WIDTH || 1280),
    height:Number(process.env.COMPOSITOR_HEIGHT || 720),
    fps:Number(process.env.COMPOSITOR_FPS || 30),
    // Browser capture rate fed to FFmpeg. null = same as fps.
    renderFps:renderFps > 0 ? renderFps : null,
    // auto: use the hardware test's verdict on whether headless Chromium
    // really gets a GPU (not SwiftShader); before a test, the old rule.
    gpuEnabled:mode === "true" || (mode === "auto" && chromiumGpuVerdict(detected.hardware)),
    // JPEG is an intermediate transport into FFmpeg, not the final stream
    // quality. 70 materially reduces main-process encode work at 1080p while
    // the final NVENC/x264 bitrate remains unchanged.
    screencastQuality:Number(process.env.COMPOSITOR_JPEG_QUALITY || 70),
  };
}

function clampGain(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : fallback;
}

// Resolve mute/solo into the effective gain for each mixer bus.
function effectiveMixerGains(mixer = {}) {
  const buses = ["program", "music", "browser"];
  const soloed = buses.filter(bus => mixer[bus]?.solo);
  const out = {};
  for (const bus of buses) {
    const row = mixer[bus] && typeof mixer[bus] === "object" ? mixer[bus] : { volume:mixer[bus] };
    const volume = clampGain(row.volume ?? 1);
    const audible = !row.muted && (!soloed.length || soloed.includes(bus));
    out[bus] = audible ? volume : 0;
  }
  return out;
}

class Compositor extends EventEmitter {
  constructor({ accountId, pageUrl, audioSourceUrl, outputUrl, getMusicNow, musicFilePathFor, video, runtimeDir, logger, includeLiveAudio = true, encoderPreference = "auto", browserAudio = false, mixer = null, diagnostics = null, hybrid = null }) {
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
    this.relayByBus={};
    if(!this.audioTransport.fifo){
      for(const name of ["live-audio.fifo","music-audio.fifo","browser-audio.fifo"]){try{fs.rmSync(path.join(this.runtimeDir,name),{force:true});}catch{}}
    }
    this.logger=logger||console;
    this.debug=String(process.env.COMPOSITOR_DEBUG||"").toLowerCase()==="true";
    this.encoderPreference=normalisePreference(encoderPreference);
    this.encoder=resolveEncoder(this.encoderPreference);
    this.failedEncoders=[];
    this.forceCpu=false;
    this.browserAudioWanted=!!browserAudio;
    this.browserAudio=null;
    this.mixer=effectiveMixerGains(mixer||{});
    this.diagnostics=diagnostics||{ group:"compositor", label:String(accountId) };
    // Hybrid: { sourceUrl, getPlan:()=>plan|null, inputArgs?:[] } - FFmpeg decodes
    // the gameplay itself; Chromium only renders the transparent overlay layer.
    this.hybrid=hybrid&&hybrid.sourceUrl&&hybridEnabled()?hybrid:null;
    this.hybridPlan=null;
    this.unregisterDiagnostics=[];
    this.state="idle";
    this.shouldRun=false;
    this.error=null;
    this.frameCount=0;
    this.framesDropped=0;
    this.renderFrames=0;
    this.encodedFrames=null;
    this.rateWindow={ at:Date.now(), renderFrames:0, frameCount:0, encodedFrames:null, renderFps:null, encodeFps:null };
    this.lastFrameAt=null;
    this.lastPaintAt=null;
    this.latestFrame=null;
    this.lastScreencastAt=null;
    this.framePumpTimer=null;
    this.framePumpRunning=false;
    this.paintKeepaliveTimer=null;
    this.layerVolumeTimer=null;
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

  activeEncoder(){return this.forceCpu?CPU_PROFILE:this.encoder;}
  isHybrid(){return !!this.hybrid&&!this.electronOffscreen;}
  inputFps(){if(this.isHybrid())return overlayFps(this.video.fps);return Math.max(1,Math.min(Number(this.video.fps)||30,Number(this.video.renderFps||this.video.fps)||30));}

  _currentHybridPlan(){
    let plan=null;
    try{plan=this.hybrid.getPlan?.()||null;}catch{plan=null;}
    // A scene without a Gameplay layer keeps the last box (the page covers it).
    return plan||this.hybridPlan||{box:{x:0,y:0,w:this.video.width,h:this.video.height},program:{fit:"fit"}};
  }

  // Called after scene edits/switches: only a change of the Gameplay box or
  // framing needs an FFmpeg restart; overlay content updates live.
  updateHybridPlan(){
    if(!this.isHybrid()||this.state!=="running")return false;
    let next=null;
    try{next=this.hybrid.getPlan?.()||null;}catch{}
    if(!next||hybridPlanSignature(next)===hybridPlanSignature(this.hybridPlan))return false;
    this.logger.log(`[compositor:${this.accountId}] gameplay framing changed; restarting encoder`);
    this._scheduleReconnect(250);
    return true;
  }

  _rates(){
    const now=Date.now(),w=this.rateWindow,elapsed=(now-w.at)/1000;
    if(elapsed>=2){
      w.renderFps=Math.round((this.renderFrames-w.renderFrames)/elapsed*10)/10;
      // Prefer FFmpeg's own output frame counter (-progress): in hybrid mode the
      // overlay pipe only carries frames when the overlay changes.
      const encoded=this.encodedFrames;
      w.encodeFps=encoded!=null&&w.encodedFrames!=null&&encoded>=w.encodedFrames?Math.round((encoded-w.encodedFrames)/elapsed*10)/10:encoded!=null?w.encodeFps:Math.round((this.frameCount-w.frameCount)/elapsed*10)/10;
      w.at=now;w.renderFrames=this.renderFrames;w.frameCount=this.frameCount;w.encodedFrames=encoded;
    }
    return w;
  }

  status(){
    const enc=this.activeEncoder();
    const rates=this._rates();
    return {
      state:this.state,
      error:this.error,
      frameCount:this.frameCount,
      framesDropped:this.framesDropped,
      renderFrames:this.renderFrames,
      lastFrameAt:this.lastFrameAt,
      lastRenderAt:this.electronOffscreen?this.lastPaintAt:this.lastScreencastAt,
      firstFrameReady:!!this.latestFrame,
      encoder:enc.label,
      encoderId:enc.id,
      encoderPreference:this.encoderPreference,
      encoderFallbackReason:enc.fallbackReason||(this.failedEncoders.length?`fell back after ${this.failedEncoders.join(", ")} failed`:null),
      hardwareEncoder:!!enc.hardware,
      width:this.video.width,
      height:this.video.height,
      outputFps:this.video.fps,
      renderFps:this.inputFps(),
      measuredRenderFps:rates.renderFps,
      measuredEncodeFps:rates.encodeFps,
      hybrid:this.isHybrid(),
      encoderLagS:this.encoderLagS??null,
      chromiumGpu:!!this.video.gpuEnabled,
      browserAudio:{ wanted:this.browserAudioWanted, active:!!this.browserAudio?.available, error:this.browserAudio?.error||null },
      mixer:{ ...this.mixer },
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
    this._unregisterDiagnostics();
    this._setState("idle");
  }

  // Swaps the loaded page in place, leaving ffmpeg/audio/RTMP publish
  // running untouched. Used for Program Scene changes so switching scenes
  // does not interrupt the live output.
  async navigate(pageUrl){
    if(this.pageUrl===pageUrl)return;
    this.pageUrl=pageUrl;
    if(this.state!=="running")return;
    try{
      if(this.electronOffscreen){
        if(this.offscreenWindow)await this.offscreenWindow.webContents.loadURL(pageUrl);
      }else if(this.page){
        await this.page.goto(pageUrl,{waitUntil:"domcontentloaded",timeout:30000});
      }
      if(this.debug)this.logger.log(`[compositor:${this.accountId}] navigated to ${pageUrl}`);
    }catch(err){
      this.logger.warn(`[compositor:${this.accountId}] navigate failed: ${err.message}`);
    }
  }

  // Live mixer update from Overlay Studio. Applied in the PCM relays, so it
  // takes effect within one relay tick and never restarts FFmpeg.
  setMixer(mixer){
    const previousLive=this.mixer?.program;
    this.mixer=effectiveMixerGains(mixer||{});
    // Inline source audio has its gain baked into the FFmpeg graph.
    if(this.inlineSourceAudio()&&previousLive!==this.mixer.program&&this.state==="running"){this.logger.log(`[compositor:${this.accountId}] program volume changed; restarting encoder`);this._scheduleReconnect(250);}
    this.relayByBus.live?.setGain(this.mixer.program);
    this.relayByBus.music?.setGain(this.mixer.music);
    this.relayByBus.browser?.setGain(this.mixer.browser);
    return this.mixer;
  }

  // Scenes can gain or lose audio-enabled browser layers while live. Turning
  // capture on requires relaunching Chromium without --mute-audio, so do it
  // through the normal reconnect path (audio bus + page) only when it changes.
  setBrowserAudio(enabled){
    const wanted=!!enabled;
    if(wanted===this.browserAudioWanted)return false;
    this.browserAudioWanted=wanted;
    if(this.state==="running"){this.logger.log(`[compositor:${this.accountId}] browser audio ${wanted?"enabled":"disabled"}; restarting renderer`);this._scheduleReconnect(250);}
    return true;
  }

  inlineSourceAudio(){
    return this.isHybrid()&&this.includeLiveAudio&&!this.sourceAudioMissing;
  }

  _setState(s){if(this.state===s)return;this.state=s;this.emit("status",this.status());}

  async _runOnce(){
    fs.mkdirSync(this.runtimeDir,{recursive:true});
    this._prepareBrowserAudio();
    await this._startAudioRelays();
    if(this.includeLiveAudio&&!this.inlineSourceAudio())this._startLiveAudioTap();
    await this._startMusicAudioTap();
    await this._launchBrowser();
    await this._openScene();
    this._spawnFfmpeg();
    await this._startScreencast();
    this._startWatchdog();
    this._startMusicPoll();
    this._registerDiagnostics();
    const enc=this.activeEncoder();
    const renderer=this.electronOffscreen?"electron-offscreen":"chromium-cdp";
    this.logger.log(`[compositor:${this.accountId}] running (${this.video.width}x${this.video.height}@${this.video.fps}, render=${this.inputFps()}fps, encoder=${enc.label}, renderer=${renderer}, chromiumGpu=${this.video.gpuEnabled}, browserAudio=${!!this.browserAudio?.available})`);
  }

  _prepareBrowserAudio(){
    if(!this.browserAudioWanted||this.electronOffscreen){this.browserAudio=null;return;}
    if(!this.browserAudio)this.browserAudio=new BrowserAudioCapture({id:this.accountId,logger:this.logger,debug:this.debug});
    if(!this.browserAudio.prepare())this.logger.warn(`[compositor:${this.accountId}] browser audio unavailable: ${this.browserAudio.error}`);
  }

  _registerDiagnostics(){
    this._unregisterDiagnostics();
    const base=`${this.diagnostics.group}:${this.accountId}`;
    const label=this.diagnostics.label||this.accountId;
    const group=this.diagnostics.group;
    this.unregisterDiagnostics.push(
      monitor.registerComponent(`${base}:renderer`,{label:`${label} · Chromium renderer`,group,pids:()=>[this.browser?.process?.()?.pid].filter(Boolean),meta:()=>({renderFps:this.inputFps(),measuredRenderFps:this._rates().renderFps,chromiumGpu:!!this.video.gpuEnabled})}),
      monitor.registerComponent(`${base}:encoder`,{label:`${label} · FFmpeg encoder`,group,tree:false,pids:()=>[this.ffmpeg?.pid].filter(Boolean),meta:()=>({encoder:this.activeEncoder().label,outputFps:this.video.fps,measuredEncodeFps:this._rates().encodeFps})}),
      monitor.registerComponent(`${base}:audio`,{label:`${label} · audio taps`,group,tree:false,pids:()=>[this.liveAudioTap?.pid,this.musicAudioTap?.pid,this.browserAudio?.pid()].filter(Boolean)}),
    );
  }

  _unregisterDiagnostics(){for(const off of this.unregisterDiagnostics.splice(0))try{off();}catch{}}

  async _launchBrowser(){
    if(this.electronOffscreen){
      const { BrowserWindow }=require("electron");
      this.offscreenWindow=new BrowserWindow(electronOffscreenWindowOptions(this.video.width,this.video.height));
      this.offscreenWindow.setContentSize(this.video.width,this.video.height);
      // Electron can render at exactly the capture rate - no wasted paints.
      this.offscreenWindow.webContents.setFrameRate(Math.max(1,Math.min(this.inputFps(),60)));
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
    const browserAudio=!!this.browserAudio?.available;
    try{
      this.browser=await puppeteer.launch({
        executablePath:execPath,
        headless:"new",
        userDataDir:this.browserProfileDir,
        defaultViewport:{width:this.video.width,height:this.video.height,deviceScaleFactor:1},
        env:{...process.env,...(this.browserAudio?.chromiumEnv()||{})},
        args:chromiumLaunchArgs({width:this.video.width,height:this.video.height,gpuEnabled:this.video.gpuEnabled,browserAudio}),
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
    if(this.isHybrid()){
      this.client=await this.page.target().createCDPSession();
      await this.client.send("Emulation.setDefaultBackgroundColorOverride",{color:{r:0,g:0,b:0,a:0}});
    }
    if(this.browserAudio?.available)this._watchLayerVolumes();
    await this.page.goto(this.pageUrl,{waitUntil:"domcontentloaded",timeout:30000});
    if(this.debug)this.logger.log(`[compositor:${this.accountId}] scene loaded ${this.pageUrl}`);
  }

  // Browser-layer iframes carry data-cn-volume / data-cn-muted. Apply those
  // inside each frame (including cross-origin OOPIFs, which DevTools can
  // reach) whenever frames appear or navigate, plus a slow safety sweep for
  // SSE-driven layer edits.
  _watchLayerVolumes(){
    const page=this.page;
    const run=()=>{this.applyLayerVolumes().catch(()=>{});};
    page.on("frameattached",()=>setTimeout(run,300));
    page.on("framenavigated",()=>setTimeout(run,300));
    page.on("load",run);
    if(this.layerVolumeTimer)clearInterval(this.layerVolumeTimer);
    this.layerVolumeTimer=setInterval(run,Number(process.env.COMPOSITOR_LAYER_VOLUME_SWEEP_MS||4000));
  }

  async applyLayerVolumes(){
    const page=this.page;
    if(!page||page.isClosed?.())return 0;
    const script=layerVolumeScript();
    let applied=0;
    const visit=async(frame,volume,muted)=>{
      try{await frame.evaluate(script,volume,muted);applied++;}catch{}
      for(const child of frame.childFrames())await visit(child,volume,muted);
    };
    for(const frame of page.mainFrame().childFrames()){
      let volume=1,muted=false;
      try{
        const el=await frame.frameElement();
        if(el){
          const data=await el.evaluate(node=>({volume:node.getAttribute("data-cn-volume"),muted:node.getAttribute("data-cn-muted"),audio:node.getAttribute("data-cn-audio")}));
          await el.dispose?.();
          volume=data.volume==null?1:Number(data.volume);
          muted=data.muted==="1"||data.audio==="0";
        }
      }catch{}
      await visit(frame,volume,muted);
    }
    return applied;
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
        this.renderFrames++;
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
    if(!this.client)this.client=await this.page.target().createCDPSession();
    const cdp=this.client;
    let firstCapture=true;
    this.client.on("Page.screencastFrame",({data,sessionId})=>{
      cdp.send("Page.screencastFrameAck",{sessionId}).catch(()=>{});
      try{
        this.latestFrame=Buffer.from(data,"base64");
        this.lastScreencastAt=Date.now();
        this.renderFrames++;
        if(this.debug&&firstCapture){
          firstCapture=false;
          this.logger.log(`[compositor:${this.accountId}] first Chromium frame (${this.latestFrame.length} bytes)`);
        }
      }catch{}
    });
    // everyNthFrame counts frames Chromium actually produced (damage driven).
    // Pages that animate at the compositor's 60 Hz (full effects) set it so
    // Chromium stops JPEG-encoding frames above the capture rate; pages that
    // already change only at their own low rate must keep every frame.
    const everyNth=Math.max(1,Math.round(Number(this.video.screencastEveryNth)||1));
    await this.client.send("Page.startScreencast",this.isHybrid()?{format:"png",maxWidth:this.video.width,maxHeight:this.video.height,everyNthFrame:everyNth}:{format:"jpeg",quality:this.video.screencastQuality,maxWidth:this.video.width,maxHeight:this.video.height,everyNthFrame:everyNth});

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
    this._stopFramePump({keepFrame:true});
    if(pumpTimestampMode()==="cfr")return this._startCfrFramePump();
    const interval=1000/this.inputFps();
    const startedAt=Date.now();
    let frameIndex=0;
    this.framePumpRunning=true;
    const writeFrame=()=>{
      const ffmpeg=this.ffmpeg;
      const frame=this.latestFrame;
      if(!ffmpeg||!frame)return;
      const stdin=ffmpeg.stdin;
      if(!stdin?.writable)return;
      if(stdin.writableLength>framePumpBacklogLimit(frame.length)){this.framesDropped++;return;}
      try{
        stdin.write(frame);
        this.frameCount++;
        this.lastFrameAt=Date.now();
      }catch(err){
        if(err?.code!=="EPIPE")this.logger.warn(`[compositor:${this.accountId}] frame pump error: ${err.message}`);
      }
    };
    const tick=()=>{
      this.framePumpTimer=null;
      if(!this.framePumpRunning)return;
      writeFrame();
      frameIndex++;
      const now=Date.now();
      frameIndex=resyncFrameIndex(startedAt,frameIndex,interval,now);
      this.framePumpTimer=setTimeout(tick,nextFrameDelay(startedAt,frameIndex,interval,now));
    };
    tick();
  }

  // Wall-clock locked CFR pump: every tick writes as many copies of the
  // latest frame as the clock says are due (normally exactly one). Frames owed
  // after an FFmpeg stall are repaid in small bursts so the video timeline
  // never drifts from the realtime audio. Only if FFmpeg cannot keep up for
  // longer than ~2 s are owed frames forgiven (logged, counted as drops).
  _startCfrFramePump(){
    const fps=this.inputFps();
    const interval=1000/fps;
    const startedAt=Date.now();
    const maxBurst=Math.max(2,Math.ceil(fps/4));
    const maxOwed=Math.max(8,fps*2);
    let written=0;
    let warned=false;
    this.framePumpRunning=true;
    const tick=()=>{
      this.framePumpTimer=null;
      if(!this.framePumpRunning)return;
      const ffmpeg=this.ffmpeg,frame=this.latestFrame,stdin=ffmpeg?.stdin;
      const now=Date.now();
      let owed=framesOwed(startedAt,written,interval,now);
      if(owed>maxOwed){
        const forgiven=owed-maxOwed;
        written+=forgiven;
        this.framesDropped+=forgiven;
        owed=maxOwed;
        if(!warned){warned=true;this.logger.warn(`[compositor:${this.accountId}] frame pump: FFmpeg fell ${Math.round(forgiven/fps*10)/10}s behind; skipping ahead`);}
      }
      // No frame yet or FFmpeg not accepting input: wait half a frame instead of
      // spinning on 0 ms timers while the clock keeps "owing" frames.
      let blocked=!frame||!stdin?.writable;
      if(!blocked){
        const limit=cfrBacklogLimit(frame.length,fps);
        for(let i=0;i<Math.min(owed,maxBurst);i++){
          if(stdin.writableLength>limit){blocked=true;break;}
          try{stdin.write(frame);written++;this.frameCount++;this.lastFrameAt=Date.now();}
          catch(err){if(err?.code!=="EPIPE")this.logger.warn(`[compositor:${this.accountId}] frame pump error: ${err.message}`);blocked=true;break;}
        }
      }
      // Next frame (index `written`) is due at startedAt + written*interval;
      // if FFmpeg is backpressured, look again half a frame later.
      const delay=blocked?interval/2:startedAt+written*interval-Date.now();
      this.framePumpTimer=setTimeout(tick,Math.max(0,Math.round(delay)));
    };
    tick();
  }

  _stopFramePump({keepFrame=false}={}){
    this.framePumpRunning=false;
    if(this.framePumpTimer){clearTimeout(this.framePumpTimer);this.framePumpTimer=null;}
    if(this.paintKeepaliveTimer){clearInterval(this.paintKeepaliveTimer);this.paintKeepaliveTimer=null;}
    if(this.offscreenWindow&&this.electronPaintHandler){
      try{this.offscreenWindow.webContents.removeListener("paint",this.electronPaintHandler);}catch{}
    }
    this.electronPaintHandler=null;
    if(keepFrame)return;
    this.latestFrame=null;
    this.lastPaintAt=null;
    this.lastScreencastAt=null;
  }

  _fifoPath(name){return path.join(this.runtimeDir,`${name}.fifo`);}

  async _startAudioRelays(){
    if(!this.audioTransport.paced||this.audioRelays.length)return;
    const buses=[...(this.inlineSourceAudio()?[]:[["live",this.audioTransport.live,this.mixer.program]]),["music",this.audioTransport.music,this.mixer.music]];
    if(this.browserAudio?.available)buses.push(["browser",this.audioTransport.browser,this.mixer.browser]);
    for(const [bus,endpoint,gain] of buses){
      const relay=new PcmAudioRelay({inputPort:endpoint.inputPort,outputPort:endpoint.outputPort,logger:this.logger,gain});
      relay.start();
      this.audioRelays.push(relay);
      this.relayByBus[bus]=relay;
    }
    // Wait for the loopback listeners before the FFmpeg taps try to connect,
    // but never block startup on them: a relay that cannot listen still lets
    // the taps respawn into it later.
    const deadline=new Promise(resolve=>setTimeout(resolve,Number(process.env.COMPOSITOR_AUDIO_READY_TIMEOUT_MS||3000)));
    await Promise.race([Promise.all(this.audioRelays.map(relay=>relay.ready())),deadline]);
    if(this.browserAudio?.available)this.browserAudio.start(this.audioTransport.browser.output);
  }

  _stopAudioRelays(){
    for(const relay of this.audioRelays){try{relay.stop();}catch{}}
    this.audioRelays=[];
    this.relayByBus={};
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
    const child=spawn(FFMPEG_BIN,["-hide_banner","-loglevel",this.debug?"info":"warning","-nostdin","-y","-analyzeduration","1000000","-probesize","32768","-thread_queue_size","1024","-i",resolveUrl(this.audioSourceUrl),"-vn","-af","aresample=async=1:first_pts=0","-f","s16le","-ar","48000","-ac","2",fifo]);
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

  // Public so the owner can react to music engine events immediately instead
  // of waiting for the next 1 s check.
  syncMusic(){this._syncMusicTap();}

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
    const live=this.audioTransport.live.input,music=this.audioTransport.music.input,enc=this.activeEncoder();
    const browser=this.browserAudio?.available?this.audioTransport.browser.input:null;
    const hybrid=this.isHybrid();
    // Hybrid inputs: 0 = source video (RTMP), 1 = overlay PNG pipe, 2.. = audio.
    const inlineAudio=this.inlineSourceAudio();
    const audioPlan=inlineAudio?hybridAudioPlan(music,browser,this.mixer.program):audioInputPlan(this.includeLiveAudio,live,music,browser,hybrid?2:1);
    if(hybrid)this.hybridPlan=this._currentHybridPlan();
    const lowPower=!enc.hardware&&(process.arch==="arm64"||process.arch==="arm");
    const bitrate=this.video.bitrate||process.env.COMPOSITOR_VIDEO_BITRATE||(this.video.width<=1280&&this.video.height<=1280?"4000k":"6000k");
    const maxrate=this.video.maxrate||process.env.COMPOSITOR_VIDEO_MAXRATE||bitrate;
    const bufsize=this.video.bufsize||process.env.COMPOSITOR_VIDEO_BUFSIZE||(this.video.width<=1280&&this.video.height<=1280?"8000k":"12000k");
    const filter=hybrid
      ? [hybridVideoGraph({plan:this.hybridPlan,width:this.video.width,height:this.video.height,fps:this.video.fps}),encoderFilterSuffix(enc,"vbase","v"),audioPlan.filter].join(";")
      : compositorFilterGraph({fps:this.video.fps,width:this.video.width,height:this.video.height,encoder:enc,audioPlan,musicOnly:!this.includeLiveAudio});
    const sourceArgs=hybrid?[...(this.hybrid.inputArgs||["-thread_queue_size","1024","-fflags","+genpts+discardcorrupt","-analyzeduration","1000000","-probesize","1000000"]),...(inlineAudio?[]:["-an"]),"-i",resolveUrl(this.hybrid.sourceUrl)]:[];
    const args=["-hide_banner","-loglevel",this.debug?"info":"warning","-nostats","-progress","pipe:2","-stats_period","2",...globalEncoderArgs(enc),...sourceArgs,...videoInputArgs({electronOffscreen:this.electronOffscreen,fps:this.video.fps,inputFps:this.inputFps(),width:this.video.width,height:this.video.height,format:hybrid?"png":"mjpeg"}),...audioPlan.args,"-filter_complex",filter,"-map","[v]","-map","[a]","-r",String(this.video.fps),"-fps_mode","cfr",...videoEncoderArgs(enc,{fps:this.video.fps,gop:this.video.fps*(Number(this.video.gopSeconds)||1),bitrate,maxrate,bufsize,x264Preset:this.video.x264Preset||process.env.COMPOSITOR_X264_PRESET||cpuX264Preset({hardwareEncoder:enc.hardware,explicit:lowPower?"ultrafast":null})}),"-c:a","aac","-b:a",this.video.audioBitrate||process.env.COMPOSITOR_AUDIO_BITRATE||"128k","-ar","48000","-ac","2",...liveMuxArgs(this.outputUrl,"flv"),this.outputUrl];
    if(this.debug)this.logger.log(`[compositor:${this.accountId}] ffmpeg command: ffmpeg ${args.join(" ")}`);
    const started=Date.now();
    this.ffmpeg=spawn(FFMPEG_BIN,args,{stdio:["pipe","ignore","pipe"]});
    this.ffmpeg.on("spawn",()=>{if(this.debug)this.logger.log(`[compositor:${this.accountId}] ffmpeg spawned pid=${this.ffmpeg?.pid}`);});
    this.ffmpeg.on("error",err=>{this.logger.warn(`[compositor:${this.accountId}] ffmpeg process error: ${err.message}`);});
    this.encodedFrames=null;
    // Live-latency guard: when the encoder falls behind real time (busy host),
    // input piles up in the queues and that delay never shrinks again. Track
    // wall clock vs FFmpeg's output clock and restart to drop the backlog.
    const maxLag=Number(process.env.COMPOSITOR_MAX_LAG_S??3);
    let lagBase=null;
    this.encoderLagS=null;
    this.ffmpeg.stderr.on("data",chunk=>{
      let text=chunk.toString();
      const outTimes=[...text.matchAll(/^out_time_us=(d+)$/gm)];
      if(outTimes.length&&maxLag>0&&this.ffmpeg===proc){
        const lag=(Date.now()-started)/1000-Number(outTimes.at(-1)[1])/1e6;
        if(lagBase==null||lag<lagBase)lagBase=lag;
        this.encoderLagS=Math.round((lag-lagBase)*10)/10;
        if(this.encoderLagS>maxLag&&this.state==="running"){
          this.logger.warn(`[compositor:${this.accountId}] encoder is ${this.encoderLagS}s behind real time; restarting to drop the backlog`);
          lagBase=Infinity;
          this._scheduleReconnect(250);
        }
      }
      if(inlineAudio&&/matches no streams/i.test(text)&&!this.sourceAudioMissing){
        // Source without an audio track: fall back to the separate tap.
        this.sourceAudioMissing=true;
        this._stopAudioRelays();
        this.logger.warn(`[compositor:${this.accountId}] source has no audio track; using the audio tap`);
      }
      const frames=[...text.matchAll(/^frame=(\d+)$/gm)];
      if(frames.length)this.encodedFrames=Number(frames.at(-1)[1]);
      text=text.replace(/^(frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time_us|out_time_ms|out_time|dup_frames|drop_frames|speed|progress)=.*$/gm,"");
      const line=text.trim();
      if(!line)return;
      if(this.debug)this.logger.log(`[compositor:${this.accountId}] ffmpeg: ${line}`);
      else if(/error|failed|cannot|buffer|queue/i.test(line))this.logger.warn(`[compositor:${this.accountId}] ffmpeg: ${line}`);
    });
    const proc=this.ffmpeg;
    proc.on("exit",(code,signal)=>{
      if(this.ffmpeg!==proc&&this.ffmpeg!==null)return;
      this.logger.warn(`[compositor:${this.accountId}] ffmpeg exited (code ${code}, signal ${signal})`);
      if(code!==0&&enc.hardware&&Date.now()-started<8000)this._fallbackEncoder(enc);
      if(this.shouldRun&&this.state!=="stopping")this._scheduleReconnect();
    });
    this.ffmpeg.stdin.on("error",err=>{if(err.code!=="EPIPE")this.logger.warn(`[compositor:${this.accountId}] ffmpeg stdin error: ${err.message}`);});
  }

  // A hardware encoder that dies within seconds of starting is treated as
  // broken for this compositor: walk the chain (NVENC -> QSV/VAAPI -> x264)
  // and keep broadcasting instead of retrying the same failure forever.
  _fallbackEncoder(failed){
    if(!this.failedEncoders.includes(failed.id))this.failedEncoders.push(failed.id);
    const next=nextWorkingEncoder(this.encoderPreference,this.failedEncoders);
    this.encoder=next;
    this.forceCpu=!next.hardware;
    this.logger.warn(`[compositor:${this.accountId}] ${failed.label} failed quickly - switching compositor to ${next.label}`);
    return next;
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

  _scheduleReconnect(delayOverride=null){
    if(!this.shouldRun||this.restartTimer||this.reconnecting)return;
    const delay=delayOverride??this.reconnectBackoffMs;
    if(delayOverride==null)this.reconnectBackoffMs=Math.min(this.reconnectBackoffMs*2,30000);
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
    if(this.layerVolumeTimer){clearInterval(this.layerVolumeTimer);this.layerVolumeTimer=null;}
    if(this.musicAudioTap){
      const c=this.musicAudioTap;
      this.musicAudioTap=null;
      c.removeAllListeners("exit");
      try{c.kill("SIGTERM");}catch{}
    }
    if(this.musicAudioFifoFd!=null){try{fs.closeSync(this.musicAudioFifoFd);}catch{}this.musicAudioFifoFd=null;}
    this.currentMusicTrackId=null;
    if(this.browserAudio){try{this.browserAudio.stop();}catch{}}
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

module.exports={hybridAudioPlan,hybridEnabled,overlayFps,hybridVideoGraph,hybridPlanSignature,Compositor,defaultVideoConfig,buildChromiumGpuArgs,chromiumSecurityArgs,chromiumLaunchArgs,audioTransportFor,useElectronOffscreen,watchdogActivityAt,audioInputPlan,pcmInputArgs,compositorFilterGraph,videoInputArgs,pumpTimestampMode,framePumpBacklogLimit,cfrBacklogLimit,framesOwed,nextFrameDelay,resyncFrameIndex,electronOffscreenWindowOptions,effectiveMixerGains};
