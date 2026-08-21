"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Compositor } = require("./compositor");
const { detectEncoder } = require("./gpu-encoder");
const { safeCanvas } = require("./rtmp-pipeline");
const { activeProfileFor, profilePublishPath, validRtmpKey } = require("./profile-rtmp");

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "data", "state.json");
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(path.dirname(STATE_FILE), "music");
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8090);
const DASHBOARD_ORIGIN = process.env.DASHBOARD_INTERNAL_ORIGIN || `http://127.0.0.1:${DASHBOARD_PORT}`;
const RTMP_ORIGIN = process.env.MEDIA_RTMP_ORIGIN || "rtmp://127.0.0.1:1935";
const MEDIAMTX_API = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
const POLL_MS = Number(process.env.MUSIC24_POLL_MS || 2000);
const NOW_POLL_MS = Number(process.env.MUSIC24_NOW_POLL_MS || 750);
const START_TIMEOUT_MS = Number(process.env.MUSIC24_START_TIMEOUT_MS || 15000);

const workers = new Map();
const lastStatus = new Map();
let shuttingDown = false;
let serviceStarted = false;
let reconcileTimer = null;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function sanitizeSegment(value) { return String(value || "unknown").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120); }
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; } }
function profileMusicState(account, profile) {
  if (!account || !profile?.id) return null;
  const key = sanitizeSegment(profile.id);
  const bucket = account.musicProfiles?.[key];
  return { profileId:key, tracks:Array.isArray(bucket?.tracks) ? bucket.tracks : [], settings:bucket?.settings || {} };
}
function profileVideo(profile) {
  const vertical = profile?.canvasMode === "vertical";
  const detected = detectEncoder();
  return safeCanvas(vertical ? "vertical" : "landscape", {
    hardwareEncoder:detected.hardware,
    width:Number(process.env.MUSIC24_WIDTH || (vertical ? 1080 : 1920)),
    height:Number(process.env.MUSIC24_HEIGHT || (vertical ? 1920 : 1080)),
    fps:Number(process.env.MUSIC24_FPS || 30),
  });
}
function musicSceneUrl(account, profile) {
  const params = new URLSearchParams();
  const visual = profile?.musicVisual || {};
  for (const key of ["accent","background","station","title","cover"]) if (visual[key]) params.set(key,String(visual[key]));
  params.set("layout", profile?.canvasMode === "vertical" ? "vertical" : "landscape");
  const query = params.toString();
  return `${DASHBOARD_ORIGIN}/overlay/${encodeURIComponent(account.twitchLogin)}/music/${encodeURIComponent(profile.id)}${query ? `?${query}` : ""}`;
}
function musicWorkerSignature(account, profile) {
  return JSON.stringify({login:account.twitchLogin,profileId:profile?.id,rtmpKey:profile?.rtmpKey||null,canvasMode:profile?.canvasMode||"landscape",video:profileVideo(profile),visual:profile?.musicVisual||{}});
}
async function mediaPathReady(pathName) {
  try {
    const response = await fetch(`${MEDIAMTX_API}/v3/paths/list`,{cache:"no-store"});
    if (!response.ok) return false;
    const data = await response.json();
    return (data.items || []).some(item => item.ready && item.name === pathName);
  } catch { return false; }
}
async function waitForMediaPath(pathName, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!shuttingDown && Date.now() < deadline) {
    if (await mediaPathReady(pathName)) return true;
    await sleep(250);
  }
  return false;
}
function spawnSilenceFeed(accountId, profileId) {
  const streamName = `music-silence/${sanitizeSegment(accountId)}-${sanitizeSegment(profileId)}`;
  const outputUrl = `${RTMP_ORIGIN}/${streamName}`;
  const args = ["-hide_banner","-loglevel","warning","-nostats","-re","-f","lavfi","-i","color=c=black:s=16x16:r=1","-f","lavfi","-i","anullsrc=r=44100:cl=stereo","-map","0:v:0","-map","1:a:0","-c:v","libx264","-preset","ultrafast","-tune","zerolatency","-pix_fmt","yuv420p","-g","2","-b:v","32k","-c:a","aac","-b:a","128k","-ar","44100","-ac","2","-f","flv","-flvflags","no_duration_filesize","-rtmp_live","live",outputUrl];
  const child = spawn("ffmpeg",args,{stdio:["ignore","ignore","pipe"]});
  child.stderr.on("data",chunk=>{const line=chunk.toString().trim();if(line&&/error|failed|cannot/i.test(line))console.warn(`[music24:${accountId}:${profileId}] silence ffmpeg: ${line}`);});
  return {child,outputUrl,streamName};
}

class Music24Worker {
  constructor(account, profile) {
    this.accountId=account.twitchUserId;this.account=account;this.profile=profile;this.signature=musicWorkerSignature(account,profile);
    this.silence=null;this.compositor=null;this.now=null;this.nowFetchedAt=0;this.nowTimer=null;this.running=false;this.stopping=false;this.outputPath=null;this.phase="idle";this.error=null;
  }
  update(account,profile){this.account=account;this.profile=profile;}
  getNow(){if(!this.now)return null;const now={...this.now};if(now.mode==="playing"&&now.track)now.positionS=Math.max(0,Number(now.positionS||0)+(Date.now()-this.nowFetchedAt)/1000);return now;}
  musicFilePathFor(trackId){const state=profileMusicState(this.account,this.profile);const track=state?.tracks.find(t=>t.id===trackId);return track?path.join(MUSIC_DIR,sanitizeSegment(this.accountId),state.profileId,track.filename):null;}
  async pollNow(){try{const url=`${DASHBOARD_ORIGIN}/overlay/${encodeURIComponent(this.account.twitchLogin)}/music/${encodeURIComponent(this.profile.id)}/now.json`;const res=await fetch(url,{cache:"no-store"});if(res.ok){this.now=await res.json();this.nowFetchedAt=Date.now();}}catch{}}
  startNowPoll(){this.stopNowPoll();this.pollNow();this.nowTimer=setInterval(()=>this.pollNow(),NOW_POLL_MS);}
  stopNowPoll(){if(this.nowTimer){clearInterval(this.nowTimer);this.nowTimer=null;}}
  async start(){
    if(this.running||this.stopping)return;
    const outputPath=profilePublishPath(this.profile);if(!outputPath)throw new Error("active Music profile has no valid RTMP key yet");
    this.running=true;this.phase="starting";this.error=null;this.outputPath=outputPath;lastStatus.set(this.accountId,{state:"starting",profileId:this.profile.id,outputPath,error:null});this.startNowPoll();
    const startSilence=()=>{if(!this.running||this.stopping)return;const feed=spawnSilenceFeed(this.accountId,this.profile.id);this.silence=feed;feed.child.once("exit",code=>{if(this.silence?.child===feed.child)this.silence=null;if(this.running&&!this.stopping&&!shuttingDown){console.warn(`[music24:${this.accountId}:${this.profile.id}] silence feed exited (${code}); restarting`);setTimeout(startSilence,1500);}});};
    try{
      startSilence();const silencePath=this.silence?.streamName;
      if(!silencePath||!(await waitForMediaPath(silencePath)))throw new Error("MediaMTX did not receive the Music 24/7 audio feed in time");
      if(!this.running||this.stopping)return;
      const outputUrl=`${RTMP_ORIGIN}/${outputPath}`,video=profileVideo(this.profile);
      this.compositor=new Compositor({accountId:`music24-${this.accountId}-${sanitizeSegment(this.profile.id)}`,pageUrl:musicSceneUrl(this.account,this.profile),audioSourceUrl:`${RTMP_ORIGIN}/${silencePath}`,outputUrl,getMusicNow:()=>this.getNow(),musicFilePathFor:id=>this.musicFilePathFor(id),video,runtimeDir:path.join("/tmp","castnexus-music24",sanitizeSegment(this.accountId),sanitizeSegment(this.profile.id)),logger:console});
      await this.compositor.start();
      if(!(await waitForMediaPath(outputPath))){const status=this.compositor?.status?.();throw new Error(`Music 24/7 publisher did not become live${status?.error?`: ${status.error}`:""}`);}
      this.phase="live";this.error=null;lastStatus.set(this.accountId,{state:"live",profileId:this.profile.id,outputPath,error:null,video});
      console.log(`[music24:${this.accountId}:${this.profile.id}] ON AIR ${video.width}x${video.height}@${video.fps} -> ${outputPath}`);
    }catch(err){this.phase="error";this.error=err.message;lastStatus.set(this.accountId,{state:"error",profileId:this.profile.id,outputPath,error:err.message});await this.stop({preserveStatus:true});throw err;}
  }
  async stop({preserveStatus=false}={}){if(this.stopping)return;this.stopping=true;this.running=false;this.stopNowPoll();if(this.compositor){try{await this.compositor.stop();}catch{}this.compositor=null;}if(this.silence?.child){const child=this.silence.child;child.removeAllListeners("exit");try{child.kill("SIGTERM");}catch{}this.silence=null;}this.outputPath=null;if(!preserveStatus){this.phase="idle";this.error=null;lastStatus.set(this.accountId,{state:"idle",profileId:this.profile?.id||null,outputPath:null,error:null});}this.stopping=false;console.log(`[music24:${this.accountId}:${this.profile?.id}] stopped`);}
}

async function reconcile(){
  const state=readState();if(!state?.accounts)return;const desired=new Set();
  for(const account of Object.values(state.accounts)){
    const profile=activeProfileFor(account),musicState=profileMusicState(account,profile);
    const ready=profile?.mode==="music"&&profile?.musicAutostart!==false&&(musicState?.tracks.length||0)>0&&validRtmpKey(profile?.rtmpKey)&&account.twitchLogin;
    if(!ready)continue;
    desired.add(account.twitchUserId);const sig=musicWorkerSignature(account,profile);let worker=workers.get(account.twitchUserId);
    if(worker&&worker.signature!==sig){await worker.stop();workers.delete(account.twitchUserId);worker=null;}
    if(!worker){worker=new Music24Worker(account,profile);workers.set(account.twitchUserId,worker);worker.start().catch(async err=>{console.error(`[music24:${account.twitchUserId}:${profile.id}] start failed: ${err.message}`);lastStatus.set(account.twitchUserId,{state:"error",profileId:profile.id,outputPath:worker.outputPath||null,error:err.message});if(workers.get(account.twitchUserId)===worker)workers.delete(account.twitchUserId);try{await worker.stop({preserveStatus:true});}catch{}});}else worker.update(account,profile);
  }
  for(const[accountId,worker]of[...workers.entries()])if(!desired.has(accountId)){await worker.stop();workers.delete(accountId);}
}

function statusFor(accountId){
  const worker=workers.get(String(accountId));
  if(worker)return {state:worker.phase||"starting",profileId:worker.profile?.id||null,outputPath:worker.outputPath||null,error:worker.error||null,running:!!worker.running};
  return lastStatus.get(String(accountId))||{state:serviceStarted?"idle":"worker-offline",profileId:null,outputPath:null,error:null,running:false};
}

function startMusic24(){
  if(serviceStarted)return {started:true,alreadyRunning:true};
  shuttingDown=false;serviceStarted=true;
  console.log(`[music24] watching ${STATE_FILE} for active profile-scoped 24/7 music`);
  reconcile().catch(err=>console.error("[music24] initial reconcile failed",err));
  reconcileTimer=setInterval(()=>reconcile().catch(err=>console.error("[music24] reconcile failed",err)),POLL_MS);
  return {started:true,alreadyRunning:false};
}
async function shutdown(signal="shutdown",{exit=false}={}){
  if(shuttingDown)return;shuttingDown=true;serviceStarted=false;
  if(reconcileTimer){clearInterval(reconcileTimer);reconcileTimer=null;}
  console.log(`[music24] ${signal} received; stopping workers`);
  for(const worker of workers.values()){try{await worker.stop();}catch{}}workers.clear();
  if(exit)process.exit(0);
}

if(require.main===module){
  if(String(process.env.MUSIC24_STANDALONE || "").toLowerCase() !== "true"){
    console.log("[music24] standalone sidecar is disabled; Music 24/7 now runs inside the CastNexus dashboard runtime. Set MUSIC24_STANDALONE=true only for a custom legacy deployment.");
  }else{
    process.on("SIGINT",()=>shutdown("SIGINT",{exit:true}));
    process.on("SIGTERM",()=>shutdown("SIGTERM",{exit:true}));
    process.on("unhandledRejection",err=>console.error("[music24] unhandled rejection",err));
    startMusic24();
  }
}

module.exports={startMusic24,shutdown,reconcile,statusFor,Music24Worker,mediaPathReady,waitForMediaPath,profileMusicState,musicWorkerSignature};
