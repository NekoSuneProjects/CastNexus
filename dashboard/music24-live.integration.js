"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "castnexus-music24-live-"));
const stateFile = path.join(temp, "state.json");
const musicDir = path.join(temp, "music");
const accountId = "music-ci";
const login = "music-ci";
const profileId = "radio";
const profileKey = "0123456789abcdef0123456789abcdef0123";
const dashboardPort = 18091;
const apiBase = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
const rtmpOrigin = process.env.MEDIA_RTMP_ORIGIN || "rtmp://127.0.0.1:1935";
const chrome = process.env.PUPPETEER_EXECUTABLE_PATH;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function mediaPaths() {
  try {
    const response = await fetch(`${apiBase}/v3/paths/list`, { cache:"no-store" });
    if (!response.ok) return [];
    const data = await response.json();
    return data.items || [];
  } catch {
    return [];
  }
}

async function waitForPath(name, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await mediaPaths();
    if (items.some(item => item.ready && item.name === name)) return true;
    await sleep(250);
  }
  return false;
}

(async () => {
  if (!chrome || !fs.existsSync(chrome)) {
    throw new Error(`PUPPETEER_EXECUTABLE_PATH must point to Chrome/Chromium, got ${chrome || "empty"}`);
  }

  const profileDir = path.join(musicDir, accountId, profileId);
  fs.mkdirSync(profileDir, { recursive:true });
  const audioPath = path.join(profileDir, "tone.wav");
  const generated = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "20", "-c:a", "pcm_s16le", audioPath,
  ], { encoding:"utf8" });
  if (generated.status !== 0) throw new Error(`could not create test audio: ${generated.stderr}`);

  const profile = {
    id:profileId,
    name:"CI Radio",
    mode:"music",
    rtmpKey:profileKey,
    canvasMode:"landscape",
    musicAutostart:true,
    sceneMusicEnabled:true,
    compositorEnabled:false,
    musicVisual:{ station:"CI Radio", title:"CI Radio", accent:"#00f0ff", cover:"", background:"" },
  };

  const state = {
    sessionSecret:"castnexus-ci-session-secret",
    accounts:{
      [accountId]:{
        twitchUserId:accountId,
        twitchLogin:login,
        displayName:"Music CI",
        profileImageUrl:"",
        sourceMode:"pc",
        pcKey:"abcdef0123456789abcdef01",
        destinations:[],
        destinationProfiles:{},
        overlays:[{
          id:"profile-store-ci",
          name:"RestreamNode Profiles",
          type:"html",
          enabled:true,
          config:{
            system:"restreamnode-profile-store-v1",
            html:"",
            version:1,
            profiles:[profile],
            activeProfileId:profileId,
          },
        }],
        musicProfiles:{
          [profileId]:{
            tracks:[{
              id:"tone",
              filename:"tone.wav",
              title:"CI Tone",
              artist:"CastNexus",
              album:"CI",
              durationS:20,
              uploadedAt:new Date().toISOString(),
            }],
            settings:{ shuffle:false, loop:true, volume:0.7 },
          },
        },
        musicTracks:[],
        musicSettings:{ shuffle:false, loop:true, volume:0.7 },
        musicProfileMigrationDone:true,
        vodProfiles:{},
        overlayConfig:{
          startingSoon:{ title:"Starting Soon", subtitle:"", accent:"#7c5cff" },
          brb:{ title:"BRB", subtitle:"", accent:"#7c5cff" },
          ending:{ title:"Ending", subtitle:"", accent:"#7c5cff" },
          live:{ title:"LIVE", accent:"#35d07f" },
          nowPlaying:{ enabled:false, corner:"br" },
        },
        currentScene:null,
        compositorEnabled:false,
        recordingEnabled:false,
        youtubeUploadHistory:[],
      },
    },
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const child = spawn(process.execPath, [path.join(__dirname, "server-entry.js")], {
    cwd:__dirname,
    env:{
      ...process.env,
      DASHBOARD_PORT:String(dashboardPort),
      STATE_FILE:stateFile,
      MUSIC_DIR:musicDir,
      MEDIAMTX_API:apiBase,
      MEDIA_RTMP_ORIGIN:rtmpOrigin,
      PUPPETEER_EXECUTABLE_PATH:chrome,
      MUSIC24_POLL_MS:"250",
      MUSIC24_NOW_POLL_MS:"250",
      MUSIC24_START_TIMEOUT_MS:"60000",
      MUSIC24_EMBED_START_DELAY_MS:"100",
      MUSIC24_WIDTH:"320",
      MUSIC24_HEIGHT:"180",
      MUSIC24_FPS:"5",
      COMPOSITOR_WIDTH:"320",
      COMPOSITOR_HEIGHT:"180",
      COMPOSITOR_FPS:"5",
      COMPOSITOR_JPEG_QUALITY:"45",
      COMPOSITOR_VIDEO_BITRATE:"500k",
      COMPOSITOR_VIDEO_MAXRATE:"600k",
      COMPOSITOR_VIDEO_BUFSIZE:"1000k",
      CASTNEXUS_PI_SAFE_MODE:"false",
      CASTNEXUS_VIDEO_ENCODER:"libx264",
    },
    stdio:["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk.toString(); });
  child.stderr.on("data", chunk => { logs += chunk.toString(); });

  try {
    const profilePath = `profile/${profileId}/${profileKey}`;
    const profileReady = await waitForPath(profilePath, 65000);
    const publicReady = profileReady ? await waitForPath(`public/${login}`, 20000) : false;

    if (!profileReady || !publicReady) {
      const items = await mediaPaths();
      throw new Error([
        `Music 24/7 end-to-end failed: profileReady=${profileReady}, publicReady=${publicReady}`,
        `MediaMTX paths: ${items.map(item => `${item.name}:${item.ready}`).join(", ") || "none"}`,
        "--- CastNexus logs ---",
        logs,
      ].join("\n"));
    }

    console.log(`Music 24/7 profile path READY: ${profilePath}`);
    console.log(`CastNexus public path READY: public/${login}`);
    console.log(logs);
  } finally {
    try { child.kill("SIGTERM"); } catch {}
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      sleep(3000),
    ]);
    try { if (!child.killed) child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(temp, { recursive:true, force:true }); } catch {}
  }
})().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
