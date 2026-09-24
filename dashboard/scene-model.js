"use strict";

// Reusable scene / layer model for Overlay Studio.
//
//   account.sceneLibrary = {
//     version,
//     scenes:   [{ id, name, kind, orientation, canvas:{width,height}, layers:[...] }],
//     live:     { landscape:sceneId, vertical:sceneId },   // what LIVE/GAMEPLAY shows
//     slots:    { startingSoon|brb|ending|offline: { mode, sceneId, url, html, css, mediaUrl, mediaType, audio } },
//     mixer:    { program|music|browser: { volume, muted, solo } },
//     programs: { landscape:{width,height,fps,bitrateKbps}, vertical:{...} },
//   }
//
// Layers are stored bottom -> top (array order is z-order). Coordinates are in
// the scene's own canvas pixels, so one layout renders identically at 720p,
// 1080p or any custom program size (the renderer scales the whole stage).
//
// The existing account.currentScene ({kind:"builtin"|"custom"|"none"}) keeps
// working unchanged: "none" now means "show the live library scene", and the
// builtin Starting Soon / BRB / Ending / Offline names resolve through slots,
// which default to the original built-in CastNexus scenes.

const crypto = require("node:crypto");

const VERSION = 1;
const ORIENTATIONS = Object.freeze(["landscape", "vertical"]);
const CANVAS_PRESETS = Object.freeze({
  landscape:[{ width:1920, height:1080 }, { width:1280, height:720 }],
  vertical:[{ width:1080, height:1920 }, { width:720, height:1280 }],
});
const LAYER_TYPES = Object.freeze([
  "program", "browser", "streamelements", "streamlabs", "webpage", "iframe", "chat", "alertbox",
  "image", "gif", "video", "text", "clock", "countdown", "music", "nowplaying",
  "webcam", "background", "color", "gradient", "html", "css",
]);
// Types rendered as sandboxed third-party browser sources.
const BROWSER_TYPES = Object.freeze(["browser", "streamelements", "streamlabs", "webpage", "iframe", "chat", "alertbox"]);
// Types whose sound can be captured into the broadcast.
const AUDIO_TYPES = Object.freeze([...BROWSER_TYPES, "video", "html"]);
const SLOT_NAMES = Object.freeze(["startingSoon", "brb", "ending", "offline"]);
const SLOT_MODES = Object.freeze(["builtin", "scene", "url", "html", "media"]);
const SCENE_KINDS = Object.freeze(["gameplay", "chatting", "music", "intermission", "custom"]);
const PROGRAM_FITS = Object.freeze(["fit", "fill", "crop", "stretch"]);
const MONITOR_MODES = Object.freeze(["output", "server", "off"]);
const MIXER_BUSES = Object.freeze(["program", "music", "browser"]);

function uid(prefix = "l") {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function num(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function str(value, fallback = "", max = 500) {
  return value == null ? fallback : String(value).slice(0, max);
}

function bool(value, fallback = false) {
  return value == null ? fallback : Boolean(value);
}

// http(s) only. Blocks javascript:, data:, file: and other schemes that must
// never reach an iframe/img src inside the server-side renderer.
function safeUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

// Loopback / unspecified hosts. A browser source pointing at them would share
// the renderer's own origin (127.0.0.1:8090), so it is never given
// allow-same-origin, and the renderer additionally blocks local network access.
function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1" || host === "::" || /^127\./.test(host);
  } catch {
    return false;
  }
}

function safeColor(value, fallback = "#000000") {
  const v = String(value || "").trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^rgba?\(\s*[\d.\s,%]+\)$/i.test(v)) return v;
  if (v === "transparent") return v;
  return fallback;
}

function canvasFor(orientation, canvas = {}) {
  const o = orientation === "vertical" ? "vertical" : "landscape";
  const preset = CANVAS_PRESETS[o][0];
  return {
    width:Math.round(num(canvas.width, preset.width, 64, 7680)),
    height:Math.round(num(canvas.height, preset.height, 64, 7680)),
  };
}

function defaultAudio(type) {
  // Browser sources default to audible: StreamElements alerts are expected to
  // be heard. Videos default to audible too; everything else has no audio.
  return { enabled:AUDIO_TYPES.includes(type) && type !== "html", volume:1, muted:false, monitor:"output" };
}

function sanitiseAudio(raw, type) {
  const base = defaultAudio(type);
  const a = raw && typeof raw === "object" ? raw : {};
  return {
    enabled:AUDIO_TYPES.includes(type) ? bool(a.enabled, base.enabled) : false,
    volume:num(a.volume, base.volume, 0, 2),
    muted:bool(a.muted, false),
    monitor:MONITOR_MODES.includes(a.monitor) ? a.monitor : "output",
  };
}

function sanitiseProgram(raw = {}) {
  const p = raw && typeof raw === "object" ? raw : {};
  const crop = p.crop && typeof p.crop === "object" ? p.crop : {};
  return {
    fit:PROGRAM_FITS.includes(p.fit) ? p.fit : "fill",
    scale:num(p.scale, 1, 0.1, 8),
    offsetX:num(p.offsetX, 0, -2, 2),
    offsetY:num(p.offsetY, 0, -2, 2),
    crop:{
      left:num(crop.left, 0, 0, 0.9),
      right:num(crop.right, 0, 0, 0.9),
      top:num(crop.top, 0, 0, 0.9),
      bottom:num(crop.bottom, 0, 0, 0.9),
    },
  };
}

function sanitiseConfig(type, raw = {}) {
  const c = raw && typeof raw === "object" ? raw : {};
  const out = {};
  if (BROWSER_TYPES.includes(type)) {
    out.url = safeUrl(c.url);
    out.transparent = bool(c.transparent, true);
    out.background = safeColor(c.background, "#05060a");
    out.interactive = false;
    // Page size the browser source is rendered at (like OBS's browser-source
    // width/height), then scaled into the layer box. A 1920x1080 StreamElements
    // overlay can therefore be shrunk/moved on a 9:16 canvas without reflowing.
    const rw = Math.round(num(c.renderWidth, 0, 0, 3840)), rh = Math.round(num(c.renderHeight, 0, 0, 3840));
    if (rw >= 100 && rh >= 100) { out.renderWidth = rw; out.renderHeight = rh; }
  }
  if (["image", "gif", "background"].includes(type)) {
    out.src = safeUrl(c.src);
    out.fit = ["cover", "contain", "fill"].includes(c.fit) ? c.fit : "cover";
    out.color = safeColor(c.color, "#05060a");
  }
  if (type === "video") {
    out.src = safeUrl(c.src);
    out.fit = ["cover", "contain", "fill"].includes(c.fit) ? c.fit : "cover";
    out.loop = bool(c.loop, true);
  }
  if (["text", "clock", "countdown"].includes(type)) {
    out.text = str(c.text, type === "text" ? "Text" : "", 2000);
    out.fontSize = num(c.fontSize, 48, 6, 600);
    out.fontWeight = Math.round(num(c.fontWeight, 700, 100, 900));
    out.fontFamily = str(c.fontFamily, "", 120).replace(/[^A-Za-z0-9 ,"'-]/g, "");
    out.color = safeColor(c.color, "#ffffff");
    out.align = ["left", "center", "right"].includes(c.align) ? c.align : "center";
    out.shadow = bool(c.shadow, true);
    out.background = safeColor(c.background, "transparent");
  }
  if (type === "clock") {
    out.format = ["24h", "12h", "24h-seconds", "12h-seconds"].includes(c.format) ? c.format : "24h";
    out.timeZone = /^[A-Za-z_\/+-]{1,64}$/.test(String(c.timeZone || "")) ? c.timeZone : "";
  }
  if (type === "countdown") {
    const at = Date.parse(c.countdownAt || "");
    out.countdownAt = Number.isFinite(at) ? new Date(at).toISOString() : "";
    out.countdownMinutes = num(c.countdownMinutes, 0, 0, 1440);
    out.doneText = str(c.doneText, "Starting now", 200);
  }
  if (type === "color") out.color = safeColor(c.color, "#7c5cff");
  if (type === "gradient") {
    out.from = safeColor(c.from, "#7c5cff");
    out.to = safeColor(c.to, "#ff2bd6");
    out.angle = num(c.angle, 135, 0, 360);
  }
  if (type === "webcam") {
    out.borderColor = safeColor(c.borderColor, "#00f0ff");
    out.borderWidth = num(c.borderWidth, 6, 0, 80);
    out.radius = num(c.radius, 18, 0, 2000);
    out.glow = bool(c.glow, true);
    out.label = str(c.label, "", 120);
  }
  if (type === "html") {
    out.html = str(c.html, "", 100000);
    out.css = str(c.css, "", 50000);
  }
  if (type === "css") out.css = str(c.css, "", 50000);
  if (type === "music") out.effects = ["full", "reduced", "minimal"].includes(c.effects) ? c.effects : "reduced";
  if (type === "nowplaying") out.corner = "fill";
  return out;
}

function sanitiseLayer(raw = {}, canvas = { width:1920, height:1080 }) {
  const type = LAYER_TYPES.includes(raw.type) ? raw.type : "browser";
  const full = ["program", "background", "css"].includes(type);
  const layer = {
    id:/^[A-Za-z0-9_-]{1,64}$/.test(String(raw.id || "")) ? String(raw.id) : uid("l"),
    type,
    name:str(raw.name, defaultLayerName(type), 120) || defaultLayerName(type),
    x:Math.round(num(raw.x, 0, -20000, 20000)),
    y:Math.round(num(raw.y, 0, -20000, 20000)),
    width:Math.round(num(raw.width, full ? canvas.width : Math.round(canvas.width / 3), 1, 20000)),
    height:Math.round(num(raw.height, full ? canvas.height : Math.round(canvas.height / 3), 1, 20000)),
    rotation:num(raw.rotation, 0, -360, 360),
    opacity:num(raw.opacity, 1, 0, 1),
    visible:bool(raw.visible, true),
    locked:bool(raw.locked, false),
    config:sanitiseConfig(type, raw.config),
    audio:sanitiseAudio(raw.audio, type),
  };
  if (type === "program") layer.program = sanitiseProgram(raw.program);
  return layer;
}

function defaultLayerName(type) {
  return ({
    program:"Gameplay / OBS", browser:"Browser source", streamelements:"StreamElements", streamlabs:"Streamlabs",
    webpage:"Web page", iframe:"iframe", chat:"Chat", alertbox:"Alert box", image:"Image", gif:"Animated GIF",
    video:"Video", text:"Text", clock:"Clock", countdown:"Countdown", music:"Music widget", nowplaying:"Now Playing",
    webcam:"Webcam frame", background:"Background", color:"Colour block", gradient:"Gradient", html:"Custom HTML", css:"Custom CSS",
  })[type] || "Layer";
}

function sanitiseScene(raw = {}, { keepId = true } = {}) {
  const orientation = raw.orientation === "vertical" ? "vertical" : "landscape";
  const canvas = canvasFor(orientation, raw.canvas);
  return {
    id:keepId && /^[A-Za-z0-9_-]{1,64}$/.test(String(raw.id || "")) ? String(raw.id) : uid("s"),
    name:str(raw.name, "Scene", 80).trim() || "Scene",
    kind:SCENE_KINDS.includes(raw.kind) ? raw.kind : "custom",
    orientation,
    canvas,
    layers:(Array.isArray(raw.layers) ? raw.layers : []).slice(0, 64).map(layer => sanitiseLayer(layer, canvas)),
    createdAt:raw.createdAt || new Date().toISOString(),
    updatedAt:new Date().toISOString(),
  };
}

function programLayer(canvas, program = {}) {
  return sanitiseLayer({ type:"program", name:"Gameplay / OBS", x:0, y:0, width:canvas.width, height:canvas.height, program }, canvas);
}

function defaultScenes() {
  const land = canvasFor("landscape"), vert = canvasFor("vertical");
  return [
    sanitiseScene({ id:"scene_gameplay", name:"Gameplay", kind:"gameplay", orientation:"landscape", layers:[programLayer(land, { fit:"fit" })] }),
    sanitiseScene({ id:"scene_chatting", name:"Just Chatting", kind:"chatting", orientation:"landscape", layers:[
      { type:"gradient", name:"Background", x:0, y:0, width:land.width, height:land.height, config:{ from:"#10121f", to:"#2a1650", angle:135 } },
      { ...programLayer(land, { fit:"fit" }), x:160, y:90, width:1600, height:900 },
    ] }),
    sanitiseScene({ id:"scene_vertical_gameplay", name:"Vertical Gameplay", kind:"gameplay", orientation:"vertical", layers:[
      { type:"gradient", name:"Background", x:0, y:0, width:vert.width, height:vert.height, config:{ from:"#05060a", to:"#1a1030", angle:180 } },
      // Centre-cropped 16:9 gameplay filling the middle band; users drag it.
      { ...programLayer(vert, { fit:"fill" }), x:0, y:480, width:1080, height:960 },
    ] }),
    sanitiseScene({ id:"scene_vertical_chatting", name:"Vertical Just Chatting", kind:"chatting", orientation:"vertical", layers:[
      { type:"gradient", name:"Background", x:0, y:0, width:vert.width, height:vert.height, config:{ from:"#10121f", to:"#2a1650", angle:180 } },
      { ...programLayer(vert, { fit:"fill" }), x:0, y:0, width:1080, height:1920 },
    ] }),
    sanitiseScene({ id:"scene_music", name:"Music", kind:"music", orientation:"landscape", layers:[
      { type:"music", name:"Music visualiser", x:0, y:0, width:land.width, height:land.height, config:{ effects:"reduced" } },
    ] }),
  ];
}

function defaultSlot() {
  return { mode:"builtin", sceneId:null, url:"", html:"", css:"", mediaUrl:"", mediaType:"image", audio:{ enabled:true, volume:1, muted:false, monitor:"output" } };
}

function sanitiseSlot(raw = {}) {
  const s = raw && typeof raw === "object" ? raw : {};
  const mediaUrl = safeUrl(s.mediaUrl);
  const id = value => (/^[A-Za-z0-9_-]{1,64}$/.test(String(value || "")) ? String(value) : null);
  const ids = s.sceneIds && typeof s.sceneIds === "object" ? s.sceneIds : {};
  return {
    mode:SLOT_MODES.includes(s.mode) ? s.mode : "builtin",
    sceneId:id(s.sceneId),
    // Optional separate scene per orientation (the 9:16 program uses
    // sceneIds.vertical); falls back to sceneId for both.
    sceneIds:{ landscape:id(ids.landscape), vertical:id(ids.vertical) },
    url:safeUrl(s.url),
    html:str(s.html, "", 100000),
    css:str(s.css, "", 50000),
    mediaUrl,
    mediaType:s.mediaType === "video" || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(mediaUrl) ? "video" : "image",
    audio:sanitiseAudio(s.audio ?? { enabled:true }, "browser"),
  };
}

function defaultMixer() {
  return Object.fromEntries(MIXER_BUSES.map(bus => [bus, { volume:bus === "browser" ? 1 : 1, muted:false, solo:false }]));
}

function sanitiseMixer(raw = {}, base = defaultMixer()) {
  const out = {};
  for (const bus of MIXER_BUSES) {
    const row = raw?.[bus] && typeof raw[bus] === "object" ? raw[bus] : {};
    const prev = base[bus] || { volume:1, muted:false, solo:false };
    out[bus] = { volume:num(row.volume, prev.volume, 0, 2), muted:bool(row.muted, prev.muted), solo:bool(row.solo, prev.solo) };
  }
  return out;
}

// Program sizes default to "auto": the hardware test picks the best size/FPS
// the host can render (see hardware-profile.js). Setting COMPOSITOR_WIDTH/
// HEIGHT in the environment pins the old fixed size instead.
function defaultPrograms() {
  const w = Number(process.env.COMPOSITOR_WIDTH || 1280), h = Number(process.env.COMPOSITOR_HEIGHT || 720), fps = Number(process.env.COMPOSITOR_FPS || 30);
  const lw = Math.max(w, h), lh = Math.min(w, h);
  const auto = !(process.env.COMPOSITOR_WIDTH && process.env.COMPOSITOR_HEIGHT);
  return {
    landscape:{ width:lw, height:lh, fps, bitrateKbps:null, auto },
    vertical:{ width:lh, height:lw, fps, bitrateKbps:null, auto },
  };
}

function sanitisePrograms(raw = {}, base = defaultPrograms()) {
  const out = {};
  for (const o of ORIENTATIONS) {
    const row = raw?.[o] && typeof raw[o] === "object" ? raw[o] : {};
    const prev = base[o];
    let width = Math.round(num(row.width, prev.width, 128, 3840));
    let height = Math.round(num(row.height, prev.height, 128, 3840));
    // Keep the orientation honest: a vertical program is taller than wide.
    if ((o === "vertical") !== (height > width)) [width, height] = [height, width];
    // Encoders want even dimensions.
    width -= width % 2; height -= height % 2;
    const bitrate = row.bitrateKbps == null || row.bitrateKbps === "" ? prev.bitrateKbps : Math.round(num(row.bitrateKbps, 0, 300, 50000));
    out[o] = { width, height, fps:Math.round(num(row.fps, prev.fps, 1, 60)), bitrateKbps:bitrate || null, auto:bool(row.auto, prev.auto ?? false) };
  }
  if (raw?.effects && ["auto", "full", "reduced", "minimal"].includes(raw.effects)) out.effects = raw.effects;
  else if (base.effects) out.effects = base.effects;
  return out;
}

function emptyLibrary() {
  const scenes = defaultScenes();
  return {
    version:VERSION,
    scenes,
    live:{ landscape:"scene_gameplay", vertical:"scene_vertical_gameplay" },
    slots:Object.fromEntries(SLOT_NAMES.map(name => [name, defaultSlot()])),
    mixer:defaultMixer(),
    programs:defaultPrograms(),
  };
}

// Create or upgrade account.sceneLibrary in place. Never removes user data;
// returns true when the account object changed and should be saved.
function ensure(account) {
  if (!account || typeof account !== "object") return false;
  let dirty = false;
  let lib = account.sceneLibrary;
  if (!lib || typeof lib !== "object" || Array.isArray(lib)) {
    lib = account.sceneLibrary = emptyLibrary();
    // Pre-existing Starting Soon settings, background URLs, countdowns etc.
    // stay in overlayConfig and are still used by the builtin slot mode.
    return true;
  }
  if (!Array.isArray(lib.scenes)) { lib.scenes = []; dirty = true; }
  if (!lib.scenes.length) { lib.scenes = defaultScenes(); dirty = true; }
  for (const o of ORIENTATIONS) {
    if (!lib.scenes.some(s => s.orientation === o)) {
      lib.scenes.push(...defaultScenes().filter(s => s.orientation === o && !lib.scenes.some(x => x.id === s.id)));
      dirty = true;
    }
  }
  if (!lib.live || typeof lib.live !== "object") { lib.live = {}; dirty = true; }
  for (const o of ORIENTATIONS) {
    const current = lib.scenes.find(s => s.id === lib.live[o] && s.orientation === o);
    if (!current) { lib.live[o] = lib.scenes.find(s => s.orientation === o)?.id || null; dirty = true; }
  }
  if (!lib.slots || typeof lib.slots !== "object") { lib.slots = {}; dirty = true; }
  for (const name of SLOT_NAMES) if (!lib.slots[name]) { lib.slots[name] = defaultSlot(); dirty = true; }
  if (!lib.mixer) { lib.mixer = defaultMixer(); dirty = true; }
  if (!lib.programs) { lib.programs = defaultPrograms(); dirty = true; }
  // Libraries saved before hardware-tested Auto sizes existed: switch them to
  // Auto unless the operator pinned a size through the environment.
  for (const o of ORIENTATIONS) {
    if (lib.programs[o] && lib.programs[o].auto === undefined) { lib.programs[o].auto = defaultPrograms()[o].auto; dirty = true; }
  }
  if (Number(lib.version || 0) < VERSION) { lib.version = VERSION; dirty = true; }
  return dirty;
}

function library(account) {
  ensure(account);
  return account.sceneLibrary;
}

function findScene(account, sceneId) {
  return library(account).scenes.find(s => s.id === String(sceneId || "")) || null;
}

function liveScene(account, orientation) {
  const lib = library(account);
  const o = orientation === "vertical" ? "vertical" : "landscape";
  return lib.scenes.find(s => s.id === lib.live[o]) || lib.scenes.find(s => s.orientation === o) || null;
}

function createScene(account, raw = {}) {
  const lib = library(account);
  if (lib.scenes.length >= 100) throw Object.assign(new Error("scene limit reached (100)"), { status:400 });
  const base = raw.duplicateOf ? findScene(account, raw.duplicateOf) : null;
  const scene = sanitiseScene(base
    ? { ...JSON.parse(JSON.stringify(base)), name:raw.name || `${base.name} copy`, id:undefined, layers:base.layers.map(l => ({ ...l, id:undefined })) }
    : { name:raw.name || "New scene", kind:raw.kind || "custom", orientation:raw.orientation, canvas:raw.canvas, layers:raw.layers || (raw.withProgram === false ? [] : [programLayer(canvasFor(raw.orientation, raw.canvas), { fit:raw.orientation === "vertical" ? "fill" : "fit" })]) },
  { keepId:false });
  lib.scenes.push(scene);
  return scene;
}

function updateScene(account, sceneId, patch = {}) {
  const lib = library(account);
  const index = lib.scenes.findIndex(s => s.id === String(sceneId));
  if (index < 0) return null;
  const current = lib.scenes[index];
  const next = sanitiseScene({
    ...current,
    ...(patch.name !== undefined ? { name:patch.name } : {}),
    ...(patch.kind !== undefined ? { kind:patch.kind } : {}),
    ...(patch.canvas !== undefined ? { canvas:patch.canvas } : {}),
    ...(patch.layers !== undefined ? { layers:patch.layers } : {}),
    // Orientation is fixed per scene: changing it would silently re-lay-out
    // every layer. Duplicate into the other orientation instead.
    orientation:current.orientation,
    createdAt:current.createdAt,
  });
  lib.scenes[index] = next;
  return next;
}

function deleteScene(account, sceneId) {
  const lib = library(account);
  const scene = findScene(account, sceneId);
  if (!scene) return false;
  if (lib.scenes.filter(s => s.orientation === scene.orientation).length <= 1) {
    throw Object.assign(new Error(`keep at least one ${scene.orientation === "vertical" ? "9:16" : "16:9"} scene`), { status:409 });
  }
  lib.scenes = lib.scenes.filter(s => s.id !== scene.id);
  for (const o of ORIENTATIONS) if (lib.live[o] === scene.id) lib.live[o] = lib.scenes.find(s => s.orientation === o)?.id || null;
  for (const name of SLOT_NAMES) {
    const slot = lib.slots[name];
    if (!slot) continue;
    const ids = { ...(slot.sceneIds || {}) };
    for (const o of ORIENTATIONS) if (ids[o] === scene.id) ids[o] = null;
    const sceneId = slot.sceneId === scene.id ? (ids.landscape || ids.vertical || null) : slot.sceneId;
    lib.slots[name] = { ...slot, sceneIds:ids, sceneId, ...(slot.mode === "scene" && !sceneId ? { mode:"builtin" } : {}) };
  }
  return true;
}

function setLive(account, orientation, sceneId) {
  const lib = library(account);
  const scene = findScene(account, sceneId);
  if (!scene) throw Object.assign(new Error("unknown scene"), { status:404 });
  const o = orientation === "vertical" ? "vertical" : orientation === "landscape" ? "landscape" : scene.orientation;
  if (scene.orientation !== o) throw Object.assign(new Error(`scene is ${scene.orientation}, not ${o}`), { status:400 });
  lib.live[o] = scene.id;
  return { orientation:o, sceneId:scene.id };
}

function setSlot(account, name, raw) {
  if (!SLOT_NAMES.includes(name)) throw Object.assign(new Error(`slot must be one of ${SLOT_NAMES.join(", ")}`), { status:400 });
  const slot = sanitiseSlot(raw);
  if (slot.mode === "scene") {
    for (const o of ORIENTATIONS) if (slot.sceneIds[o] && !findScene(account, slot.sceneIds[o])) slot.sceneIds[o] = null;
    if (slot.sceneId && !findScene(account, slot.sceneId)) slot.sceneId = null;
    if (!slot.sceneId) slot.sceneId = slot.sceneIds.landscape || slot.sceneIds.vertical || null;
    if (!slot.sceneId) throw Object.assign(new Error("unknown scene for slot"), { status:404 });
  }
  if (slot.mode === "url" && !slot.url) throw Object.assign(new Error("a valid http(s) URL is required"), { status:400 });
  if (slot.mode === "media" && !slot.mediaUrl) throw Object.assign(new Error("a valid http(s) image or video URL is required"), { status:400 });
  library(account).slots[name] = slot;
  return slot;
}

// Editable layered versions of Starting Soon / BRB / Ending / Offline. Built
// from the text the user already configured for the built-in scene, split
// into separate layers (background, title, subtitle, countdown, socials,
// clock, Now Playing) so every part can be moved, restyled or deleted.
const SLOT_TITLES = { startingSoon:"Starting Soon", brb:"BRB", ending:"Ending", offline:"Offline" };
const SLOT_DEFAULTS = {
  startingSoon:{ title:"Starting Soon", subtitle:"Stream begins shortly · stand by", accent:"#00f0ff" },
  brb:{ title:"BRB", subtitle:"Be right back", accent:"#8a2bff" },
  ending:{ title:"Thanks for watching", subtitle:"Stream over · see you next time", accent:"#ff2bd6" },
  offline:{ title:"OFFLINE", subtitle:"Channel is not live right now", accent:"#4ade80" },
};

function slotTemplateLayers(name, orientation, overlayConfig = {}) {
  const canvas = canvasFor(orientation);
  const W = canvas.width, H = canvas.height, v = orientation === "vertical";
  const cfg = { ...SLOT_DEFAULTS[name], ...Object.fromEntries(Object.entries(overlayConfig?.[name] || {}).filter(([, val]) => val !== "" && val != null)) };
  const accent = safeColor(cfg.accent, SLOT_DEFAULTS[name].accent);
  const text = (id, label, textValue, y, h, size, extra = {}) => ({ id, type:"text", name:label, x:Math.round(W * 0.05), y:Math.round(y), width:Math.round(W * 0.9), height:Math.round(h), config:{ text:textValue, fontSize:size, fontWeight:extra.weight || 800, color:extra.color || "#ffffff", align:"center", shadow:true } });
  const layers = [
    { id:`${name}_bg`, type:"gradient", name:"Background", x:0, y:0, width:W, height:H, config:{ from:"#05060a", to:accent, angle:v ? 180 : 135 } },
  ];
  if (cfg.backgroundUrl) layers.push({ id:`${name}_image`, type:"image", name:"Background image", x:0, y:0, width:W, height:H, opacity:0.55, config:{ src:cfg.backgroundUrl, fit:"cover" } });
  layers.push(
    text(`${name}_title`, "Title", cfg.title, H * (v ? 0.30 : 0.30), H * (v ? 0.12 : 0.2), v ? 120 : 140),
    text(`${name}_subtitle`, "Subtitle", cfg.subtitle || "", H * (v ? 0.43 : 0.52), H * 0.08, v ? 46 : 48, { weight:500, color:"#e6f7ff" }),
  );
  if (name === "startingSoon") {
    layers.push({ ...text(`${name}_countdown`, "Countdown", `${cfg.countdownLabel || "Live in"} `, H * (v ? 0.52 : 0.64), H * (v ? 0.07 : 0.12), v ? 72 : 80, { color:accent }), type:"countdown", config:{ text:`${cfg.countdownLabel || "Live in"} `, fontSize:v ? 72 : 80, fontWeight:800, color:accent, align:"center", shadow:true, countdownMinutes:Number(cfg.countdownMinutes) || 5, doneText:"Starting now" } });
  }
  if (name === "ending") {
    const socials = [["Twitch", cfg.twitch], ["YouTube", cfg.youtube], ["X", cfg.twitter], ["Discord", cfg.discord]].filter(([, val]) => val).map(([k, val]) => `${k}: ${val}`).join(v ? "\n" : "   ·   ");
    if (socials) layers.push(text(`${name}_socials`, "Socials", socials, H * (v ? 0.55 : 0.66), H * (v ? 0.16 : 0.08), v ? 40 : 38, { weight:600 }));
  }
  if (name !== "offline") layers.push({ id:`${name}_nowplaying`, type:"nowplaying", name:"Now Playing", x:Math.round(v ? W * 0.1 : W * 0.72), y:Math.round(v ? H * 0.8 : H * 0.84), width:Math.round(v ? W * 0.8 : W * 0.25), height:Math.round(v ? W * 0.8 * 0.24 : W * 0.25 * 0.24), config:{} });
  layers.push({ id:`${name}_clock`, type:"clock", name:"Clock", x:Math.round(W * 0.03), y:Math.round(H * 0.03), width:Math.round(W * (v ? 0.4 : 0.15)), height:Math.round(H * 0.06), config:{ text:"", fontSize:v ? 44 : 36, fontWeight:700, color:"#ffffff", align:"left", format:"24h" } });
  return layers;
}

// Layers for a slot that is being turned into its own scene. A slot that used
// a StreamElements/browser URL, HTML or media keeps it as a layer: full canvas
// on 16:9, and on 9:16 rendered at 1920x1080 and scaled to the canvas width in
// the middle (then freely movable), instead of squeezing the 16:9 page.
function slotConversionLayers(name, orientation, slot, overlayConfig) {
  const canvas = canvasFor(orientation);
  const W = canvas.width, H = canvas.height, v = orientation === "vertical";
  const band = v ? { x:0, y:Math.round((H - W * 9 / 16) / 2), width:W, height:Math.round(W * 9 / 16) } : { x:0, y:0, width:W, height:H };
  const bg = { id:`${name}_bg`, type:"gradient", name:"Background", x:0, y:0, width:W, height:H, config:{ from:"#05060a", to:SLOT_DEFAULTS[name].accent, angle:180 } };
  if (slot?.mode === "url" && slot.url) {
    return [...(v ? [bg] : []), { id:`${name}_browser`, type:BROWSER_TYPES.includes("streamelements") && /streamelements\./i.test(slot.url) ? "streamelements" : "browser", name:/streamelements\./i.test(slot.url) ? "StreamElements scene" : "Browser scene", ...band, config:{ url:slot.url, transparent:false, background:"#05060a", renderWidth:1920, renderHeight:1080 }, audio:slot.audio }];
  }
  if (slot?.mode === "media" && slot.mediaUrl) {
    return [...(v ? [bg] : []), slot.mediaType === "video"
      ? { id:`${name}_video`, type:"video", name:"Scene video", ...band, config:{ src:slot.mediaUrl, fit:"cover", loop:true }, audio:slot.audio }
      : { id:`${name}_image`, type:"image", name:"Scene image", ...band, config:{ src:slot.mediaUrl, fit:"cover" } }];
  }
  if (slot?.mode === "html") {
    return [{ id:`${name}_html`, type:"html", name:"Scene HTML", x:0, y:0, width:W, height:H, config:{ html:slot.html, css:slot.css }, audio:slot.audio }];
  }
  return slotTemplateLayers(name, orientation, overlayConfig);
}

// Create (once) the layered 16:9 and 9:16 scenes for a slot, switch the slot
// to them and return them. Existing custom scenes are kept, not overwritten.
function customiseSlot(account, name, overlayConfig = account?.overlayConfig) {
  if (!SLOT_NAMES.includes(name)) throw Object.assign(new Error(`slot must be one of ${SLOT_NAMES.join(", ")}`), { status:400 });
  const lib = library(account);
  const slot = lib.slots[name] || defaultSlot();
  const ids = { ...(slot.sceneIds || {}) };
  for (const o of ORIENTATIONS) {
    if (ids[o] && findScene(account, ids[o])?.orientation === o) continue;
    const legacy = slot.sceneId && findScene(account, slot.sceneId);
    if (legacy && legacy.orientation === o) { ids[o] = legacy.id; continue; }
    const scene = sanitiseScene({ name:`${SLOT_TITLES[name]}${o === "vertical" ? " (9:16)" : ""}`, kind:"intermission", orientation:o, layers:slotConversionLayers(name, o, slot, overlayConfig) }, { keepId:false });
    lib.scenes.push(scene);
    ids[o] = scene.id;
  }
  lib.slots[name] = { ...slot, mode:"scene", sceneIds:ids, sceneId:ids.landscape };
  return { slot:lib.slots[name], scenes:ORIENTATIONS.map(o => findScene(account, ids[o])) };
}

function setMixer(account, raw) {
  const lib = library(account);
  lib.mixer = sanitiseMixer(raw, lib.mixer);
  return lib.mixer;
}

function setPrograms(account, raw) {
  const lib = library(account);
  lib.programs = sanitisePrograms(raw, lib.programs);
  return lib.programs;
}

// Does anything that can be put on air need browser-source audio capture?
function libraryNeedsBrowserAudio(account) {
  const lib = library(account);
  const layerAudio = layer => layer.visible !== false && AUDIO_TYPES.includes(layer.type) && layer.audio?.enabled && !layer.audio?.muted && layer.audio?.monitor !== "off";
  if (lib.scenes.some(scene => scene.layers.some(layerAudio))) return true;
  return SLOT_NAMES.some(name => {
    const slot = lib.slots[name];
    return (slot?.mode === "url" || slot?.mode === "html" || (slot?.mode === "media" && slot.mediaType === "video")) && slot.audio?.enabled && !slot.audio?.muted;
  });
}

module.exports = {
  VERSION,
  ORIENTATIONS,
  CANVAS_PRESETS,
  LAYER_TYPES,
  BROWSER_TYPES,
  AUDIO_TYPES,
  SLOT_NAMES,
  SLOT_MODES,
  SCENE_KINDS,
  PROGRAM_FITS,
  MONITOR_MODES,
  MIXER_BUSES,
  uid,
  safeUrl,
  isLoopbackUrl,
  safeColor,
  canvasFor,
  sanitiseLayer,
  sanitiseScene,
  sanitiseSlot,
  sanitiseMixer,
  sanitisePrograms,
  sanitiseProgram,
  defaultScenes,
  emptyLibrary,
  ensure,
  library,
  findScene,
  liveScene,
  createScene,
  updateScene,
  deleteScene,
  setLive,
  setSlot,
  customiseSlot,
  slotTemplateLayers,
  setMixer,
  setPrograms,
  libraryNeedsBrowserAudio,
};
