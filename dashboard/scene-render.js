"use strict";

// Server-side program renderer for the Overlay Studio scene model.
//
// resolveProgram() turns "what is on air for this orientation" into a flat
// render model: the live library scene, or the Starting Soon / BRB / Ending /
// Offline slot source when one of those is active, plus legacy layers
// (custom overlay scene, Now Playing widget) so existing setups look the same.
//
// programPage() is the page the headless compositor (and the dashboard
// preview) loads. It keeps every layer keyed by id + content hash, so a scene
// edit or switch only replaces layers whose content changed: moving a layer,
// changing its volume or reordering never reloads a StreamElements iframe
// (which would drop its alert websocket).

const crypto = require("node:crypto");
const { escapeHtml, page, scenePerfCss, normaliseEffects } = require("./scenes");
const sceneModel = require("./scene-model");

const SLOT_ROUTES = { startingSoon:"starting-soon", brb:"brb", ending:"ending", offline:"offline" };
const CORNERS = { br:{ x:1, y:1 }, bl:{ x:0, y:1 }, tr:{ x:1, y:0 }, tl:{ x:0, y:0 } };

function hashOf(value) {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function attr(value) {
  return escapeHtml(value == null ? "" : String(value));
}

function loginPath(login) {
  return `/overlay/${encodeURIComponent(login)}`;
}

function sandboxFor(url) {
  // Cross-origin browser sources keep their OWN origin (cookies/localStorage
  // for StreamElements) with allow-same-origin; that grants nothing towards
  // CastNexus because the origins differ. A loopback URL would share our
  // origin, so it only gets an opaque origin.
  return sceneModel.isLoopbackUrl(url) ? "allow-scripts allow-presentation" : "allow-scripts allow-same-origin allow-presentation";
}

function audioAttrs(layer) {
  const a = layer.audio || {};
  const audible = sceneModel.AUDIO_TYPES.includes(layer.type) && a.enabled && !a.muted && a.monitor !== "off";
  return ` data-cn-audio="${audible ? 1 : 0}" data-cn-volume="${attr(Math.max(0, Math.min(2, Number(a.volume ?? 1))))}" data-cn-muted="${a.muted ? 1 : 0}"`;
}

function textStyle(c) {
  return [
    `font-size:${Number(c.fontSize) || 48}px`,
    `font-weight:${Number(c.fontWeight) || 700}`,
    c.fontFamily ? `font-family:${attr(c.fontFamily)},system-ui,sans-serif` : "",
    `color:${attr(c.color || "#fff")}`,
    `text-align:${attr(c.align || "center")}`,
    `justify-content:${c.align === "left" ? "flex-start" : c.align === "right" ? "flex-end" : "center"}`,
    c.shadow !== false ? "text-shadow:0 2px 12px rgba(0,0,0,.7)" : "",
    c.background && c.background !== "transparent" ? `background:${attr(c.background)}` : "",
  ].filter(Boolean).join(";");
}

// Inner HTML for one layer. Everything positional lives on the wrapper so it
// can change without touching this content.
function layerContent(layer, ctx) {
  const c = layer.config || {};
  const preview = !!ctx.preview;
  const liveContent = ctx.liveContent !== false;
  switch (layer.type) {
    case "program":
      return `<div class="cn-program"><video class="cn-program-video" muted autoplay playsinline></video>${preview ? `<div class="cn-program-empty">GAMEPLAY / OBS PROGRAM</div>` : ""}</div>`;
    case "browser": case "streamelements": case "streamlabs": case "webpage": case "iframe": case "chat": case "alertbox": {
      if (!c.url) return preview ? `<div class="cn-placeholder">${attr(layer.name)}<small>No URL set</small></div>` : "";
      if (!liveContent) return `<div class="cn-placeholder">${attr(layer.name)}<small>${attr(new URL(c.url).hostname)}</small></div>`;
      const bg = c.transparent === false ? attr(c.background || "#05060a") : "transparent";
      return `<iframe class="cn-frame" src="${attr(c.url)}" title="${attr(layer.name)}" sandbox="${sandboxFor(c.url)}" allow="autoplay; encrypted-media" referrerpolicy="no-referrer-when-downgrade" loading="eager" style="background:${bg}"${audioAttrs(layer)}></iframe>`;
    }
    case "image": case "gif":
      return c.src ? `<img class="cn-media" src="${attr(c.src)}" alt="" style="object-fit:${attr(c.fit || "cover")}">` : (preview ? `<div class="cn-placeholder">${attr(layer.name)}<small>No image URL</small></div>` : "");
    case "background":
      return `<div class="cn-fill" style="background:${attr(c.color || "#05060a")}">${c.src ? `<img class="cn-media" src="${attr(c.src)}" alt="" style="object-fit:${attr(c.fit || "cover")}">` : ""}</div>`;
    case "video":
      return c.src ? `<video class="cn-media" src="${attr(c.src)}" autoplay playsinline ${c.loop !== false ? "loop" : ""} ${layer.audio?.enabled && !layer.audio?.muted ? "" : "muted"} style="object-fit:${attr(c.fit || "cover")}"${audioAttrs(layer)}></video>` : (preview ? `<div class="cn-placeholder">${attr(layer.name)}<small>No video URL</small></div>` : "");
    case "text":
      return `<div class="cn-text" style="${textStyle(c)}">${escapeHtml(c.text || "")}</div>`;
    case "clock":
      return `<div class="cn-text" data-cn-clock="${attr(c.format || "24h")}" data-cn-tz="${attr(c.timeZone || "")}" style="${textStyle(c)}">${escapeHtml(c.text || "")}<span class="cn-clock-value">--:--</span></div>`;
    case "countdown": {
      const target = c.countdownAt || (c.countdownMinutes > 0 ? new Date(Date.now() + c.countdownMinutes * 60000).toISOString() : "");
      return `<div class="cn-text" data-cn-countdown="${attr(target)}" data-cn-done="${attr(c.doneText || "")}" style="${textStyle(c)}">${escapeHtml(c.text || "")}<span class="cn-countdown-value">00:00</span></div>`;
    }
    case "color":
      return `<div class="cn-fill" style="background:${attr(c.color || "#7c5cff")}"></div>`;
    case "gradient":
      return `<div class="cn-fill" style="background:linear-gradient(${Number(c.angle) || 135}deg,${attr(c.from || "#7c5cff")},${attr(c.to || "#ff2bd6")})"></div>`;
    case "webcam":
      return `<div class="cn-webcam" style="border:${Number(c.borderWidth) || 0}px solid ${attr(c.borderColor || "#00f0ff")};border-radius:${Number(c.radius) || 0}px;${c.glow !== false ? `box-shadow:0 0 28px ${attr(c.borderColor || "#00f0ff")}66,inset 0 0 18px ${attr(c.borderColor || "#00f0ff")}33` : ""}">${c.label ? `<span class="cn-webcam-label" style="background:${attr(c.borderColor || "#00f0ff")}">${escapeHtml(c.label)}</span>` : ""}</div>`;
    case "html": {
      // User HTML runs in an opaque-origin sandbox: scripts work, but it can
      // not read the CastNexus page, cookies or dashboard APIs.
      const doc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}${String(c.css || "").replace(/<\/style/gi, "<\\/style")}</style></head><body>${c.html || ""}</body></html>`;
      return liveContent ? `<iframe class="cn-frame" sandbox="allow-scripts" allow="autoplay" srcdoc="${attr(doc)}" style="background:transparent"${audioAttrs(layer)}></iframe>` : `<div class="cn-placeholder">${attr(layer.name)}<small>Custom HTML</small></div>`;
    }
    case "css":
      return "";
    case "music":
      return ctx.musicUrl ? `<iframe class="cn-frame cn-trusted" src="${attr(`${ctx.musicUrl}${ctx.musicUrl.includes("?") ? "&" : "?"}effects=${encodeURIComponent(c.effects || ctx.effects || "reduced")}&layout=${encodeURIComponent(ctx.orientation)}`)}" allow="autoplay"></iframe>` : (preview ? `<div class="cn-placeholder">${attr(layer.name)}<small>No music profile</small></div>` : "");
    case "nowplaying":
      return `<iframe class="cn-frame cn-trusted" src="${attr(`${loginPath(ctx.login)}/widget/nowplaying?fill=1`)}" allow="autoplay" style="background:transparent"></iframe>`;
    case "castnexus":
      // Internal: CastNexus' own pages (built-in scenes, legacy overlays).
      return `<iframe class="cn-frame cn-trusted" src="${attr(c.url)}" allow="autoplay" style="background:transparent"></iframe>`;
    default:
      return "";
  }
}

function contentHash(layer) {
  // Box, audio levels and program framing are applied live; only a content
  // change (URL, HTML, text, type) re-creates the element.
  return hashOf({ t:layer.type, c:layer.config, a:layer.type === "video" ? !!(layer.audio?.enabled && !layer.audio?.muted) : undefined });
}

function renderLayer(layer, index, ctx) {
  return {
    id:layer.id,
    type:layer.type,
    hash:contentHash(layer),
    html:layerContent(layer, ctx),
    css:layer.type === "css" ? String(layer.config?.css || "").replace(/<\/style/gi, "<\\/style") : "",
    box:{ x:layer.x, y:layer.y, w:layer.width, h:layer.height, z:index + 1, opacity:layer.opacity ?? 1, rotation:layer.rotation || 0, visible:layer.visible !== false },
    audio:layer.audio || null,
    program:layer.type === "program" ? layer.program : undefined,
  };
}

function fullLayer(canvas, raw) {
  return { x:0, y:0, width:canvas.width, height:canvas.height, rotation:0, opacity:1, visible:true, locked:false, audio:{ enabled:false, volume:1, muted:false, monitor:"output" }, ...raw };
}

function effectsFor(account, requested) {
  if (requested) return normaliseEffects(requested);
  const lib = sceneModel.library(account);
  const pref = String(lib.programs?.effects || process.env.COMPOSITOR_EFFECTS || "auto").toLowerCase();
  if (pref !== "auto") return normaliseEffects(pref);
  // Software-rendered Chromium is the dominant compositor cost; only keep the
  // 60 Hz decorative animations when the operator forces GPU rasterisation.
  return String(process.env.COMPOSITOR_GPU || "").toLowerCase() === "true" ? "full" : "reduced";
}

// What is on air for one orientation right now.
function resolveProgram(account, orientation = "landscape", { sceneId = null, preview = false, effects = null, musicUrl = null, liveContent = true, ignoreSlot = false } = {}) {
  const o = orientation === "vertical" ? "vertical" : "landscape";
  const lib = sceneModel.library(account);
  const login = account.twitchLogin || "";
  const fx = effectsFor(account, effects);
  const cs = account.currentScene;
  const slotName = !ignoreSlot && cs?.kind === "builtin" && sceneModel.SLOT_NAMES.includes(cs.name) ? cs.name : null;
  let source = "live", layers, canvas, sceneRef = null;

  if (slotName) {
    const slot = lib.slots[slotName] || { mode:"builtin" };
    canvas = sceneModel.canvasFor(o);
    source = `slot:${slotName}:${slot.mode}`;
    if (slot.mode === "scene" && sceneModel.findScene(account, slot.sceneId)) {
      sceneRef = sceneModel.findScene(account, slot.sceneId);
      canvas = sceneRef.canvas;
      layers = sceneRef.layers;
    } else if (slot.mode === "url" && slot.url) {
      layers = [fullLayer(canvas, { id:`slot_${slotName}_url`, type:"browser", name:"Scene browser source", config:{ url:slot.url, transparent:false, background:"#05060a" }, audio:slot.audio })];
    } else if (slot.mode === "html") {
      layers = [fullLayer(canvas, { id:`slot_${slotName}_html`, type:"html", name:"Scene HTML", config:{ html:slot.html, css:slot.css }, audio:slot.audio })];
    } else if (slot.mode === "media" && slot.mediaUrl) {
      layers = [fullLayer(canvas, slot.mediaType === "video"
        ? { id:`slot_${slotName}_media`, type:"video", name:"Scene video", config:{ src:slot.mediaUrl, fit:"cover", loop:true }, audio:{ ...slot.audio, enabled:slot.audio?.enabled !== false } }
        : { id:`slot_${slotName}_media`, type:"background", name:"Scene image", config:{ src:slot.mediaUrl, fit:"cover", color:"#05060a" } })];
    } else {
      // Built-in CastNexus scene (unchanged look, including countdown and
      // optional active-profile scene music).
      const query = new URLSearchParams();
      if (fx !== "full") query.set("effects", fx);
      if (slotName === "startingSoon" && cs.countdownAt) query.set("at", cs.countdownAt);
      const route = `${loginPath(login)}/${SLOT_ROUTES[slotName]}${query.toString() ? `?${query}` : ""}`;
      layers = [fullLayer(canvas, { id:`slot_${slotName}_builtin`, type:"castnexus", name:"Built-in scene", config:{ url:route } })];
    }
  } else {
    sceneRef = (sceneId && sceneModel.findScene(account, sceneId)) || sceneModel.liveScene(account, o);
    canvas = sceneRef?.canvas || sceneModel.canvasFor(o);
    layers = sceneRef?.layers || [];
  }

  layers = [...layers];
  // Legacy custom overlay scene ("Show" on an HTML/text overlay) stays a
  // full-screen layer above the live scene, exactly as before.
  if (cs?.kind === "custom" && !slotName) {
    const overlay = (account.overlays || []).find(ov => ov.id === cs.overlayId && !ov.config?.system);
    if (overlay) layers.push(fullLayer(canvas, { id:`legacy_${overlay.id}`, type:"castnexus", name:overlay.name, config:{ url:`${loginPath(login)}/custom/${encodeURIComponent(overlay.slug)}` } }));
  }
  // Legacy Now Playing widget toggle.
  const np = account.overlayConfig?.nowPlaying;
  if (np?.enabled && !slotName) {
    const corner = CORNERS[np.corner] || CORNERS.br;
    const w = Math.round(canvas.width * (o === "vertical" ? 0.6 : 0.2)), h = Math.round(w * 0.24), m = Math.round(canvas.width * 0.02);
    layers.push({ id:"legacy_nowplaying", type:"nowplaying", name:"Now Playing", x:corner.x ? canvas.width - w - m : m, y:corner.y ? canvas.height - h - m : m, width:w, height:h, rotation:0, opacity:1, visible:true, config:{}, audio:{ enabled:false } });
  }

  const ctx = { login, preview, effects:fx, musicUrl, orientation:o, liveContent };
  const rendered = layers.map((layer, index) => renderLayer(layer, index, ctx));
  return {
    orientation:o,
    source,
    sceneId:sceneRef?.id || null,
    sceneName:sceneRef?.name || (slotName ? slotName : null),
    canvas:{ width:canvas.width, height:canvas.height },
    effects:fx,
    hasProgramVideo:rendered.some(layer => layer.type === "program" && layer.box.visible),
    browserAudio:rendered.some(layer => layer.html.includes('data-cn-audio="1"') && layer.box.visible),
    layers:rendered,
  };
}

const PROGRAM_CSS = `
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
  body.cn-transparent{background:transparent}
  #cn-stage{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden}
  .cn-layer{position:absolute;overflow:hidden;box-sizing:border-box}
  .cn-layer>*{width:100%;height:100%}
  .cn-frame{display:block;width:100%;height:100%;border:0}
  .cn-media{display:block;width:100%;height:100%}
  .cn-fill{position:relative;width:100%;height:100%}
  .cn-fill>.cn-media{position:absolute;inset:0}
  .cn-program{position:relative;width:100%;height:100%;overflow:hidden;background:#000}
  .cn-program-video{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill}
  .cn-program-empty{position:absolute;inset:0;display:grid;place-items:center;color:rgba(230,247,255,.35);font:700 28px/1.2 system-ui,sans-serif;letter-spacing:.2em;background:repeating-linear-gradient(45deg,#0b0d16 0 24px,#10131f 24px 48px)}
  .cn-program.cn-has-video .cn-program-empty{display:none}
  .cn-text{display:flex;align-items:center;width:100%;height:100%;box-sizing:border-box;padding:0 .3em;white-space:pre-wrap;line-height:1.1}
  .cn-webcam{box-sizing:border-box;width:100%;height:100%;position:relative}
  .cn-webcam-label{position:absolute;left:50%;bottom:-2px;transform:translate(-50%,50%);padding:4px 14px;border-radius:999px;color:#05060a;font:800 18px system-ui,sans-serif;letter-spacing:.08em;white-space:nowrap}
  .cn-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:100%;height:100%;box-sizing:border-box;border:2px dashed rgba(124,92,255,.6);background:rgba(124,92,255,.12);color:#e6e8ff;font:700 22px system-ui,sans-serif;text-align:center}
  .cn-placeholder small{font-weight:500;font-size:15px;opacity:.7}
  .cn-guides{position:absolute;inset:0;pointer-events:none;z-index:100000}
`;

function whepUrlFor(login) {
  return "/" + ["webrtc", "public", login, "whep"].map(encodeURIComponent).join("/");
}

// Client runtime. Kept dependency-free and small: it runs inside the
// server-side renderer on every program page.
function programRuntime({ login, orientation, dataUrl, eventsUrl, whepUrl, preview, guides }) {
  return `<script>(function(){
  var MODEL=JSON.parse(document.getElementById("cn-model").textContent);
  var ORIENT=${JSON.stringify(orientation)},DATA_URL=${JSON.stringify(dataUrl)},PREVIEW=${preview ? "true" : "false"},GUIDES=${JSON.stringify(guides || "")};
  var stage=document.getElementById("cn-stage"),stream=null,pc=null,whepWanted=false,fetching=null;
  function fit(){var W=MODEL.canvas.width,H=MODEL.canvas.height,s=Math.min(innerWidth/W,innerHeight/H),ox=(innerWidth-W*s)/2,oy=(innerHeight-H*s)/2;stage.style.width=W+"px";stage.style.height=H+"px";stage.style.transform="translate("+ox+"px,"+oy+"px) scale("+s+")"}
  function layoutProgram(wrap,settings){var v=wrap.querySelector(".cn-program-video");if(!v)return;var W=wrap.clientWidth,H=wrap.clientHeight,vw=v.videoWidth||1920,vh=v.videoHeight||1080,p=settings||{},c=p.crop||{},l=+c.left||0,r=+c.right||0,t=+c.top||0,b=+c.bottom||0;var cw=vw*Math.max(.05,1-l-r),ch=vh*Math.max(.05,1-t-b),sx,sy;if(p.fit==="stretch"){sx=W/cw;sy=H/ch}else{var s=p.fit==="fit"?Math.min(W/cw,H/ch):Math.max(W/cw,H/ch);sx=sy=s}var k=+p.scale||1;sx*=k;sy*=k;var dw=cw*sx,dh=ch*sy,x0=(W-dw)/2+(+p.offsetX||0)*W,y0=(H-dh)/2+(+p.offsetY||0)*H;v.style.width=vw*sx+"px";v.style.height=vh*sy+"px";v.style.left=(x0-l*vw*sx)+"px";v.style.top=(y0-t*vh*sy)+"px";v.style.clipPath="inset("+(t*100)+"% "+(r*100)+"% "+(b*100)+"% "+(l*100)+"%)"}
  function applyAudio(el,audio){var a=audio||{};var vol=a.muted?0:Math.max(0,Math.min(1,+(a.volume==null?1:a.volume)));el.querySelectorAll("[data-cn-audio]").forEach(function(n){n.setAttribute("data-cn-volume",String(a.volume==null?1:a.volume));n.setAttribute("data-cn-muted",a.muted?"1":"0");if(n.tagName==="VIDEO"){try{n.volume=vol;n.muted=!(a.enabled&&!a.muted)}catch(e){}}})}
  function apply(model){MODEL=model;fit();var keep={};Array.prototype.forEach.call(stage.querySelectorAll(":scope>.cn-layer"),function(el){keep[el.dataset.layerId]=el});var css=[];whepWanted=false;
    model.layers.forEach(function(layer){if(layer.css)css.push(layer.css);var el=keep[layer.id];delete keep[layer.id];if(!el||el.dataset.hash!==layer.hash){var next=document.createElement("div");next.className="cn-layer cn-type-"+layer.type;next.dataset.layerId=layer.id;next.dataset.hash=layer.hash;next.innerHTML=layer.html;if(el)stage.replaceChild(next,el);else stage.appendChild(next);el=next}
      var b=layer.box;el.style.left=b.x+"px";el.style.top=b.y+"px";el.style.width=b.w+"px";el.style.height=b.h+"px";el.style.zIndex=String(b.z);el.style.opacity=String(b.opacity);el.style.transform=b.rotation?"rotate("+b.rotation+"deg)":"";el.style.display=b.visible?"":"none";applyAudio(el,layer.audio);
      if(layer.type==="program"){whepWanted=whepWanted||b.visible;el._cnProgram=layer.program;attachStream(el);layoutProgram(el,layer.program)}});
    Object.keys(keep).forEach(function(id){keep[id].remove()});var style=document.getElementById("cn-layer-css");style.textContent=css.join("\\n");
    if(whepWanted)connectWhep();tickClocks()}
  function attachStream(el){var v=el.querySelector(".cn-program-video");if(!v)return;if(stream&&v.srcObject!==stream){v.srcObject=stream;v.play().catch(function(){})}v.onloadedmetadata=function(){el.querySelector(".cn-program").classList.add("cn-has-video");layoutProgram(el,el._cnProgram)}}
  function connectWhep(){if(pc||!${JSON.stringify(whepUrl)})return;pc=new RTCPeerConnection();pc.addTransceiver("video",{direction:"recvonly"});pc.addTransceiver("audio",{direction:"recvonly"});pc.ontrack=function(ev){stream=ev.streams[0];stage.querySelectorAll(".cn-type-program").forEach(attachStream)};pc.oniceconnectionstatechange=function(){if(pc&&(pc.iceConnectionState==="failed"||pc.iceConnectionState==="disconnected")){try{pc.close()}catch(e){}pc=null;setTimeout(function(){if(whepWanted)connectWhep()},3000)}};pc.createOffer().then(function(o){return pc.setLocalDescription(o)}).then(function(){return new Promise(function(res){if(pc.iceGatheringState==="complete")return res();pc.addEventListener("icegatheringstatechange",function f(){if(pc.iceGatheringState==="complete"){pc.removeEventListener("icegatheringstatechange",f);res()}});setTimeout(res,2500)})}).then(function(){return fetch(${JSON.stringify(whepUrl)},{method:"POST",headers:{"Content-Type":"application/sdp"},body:pc.localDescription.sdp})}).then(function(r){if(!r.ok)throw new Error("whep "+r.status);return r.text()}).then(function(sdp){return pc.setRemoteDescription({type:"answer",sdp:sdp})}).catch(function(){try{pc&&pc.close()}catch(e){}pc=null;setTimeout(function(){if(whepWanted)connectWhep()},3000)})}
  function pad(n){return String(n).padStart(2,"0")}
  function tickClocks(){var now=new Date();stage.querySelectorAll("[data-cn-clock]").forEach(function(el){var f=el.dataset.cnClock,tz=el.dataset.cnTz||undefined,opts={hour:"2-digit",minute:"2-digit",hour12:f.indexOf("12h")===0};if(f.indexOf("seconds")>0)opts.second="2-digit";try{if(tz)opts.timeZone=tz}catch(e){}var v=el.querySelector(".cn-clock-value");var label;try{label=now.toLocaleTimeString(f.indexOf("12h")===0?"en-US":"en-GB",opts)}catch(e){label=now.toLocaleTimeString()}if(v&&v.textContent!==label)v.textContent=label});
    stage.querySelectorAll("[data-cn-countdown]").forEach(function(el){var at=Date.parse(el.dataset.cnCountdown||""),v=el.querySelector(".cn-countdown-value");if(!v)return;var left=Math.max(0,Math.floor(((at||0)-Date.now())/1000));var label=!at?"--:--":left<=0&&el.dataset.cnDone?el.dataset.cnDone:(left>=3600?Math.floor(left/3600)+":"+pad(Math.floor(left%3600/60)):pad(Math.floor(left/60)))+":"+pad(left%60);if(v.textContent!==label)v.textContent=label})}
  function refresh(){if(fetching)return;fetching=fetch(DATA_URL,{cache:"no-store"}).then(function(r){return r.json()}).then(apply).catch(function(){}).finally(function(){fetching=null})}
  function drawGuides(){if(!PREVIEW||!GUIDES)return;var g=document.createElement("div");g.className="cn-guides";var W=MODEL.canvas.width,H=MODEL.canvas.height,v=H>W;g.innerHTML=v?'<svg width="100%" height="100%" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none"><rect x="'+W*.06+'" y="'+H*.14+'" width="'+W*.74+'" height="'+H*.62+'" fill="none" stroke="#00f0ff" stroke-width="4" stroke-dasharray="18 12"/><rect x="'+W*.84+'" y="'+H*.34+'" width="'+W*.14+'" height="'+H*.44+'" fill="rgba(255,43,214,.18)" stroke="#ff2bd6" stroke-width="3"/><rect x="0" y="'+H*.78+'" width="'+W+'" height="'+H*.22+'" fill="rgba(255,43,214,.14)" stroke="#ff2bd6" stroke-width="3"/><line x1="'+W/2+'" y1="0" x2="'+W/2+'" y2="'+H+'" stroke="#ffffff66" stroke-width="2"/><line x1="0" y1="'+H/2+'" x2="'+W+'" y2="'+H/2+'" stroke="#ffffff66" stroke-width="2"/></svg>':'<svg width="100%" height="100%" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none"><rect x="'+W*.05+'" y="'+H*.05+'" width="'+W*.9+'" height="'+H*.9+'" fill="none" stroke="#00f0ff" stroke-width="4" stroke-dasharray="18 12"/><line x1="'+W/2+'" y1="0" x2="'+W/2+'" y2="'+H+'" stroke="#ffffff66" stroke-width="2"/><line x1="0" y1="'+H/2+'" x2="'+W+'" y2="'+H/2+'" stroke="#ffffff66" stroke-width="2"/></svg>';stage.appendChild(g)}
  window.addEventListener("resize",function(){fit();stage.querySelectorAll(".cn-type-program").forEach(function(el){layoutProgram(el,el._cnProgram)})});
  apply(MODEL);drawGuides();setInterval(tickClocks,1000);
  try{var es=new EventSource(${JSON.stringify(eventsUrl)});es.onmessage=function(e){try{var m=JSON.parse(e.data);if(m.type==="program"&&(!m.orientation||m.orientation===ORIENT))refresh();else if(m.type==="scene")refresh()}catch(err){}}}catch(e){}
  setInterval(refresh,${Number(process.env.PROGRAM_PAGE_RESYNC_MS || 30000)});
})();</script>`;
}

function programDataUrl(login, orientation, query = "") {
  return `${loginPath(login)}/program/${orientation}/data.json${query ? `?${query}` : ""}`;
}

function programPage(login, model, { preview = false, guides = "", query = "" } = {}) {
  const orientation = model.orientation;
  const dataUrl = programDataUrl(login, orientation, query);
  // WHEP is only dialled when a visible Gameplay/OBS layer exists, so scenes
  // without gameplay (BRB, Starting Soon) do not decode the source at all.
  const body = `<style>${PROGRAM_CSS}${scenePerfCss(model.effects)}</style><style id="cn-layer-css"></style><div id="cn-stage"></div><script type="application/json" id="cn-model">${JSON.stringify(model).replace(/</g, "\\u003c")}</script>${programRuntime({ login, orientation, dataUrl, eventsUrl:`${loginPath(login)}/events`, whepUrl:whepUrlFor(login), preview, guides })}`;
  return page({ title:`Program ${orientation}`, body, transparent:false });
}

module.exports = {
  SLOT_ROUTES,
  hashOf,
  sandboxFor,
  layerContent,
  contentHash,
  renderLayer,
  effectsFor,
  resolveProgram,
  programPage,
  programDataUrl,
  whepUrlFor,
};
