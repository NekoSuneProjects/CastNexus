"use strict";

// Tests for the Music 24/7 performance work, Overlay Studio scene model,
// program renderer, per-destination output planning, captions, supervisor
// and diagnostics helpers.

const test = require("node:test");
const assert = require("node:assert/strict");

const perf = require("./performance-modes");
const sceneModel = require("./scene-model");
const sceneRender = require("./scene-render");
const dest = require("./destination-output");
const captions = require("./captions");
const supervisor = require("./process-supervisor");
const monitor = require("./resource-monitor");
const compositor = require("./compositor");
const { applyPcmGain } = require("./audio-relay");
const gpu = require("./gpu-encoder");
const { musicSceneFragment } = require("./music-scene");
const { scenePerfCss } = require("./scenes");

// ------------------------------------------------------------ performance
test("Auto performance picks Balanced with a hardware encoder and Low CPU without", () => {
  assert.equal(perf.resolveMusicPerformance({ mode:"auto" }, { hardwareEncoder:true }).mode, "balanced");
  assert.equal(perf.resolveMusicPerformance({ mode:"auto" }, { hardwareEncoder:false }).mode, "low");
  // Maximum is opt-in only: Chromium GPU in containers often silently falls back.
  assert.equal(perf.resolveMusicPerformance({ mode:"auto" }, { hardwareEncoder:true, chromiumGpu:true }).mode, "balanced");
});

test("render FPS, spectrum and progress rates are decoupled from output FPS", () => {
  const low = perf.resolveMusicPerformance({ mode:"low" }, { outputFps:30 });
  assert.equal(low.outputFps, 30);
  assert.equal(low.renderFps, 20);
  assert.ok(low.spectrumHz <= low.renderFps && low.spectrumHz >= 10);
  assert.ok(low.progressHz <= low.spectrumHz);
  assert.equal(low.clockHz, 1);
  const ultra = perf.resolveMusicPerformance({ mode:"ultra" }, { outputFps:30 });
  assert.ok(ultra.renderFps >= 10 && ultra.renderFps <= 15);
  assert.equal(ultra.effects, "minimal");
  // An explicit render FPS is honoured but never above the output rate.
  assert.equal(perf.resolveMusicPerformance({ mode:"max", renderFps:60 }, { outputFps:30 }).renderFps, 30);
  assert.equal(perf.resolveMusicPerformance({ mode:"balanced", renderFps:15 }, { outputFps:30 }).renderFps, 15);
});

test("reduced effects stop every continuous CSS animation in the server scene", () => {
  assert.equal(scenePerfCss("full"), "");
  assert.match(scenePerfCss("reduced"), /animation:none/);
  assert.match(scenePerfCss("minimal"), /text-shadow:none/);
  const page = musicSceneFragment("x", {}, { effects:"reduced", spectrumHz:12, progressHz:4 }, {}, "p");
  assert.match(page, /animation:none/);
  assert.match(page, /"spectrumHz":12/);
  // Metadata is event-driven with a slow fallback poll, not 1 s polling.
  assert.match(page, /FALLBACK_POLL_MS=15000/);
  assert.match(page, /EventSource/);
  // OBS browser-source use keeps the original look by default.
  assert.doesNotMatch(musicSceneFragment("x", {}, {}, {}, "p"), /animation:none !important/);
});

test("everyNthFrame skips compositor frames only above the capture rate", () => {
  assert.equal(perf.everyNthFrameFor(30), 2);
  assert.equal(perf.everyNthFrameFor(20), 3);
  assert.equal(perf.everyNthFrameFor(60), 1);
});

// ---------------------------------------------------------------- pipeline
test("CFR frame pump keeps video on constant-rate timestamps next to realtime audio", () => {
  const args = compositor.videoInputArgs({ electronOffscreen:false, fps:30, inputFps:20, width:1920, height:1080, timestamps:"cfr" });
  assert.equal(args[args.indexOf("-framerate") + 1], "20");
  assert.equal(args.includes("-use_wallclock_as_timestamps"), false);
  assert.equal(args[args.indexOf("-analyzeduration") + 1], "0");
  const legacy = compositor.videoInputArgs({ electronOffscreen:false, fps:30, width:1920, height:1080, timestamps:"wallclock" });
  assert.equal(legacy[legacy.indexOf("-use_wallclock_as_timestamps") + 1], "1");
  assert.equal(compositor.framesOwed(0, 0, 50, 0), 1);
  assert.equal(compositor.framesOwed(0, 10, 50, 1000), 11);
  assert.ok(compositor.cfrBacklogLimit(300 * 1024, 20) > compositor.framePumpBacklogLimit(300 * 1024));
});

test("filter graph encodes at the output rate while the input can be slower", () => {
  const plan = compositor.audioInputPlan(false, "live", "music");
  assert.match(compositor.compositorFilterGraph({ fps:30, encoder:{ id:"libx264" }, audioPlan:plan }), /fps=30/);
});

test("browser audio adds a third mixed bus", () => {
  const plan = compositor.audioInputPlan(true, "live", "music", "browser");
  assert.equal(plan.inputs, 3);
  assert.match(plan.filter, /amix=inputs=3/);
  assert.equal(compositor.audioInputPlan(false, "live", "music", "browser").inputs, 2);
});

test("Chromium is only unmuted when browser audio is wanted and blocks local network access", () => {
  const muted = compositor.chromiumLaunchArgs({ width:1280, height:720, gpuEnabled:false, browserAudio:false });
  const loud = compositor.chromiumLaunchArgs({ width:1280, height:720, gpuEnabled:false, browserAudio:true });
  assert.ok(muted.includes("--mute-audio"));
  assert.equal(loud.includes("--mute-audio"), false);
  assert.ok(loud.includes("--autoplay-policy=no-user-gesture-required"));
  assert.ok(loud.some(a => a.startsWith("--enable-features=") && a.includes("BlockInsecurePrivateNetworkRequests")));
});

test("mixer gains honour mute and solo, and PCM gain is applied in place", () => {
  assert.deepEqual(compositor.effectiveMixerGains({ program:{ volume:1 }, browser:{ volume:0.4 }, music:{ volume:0.8, muted:true } }), { program:1, music:0, browser:0.4 });
  assert.deepEqual(compositor.effectiveMixerGains({ program:{ volume:1 }, browser:{ volume:1, solo:true } }), { program:0, music:0, browser:1 });
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(10000, 0); pcm.writeInt16LE(-30000, 2);
  applyPcmGain(pcm, 0.5);
  assert.equal(pcm.readInt16LE(0), 5000);
  assert.equal(pcm.readInt16LE(2), -15000);
  applyPcmGain(pcm, 4);
  assert.equal(pcm.readInt16LE(2), -32768, "clips instead of wrapping");
});

test("encoder fallback walks NVENC -> QSV -> x264", () => {
  const adv = " V..... h264_nvenc a\n V..... h264_qsv b\n V..... libx264 c";
  assert.deepEqual(gpu.fallbackOrder("nvenc", { advertisedText:adv, platform:"linux" }).map(p => p.id), ["nvenc", "qsv", "libx264"]);
  assert.equal(gpu.nextWorkingEncoder("nvenc", ["nvenc"], { advertisedText:adv, probe:p => ({ ok:p.id === "qsv" }) }).id, "qsv");
  assert.equal(gpu.nextWorkingEncoder("nvenc", ["nvenc", "qsv"], { advertisedText:adv, probe:() => ({ ok:true }) }).hardware, false);
  assert.equal(gpu.normalisePreference("QuickSync"), "qsv");
  assert.equal(gpu.resolveEncoder("cpu").hardware, false);
});

// ------------------------------------------------------------- scene model
test("scene library migrates an old account without touching existing data", () => {
  const account = { twitchLogin:"a", overlayConfig:{ brb:{ title:"Back soon" } }, currentScene:{ kind:"builtin", name:"brb" } };
  assert.equal(sceneModel.ensure(account), true);
  assert.equal(sceneModel.ensure(account), false, "idempotent");
  const lib = account.sceneLibrary;
  assert.ok(lib.scenes.some(s => s.orientation === "landscape"));
  assert.ok(lib.scenes.some(s => s.orientation === "vertical"));
  assert.equal(lib.slots.brb.mode, "builtin");
  assert.equal(account.overlayConfig.brb.title, "Back soon");
  assert.deepEqual(account.currentScene, { kind:"builtin", name:"brb" });
});

test("layer input is sanitised: no javascript: URLs, bounded numbers, known types", () => {
  const layer = sceneModel.sanitiseLayer({ type:"streamelements", x:"12.6", width:-5, config:{ url:"javascript:alert(1)" }, audio:{ volume:9 } });
  assert.equal(layer.config.url, "");
  assert.equal(layer.x, 13);
  assert.equal(layer.width, 1);
  assert.equal(layer.audio.volume, 2);
  assert.equal(layer.audio.enabled, true, "browser sources default to audible");
  assert.equal(sceneModel.sanitiseLayer({ type:"<script>" }).type, "browser");
  assert.equal(sceneModel.safeColor("red;background:url(x)"), "#000000");
  assert.equal(sceneModel.isLoopbackUrl("http://127.0.0.1:8090/api/status"), true);
  assert.equal(sceneModel.isLoopbackUrl("https://streamelements.com/overlay/x"), false);
});

test("scenes can be created, duplicated, switched live and deleted safely", () => {
  const account = {};
  sceneModel.ensure(account);
  const v = sceneModel.createScene(account, { name:"TikTok", orientation:"vertical" });
  assert.equal(v.canvas.width, 1080);
  assert.equal(v.layers[0].type, "program");
  const copy = sceneModel.createScene(account, { duplicateOf:v.id });
  assert.notEqual(copy.layers[0].id, v.layers[0].id);
  assert.deepEqual(sceneModel.setLive(account, "vertical", copy.id), { orientation:"vertical", sceneId:copy.id });
  assert.throws(() => sceneModel.setLive(account, "landscape", copy.id), /vertical/);
  sceneModel.deleteScene(account, copy.id);
  assert.notEqual(account.sceneLibrary.live.vertical, copy.id, "live falls back when the live scene is deleted");
  const keep = account.sceneLibrary.scenes.filter(s => s.orientation === "landscape");
  for (const s of keep.slice(1)) sceneModel.deleteScene(account, s.id);
  assert.throws(() => sceneModel.deleteScene(account, keep[0].id), /at least one/);
});

test("browser audio is only required when an audible layer or slot exists", () => {
  const account = {};
  sceneModel.ensure(account);
  assert.equal(sceneModel.libraryNeedsBrowserAudio(account), false);
  const scene = sceneModel.liveScene(account, "landscape");
  sceneModel.updateScene(account, scene.id, { layers:[...scene.layers, { type:"streamelements", config:{ url:"https://streamelements.com/overlay/a/b" } }] });
  assert.equal(sceneModel.libraryNeedsBrowserAudio(account), true);
});

test("program sizes stay even and in the right orientation", () => {
  const programs = sceneModel.sanitisePrograms({ landscape:{ width:721, height:1281 }, vertical:{ width:1920, height:1080, fps:61 } });
  assert.deepEqual([programs.landscape.width, programs.landscape.height], [1280, 720]);
  assert.deepEqual([programs.vertical.width, programs.vertical.height], [1080, 1920]);
  assert.equal(programs.vertical.fps, 60);
});

// --------------------------------------------------------------- renderer
function renderAccount() {
  const account = { twitchLogin:"tester", overlayConfig:{}, overlays:[], currentScene:null };
  sceneModel.ensure(account);
  const scene = sceneModel.liveScene(account, "landscape");
  sceneModel.updateScene(account, scene.id, { layers:[...scene.layers,
    { id:"se", type:"streamelements", name:"Alerts", config:{ url:"https://streamelements.com/overlay/a/b" }, audio:{ enabled:true, volume:0.5 } },
    { id:"loop", type:"browser", config:{ url:"http://127.0.0.1:8090/api/status" }, audio:{ enabled:false } },
    { id:"code", type:"html", config:{ html:"<b>hi</b><script>parent.x=1</script>" } },
  ] });
  return account;
}

test("live program keeps gameplay under StreamElements with audio and sandboxing", () => {
  const model = sceneRender.resolveProgram(renderAccount(), "landscape");
  assert.equal(model.source, "live");
  assert.equal(model.layers[0].type, "program");
  assert.equal(model.hasProgramVideo, true);
  assert.equal(model.browserAudio, true);
  const se = model.layers.find(l => l.id === "se");
  assert.match(se.html, /sandbox="allow-scripts allow-same-origin allow-presentation"/);
  assert.match(se.html, /data-cn-volume="0.5"/);
  // A loopback URL would share the renderer's origin: no allow-same-origin.
  assert.match(model.layers.find(l => l.id === "loop").html, /sandbox="allow-scripts allow-presentation"/);
  // Custom HTML runs in an opaque-origin sandbox (srcdoc, no same-origin).
  const code = model.layers.find(l => l.id === "code").html;
  assert.match(code, /sandbox="allow-scripts"/);
  assert.doesNotMatch(code, /allow-same-origin/);
});

test("moving a layer or changing its volume does not change its content hash", () => {
  const a = sceneModel.sanitiseLayer({ id:"x", type:"streamelements", config:{ url:"https://streamelements.com/overlay/a/b" } });
  const b = { ...a, x:500, y:40, audio:{ ...a.audio, volume:0.2 } };
  assert.equal(sceneRender.contentHash(a), sceneRender.contentHash(b));
  assert.notEqual(sceneRender.contentHash(a), sceneRender.contentHash({ ...a, config:{ ...a.config, url:"https://streamelements.com/overlay/c/d" } }));
});

test("Starting Soon / BRB / Ending slots support built-in, scene, URL, HTML and media", () => {
  const account = renderAccount();
  account.currentScene = { kind:"builtin", name:"brb" };
  assert.equal(sceneRender.resolveProgram(account, "landscape").layers[0].type, "castnexus");
  sceneModel.setSlot(account, "brb", { mode:"url", url:"https://streamelements.com/overlay/brb/1", audio:{ enabled:true } });
  const url = sceneRender.resolveProgram(account, "vertical");
  assert.equal(url.source, "slot:brb:url");
  assert.equal(url.browserAudio, true);
  sceneModel.setSlot(account, "brb", { mode:"media", mediaUrl:"https://cdn.example.com/brb.mp4" });
  assert.equal(sceneRender.resolveProgram(account, "landscape").layers[0].type, "video");
  const v = sceneModel.createScene(account, { name:"Ending scene", orientation:"landscape", withProgram:false });
  sceneModel.setSlot(account, "ending", { mode:"scene", sceneId:v.id });
  account.currentScene = { kind:"builtin", name:"ending" };
  assert.equal(sceneRender.resolveProgram(account, "landscape").sceneId, v.id);
  assert.throws(() => sceneModel.setSlot(account, "brb", { mode:"url", url:"javascript:x" }), /URL/);
});

test("the program page embeds its model safely and never exposes editor guides by default", () => {
  const account = renderAccount();
  account.sceneLibrary.scenes[0].name = "</script><script>alert(1)</script>";
  const html = sceneRender.programPage("tester", sceneRender.resolveProgram(account, "landscape"));
  assert.equal(html.includes("</script><script>alert(1)"), false);
  assert.match(html, /GUIDES=""/);
});

// ---------------------------------------------------------- destinations
const PROGRAMS = { enabled:true, landscape:{ width:1280, height:720, fps:30, bitrateKbps:null }, vertical:{ width:720, height:1280, fps:30, bitrateKbps:null } };

test("passthrough never decodes or encodes video", () => {
  const plan = dest.planDestination({ url:"rtmp://a/app/k", output:{ mode:"source" } }, PROGRAMS);
  assert.equal(plan.feed, "raw");
  assert.equal(plan.copy, true);
  const args = dest.plannedDestinationArgs("rtmp://127.0.0.1:1935/live/x", { url:"rtmp://a/app/k", output:{ mode:"source" } }, plan, { forceCpu:true });
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args.includes("-filter_complex"), false);
});

test("destinations matching a program stream-copy it; others transcode once", () => {
  const h = dest.planDestination({ url:"rtmp://a", output:{ mode:"landscape" } }, PROGRAMS);
  const v = dest.planDestination({ url:"rtmp://b", output:{ mode:"vertical" } }, PROGRAMS);
  const v60 = dest.planDestination({ url:"rtmp://c", output:{ mode:"vertical", fps:60 } }, PROGRAMS);
  assert.deepEqual([h.feed, h.orientation, h.copy], ["program", "landscape", true]);
  assert.deepEqual([v.feed, v.orientation, v.copy], ["program", "vertical", true]);
  assert.equal(v60.copy, false);
  // Identical transcodes share one rendition key; different ones do not.
  const again = dest.planDestination({ url:"rtmp://d", output:{ mode:"vertical", fps:60 } }, PROGRAMS);
  assert.equal(dest.renditionKey(v60, "program/1/vertical-live"), dest.renditionKey(again, "program/1/vertical-live"));
  assert.notEqual(dest.renditionKey(v60, "p"), dest.renditionKey(dest.planDestination({ url:"x", output:{ mode:"vertical", fps:50 } }, PROGRAMS), "p"));
  assert.equal(dest.renditionKey(h, "p"), null, "copies need no rendition");
});

test("legacy destinations keep their exact historic routing", () => {
  assert.deepEqual(
    dest.planDestination({ url:"rtmp://a", layout:"source" }, { enabled:true }),
    { legacy:true, feed:"program", orientation:"landscape", sceneId:null, copy:true, layout:"source", reason:"legacy passthrough of the program feed" },
  );
  assert.equal(dest.planDestination({ url:"rtmp://a", layout:"vertical" }, { enabled:false }).feed, "raw");
  assert.equal(dest.effectiveOutput({ layout:"vertical" }).mode, "vertical");
});

test("vertical from raw 16:9 uses crop/fit framing, never a plain stretch", () => {
  const plan = dest.planDestination({ url:"rtmp://a", output:{ mode:"vertical", framing:{ fit:"fill", offsetX:0.1 } } }, { enabled:false });
  assert.equal(plan.transform, "framing");
  const args = dest.plannedDestinationArgs("rtmp://127.0.0.1/live/x", { url:"rtmp://a", output:{ mode:"vertical" } }, plan, { forceCpu:true }).join(" ");
  assert.match(args, /crop=/);
  assert.match(args, /overlay=/);
  assert.match(args, /1080x1920|1080:1920/);
});

test("output input is sanitised and orientation-consistent", () => {
  assert.deepEqual([dest.sanitiseOutput({ mode:"vertical", width:1920, height:1080 }).width, dest.sanitiseOutput({ mode:"vertical", width:1920, height:1080 }).height], [1080, 1920]);
  assert.equal(dest.sanitiseOutput({ mode:"bogus" }).mode, "landscape");
  assert.equal(dest.sanitiseOutput({ mode:"landscape", captionMode:"nope" }).captionMode, "off");
  assert.equal(dest.sanitiseOutput({ mode:"source", width:1920 }).width, null);
});

// ---------------------------------------------------------------- captions
test("caption modes are modular and never take a destination off air", () => {
  assert.equal(captions.captionPlan("off").effective, "off");
  assert.equal(captions.captionPlan("passthrough", { copy:true }).effective, "passthrough");
  assert.deepEqual(captions.captionPlan("passthrough", { copy:false, encoderId:"libx264" }).outputArgs, ["-a53cc", "1"]);
  assert.match(captions.captionPlan("passthrough", { compositorSource:true }).warning, /compositor/);
  assert.match(captions.captionPlan("server").warning, /no server caption provider/);
  const off = captions.registerCaptionProvider({ id:"test", label:"Test", ffmpegPlan:() => ({ outputArgs:["-metadata", "cc=1"] }) });
  try {
    assert.deepEqual(captions.captionPlan("server", { copy:false }).outputArgs, ["-metadata", "cc=1"]);
    assert.equal(captions.captionCapabilities().modes.find(m => m.id === "server").available, true);
  } finally { off(); }
});

// -------------------------------------------------------------- supervisor
test("supervisor backs off exponentially and resets after a stable run", () => {
  assert.equal(supervisor.nextBackoff(0, 0, { min:2000, max:60000, stable:30000 }), 2000);
  assert.equal(supervisor.nextBackoff(2000, 500, { min:2000, max:60000, stable:30000 }), 4000);
  assert.equal(supervisor.nextBackoff(40000, 500, { min:2000, max:60000, stable:30000 }), 60000);
  assert.equal(supervisor.nextBackoff(40000, 45000, { min:2000, max:60000, stable:30000 }), 2000);
  assert.equal(supervisor.classifyFailure("av_interleaved_write_frame(): Broken pipe"), "broken-pipe");
  assert.equal(supervisor.classifyFailure("Connection refused"), "connection-refused");
  assert.equal(supervisor.classifyFailure("NetStream.Publish.BadName"), "auth-rejected");
});

test("supervised process restarts after failure and stops cleanly", async () => {
  let spawned = 0;
  const proc = new supervisor.SupervisedProcess({
    name:"test",
    bin:process.execPath,
    logger:{ warn(){} },
    build:() => { spawned++; return { cmd:process.execPath, args:["-e", "process.exit(3)"] }; },
  });
  proc.backoffMs = 0;
  const original = supervisor.nextBackoff;
  proc.start();
  await new Promise(r => setTimeout(r, 4500));
  proc.stop();
  assert.ok(spawned >= 2, `restarted (${spawned})`);
  assert.equal(proc.status().state, "idle");
  assert.equal(proc.pid(), null);
  assert.equal(typeof original, "function");
});

// ---------------------------------------------------------------- monitor
test("resource monitor parses /proc stat lines and computes per-core CPU", () => {
  const row = monitor.parseProcStat("1234 (chromium (renderer)) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 12 0 100 1000000 2048 18446744073709551615");
  assert.equal(row.pid, 1234);
  assert.equal(row.comm, "chromium (renderer)");
  assert.equal(row.ppid, 1);
  assert.equal(row.cpuSeconds, 3);
  assert.equal(row.rssBytes, 2048 * 4096);
  assert.equal(monitor.cpuPercentBetween(10, 11, 2000), 50);
  const table = new Map([[1, { pid:1, ppid:0 }], [2, { pid:2, ppid:1 }], [3, { pid:3, ppid:2 }], [4, { pid:4, ppid:0 }]]);
  assert.deepEqual([...monitor.descendants(table, [1])].sort(), [1, 2, 3]);
});

test("monitor attributes CPU to registered components between samples", () => {
  const off = monitor.registerComponent("unit:renderer", { group:"unit", pids:() => [10] });
  try {
    const t0 = new Map([[10, { pid:10, ppid:1, cpuSeconds:1, rssBytes:100 }], [11, { pid:11, ppid:10, cpuSeconds:1, rssBytes:50 }]]);
    const t1 = new Map([[10, { pid:10, ppid:1, cpuSeconds:2, rssBytes:100 }], [11, { pid:11, ppid:10, cpuSeconds:1.5, rssBytes:50 }]]);
    monitor.sample({ force:true, table:t0, platform:"linux" });
    const realNow = Date.now;
    const start = realNow();
    Date.now = () => start + 1000;
    try {
      const snap = monitor.sample({ force:true, table:t1, platform:"linux" });
      const row = snap.components.find(c => c.name === "unit:renderer");
      assert.equal(row.processCount, 2);
      assert.equal(row.rssBytes, 150);
      assert.ok(row.cpuPercent > 100 && row.cpuPercent < 200, `cpu ${row.cpuPercent}`);
    } finally { Date.now = realNow; }
  } finally { off(); }
});

// ------------------------------------------------ own Starting Soon/BRB/...
test("Starting Soon / BRB / Ending / Offline become their own 16:9 and 9:16 layered scenes", () => {
  const account = { twitchLogin:"t", overlays:[], overlayConfig:{ startingSoon:{ title:"Soon!", countdownMinutes:10 } } };
  const { slot, scenes } = sceneModel.customiseSlot(account, "startingSoon");
  assert.equal(slot.mode, "scene");
  assert.deepEqual(scenes.map(s => s.orientation), ["landscape", "vertical"]);
  assert.equal(scenes[0].layers.find(l => l.name === "Title").config.text, "Soon!");
  assert.equal(scenes[0].layers.find(l => l.type === "countdown").config.countdownMinutes, 10);
  const count = account.sceneLibrary.scenes.length;
  sceneModel.customiseSlot(account, "startingSoon");
  assert.equal(account.sceneLibrary.scenes.length, count, "idempotent - never overwrites the user's layers");
  account.currentScene = { kind:"builtin", name:"startingSoon", since:new Date().toISOString() };
  assert.equal(sceneRender.resolveProgram(account, "landscape").sceneId, scenes[0].id);
  assert.equal(sceneRender.resolveProgram(account, "vertical").sceneId, scenes[1].id, "vertical has its own layout");
});

test("a StreamElements slot keeps its URL as a layer and is not squeezed on 9:16", () => {
  const account = { twitchLogin:"t", overlays:[], overlayConfig:{} };
  sceneModel.ensure(account);
  sceneModel.setSlot(account, "brb", { mode:"url", url:"https://streamelements.com/overlay/aaa/bbb" });
  account.currentScene = { kind:"builtin", name:"brb" };
  const v = sceneRender.resolveProgram(account, "vertical").layers.find(l => l.type === "browser");
  assert.equal(v.box.w, 1080);
  assert.ok(v.box.h < 1920, "rendered as a 16:9 band on the tall canvas");
  assert.match(v.html, /data-cn-rw="1920" data-cn-rh="1080"/);
  const { scenes } = sceneModel.customiseSlot(account, "brb");
  const vLayer = scenes[1].layers.find(l => l.type === "streamelements");
  assert.equal(vLayer.config.url, "https://streamelements.com/overlay/aaa/bbb");
  assert.equal(vLayer.config.renderWidth, 1920);
  assert.equal(vLayer.width, 1080);
});

test("browser page size is sanitised", () => {
  assert.equal(sceneModel.sanitiseLayer({ type:"browser", config:{ url:"https://a.b", renderWidth:1920, renderHeight:1080 } }).config.renderWidth, 1920);
  assert.equal(sceneModel.sanitiseLayer({ type:"browser", config:{ url:"https://a.b", renderWidth:5, renderHeight:5 } }).config.renderWidth, undefined);
});

test("frame pump timing follows the FFmpeg version (wallclock on 5.1/6, CFR on 7+)", () => {
  assert.equal(compositor.pumpTimestampMode("auto", 5), "wallclock");
  assert.equal(compositor.pumpTimestampMode("auto", 6), "wallclock");
  assert.equal(compositor.pumpTimestampMode("auto", 7), "cfr");
  assert.equal(compositor.pumpTimestampMode("cfr", 5), "cfr", "explicit setting wins");
  assert.equal(compositor.pumpTimestampMode("wallclock", 8), "wallclock");
});

test("hybrid pipeline graph places the gameplay box and overlays the PNG layer", () => {
  const g = compositor.hybridVideoGraph({ plan:{ box:{ x:0, y:420, w:720, h:405 }, program:{ fit:"fill" } }, width:720, height:1280, fps:30 });
  assert.match(g, /color=c=black:s=720x404/);
  assert.match(g, /overlay=x=0:y=420/);
  assert.match(g, /alpha=premultiplied/);
  assert.ok(g.endsWith("[vbase]"));
});

// ------------------------------------------------------- idle resources
test("a destination that keeps failing stops retrying instead of respawning forever", async () => {
  let spawned = 0, gaveUp = null;
  const proc = new supervisor.SupervisedProcess({
    name:"dead-ingest", logger:{ warn(){} }, maxFailures:2,
    build:() => { spawned++; return { cmd:process.execPath, args:["-e", "process.exit(1)"] }; },
    onGiveUp:status => { gaveUp = status; },
  });
  proc.start();
  await new Promise(r => setTimeout(r, 4500));
  assert.equal(proc.status().state, "gave-up");
  assert.ok(gaveUp, "onGiveUp releases the renderer it was holding");
  const count = spawned;
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(spawned, count, "no more FFmpeg spawns after giving up");
  proc.stop();
});

test("Music 24/7 only runs while something consumes it", () => {
  const music24 = require("./music24");
  const profile = { id:"radio" };
  assert.equal(music24.musicHasConsumer({ destinationProfiles:{ radio:[{ enabled:false }] } }, profile), false);
  assert.equal(music24.musicHasConsumer({ destinationProfiles:{ radio:[{ enabled:true }] } }, profile), true);
  assert.equal(music24.musicHasConsumer({ destinationProfiles:{ radio:[] }, relayPushEnabled:true }, profile), true);
  process.env.MUSIC24_ALWAYS_ON = "true";
  try { assert.equal(music24.musicHasConsumer({}, profile), true); } finally { delete process.env.MUSIC24_ALWAYS_ON; }
});
