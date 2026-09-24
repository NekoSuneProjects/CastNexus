"use strict";

// Overlay Studio: drag/drop scene editor for the server-side program output.
//
// The editor works on the scene library served by /api/scenes/library. It
// renders a lightweight representation of every layer in the dashboard (live
// browser content is optional, off by default, and only ever runs in the
// operator's own browser - never in the server renderer). The two program
// previews at the bottom load the exact pages the headless compositors load.

(function installOverlayStudio() {
  const ST = {
    lib:null,
    meta:null,
    orientation:"landscape",
    sceneId:null,
    selectedId:null,
    zoom:null,
    grid:true,
    snap:true,
    safe:true,
    live:false,
    reposition:false,
    saveTimer:null,
    mixerTimer:null,
    pending:false,
    history:[],
    future:[],
    keyHandler:null,
  };
  window.CastNexusStudio = ST;

  const GRID = 20;
  const SNAP_PX = 10;
  const LAYER_META = {
    program:{ icon:"▶", label:"Gameplay / OBS", desc:"The incoming OBS / console video. Crop, fit and reposition it per layout." },
    streamelements:{ icon:"⚡", label:"StreamElements", desc:"Overlay URL (alerts, goals, widgets) with its audio." },
    streamlabs:{ icon:"◆", label:"Streamlabs", desc:"Streamlabs widget / alert box URL." },
    browser:{ icon:"⊙", label:"Browser source", desc:"Any web page, rendered sandboxed." },
    alertbox:{ icon:"🔔", label:"Alert box", desc:"Alert widget URL with sound." },
    chat:{ icon:"💬", label:"Chat", desc:"Chat widget URL." },
    webpage:{ icon:"🌐", label:"Custom webpage", desc:"A web page as a layer." },
    iframe:{ icon:"▣", label:"iframe", desc:"Embed any http(s) page." },
    image:{ icon:"🖼", label:"Image", desc:"PNG / JPG / WebP by URL." },
    gif:{ icon:"✨", label:"Animated GIF", desc:"GIF by URL." },
    video:{ icon:"🎞", label:"Video", desc:"MP4 / WebM by URL, loops, optional audio." },
    text:{ icon:"T", label:"Text", desc:"Static text." },
    clock:{ icon:"🕒", label:"Clock", desc:"Local time, updates once a second." },
    countdown:{ icon:"⏳", label:"Countdown", desc:"Countdown to a time." },
    music:{ icon:"♫", label:"Music widget", desc:"The profile's music visualiser." },
    nowplaying:{ icon:"♪", label:"Now Playing", desc:"Current track card." },
    webcam:{ icon:"◯", label:"Webcam frame", desc:"Decorative frame to sit over your camera." },
    background:{ icon:"▭", label:"Background", desc:"Full-canvas colour or image." },
    color:{ icon:"■", label:"Colour block", desc:"Solid colour rectangle." },
    gradient:{ icon:"◩", label:"Gradient", desc:"Two-colour gradient." },
    html:{ icon:"</>", label:"Custom HTML", desc:"Your own HTML/CSS/JS in a sandbox." },
    css:{ icon:"#", label:"Custom CSS", desc:"Extra CSS applied to the program page." },
  };
  const ADD_ORDER = ["streamelements", "browser", "streamlabs", "alertbox", "chat", "program", "image", "gif", "video", "text", "html", "css", "music", "nowplaying", "clock", "countdown", "webcam", "background", "color", "gradient", "webpage", "iframe"];
  const BROWSER = ["browser", "streamelements", "streamlabs", "webpage", "iframe", "chat", "alertbox"];
  const AUDIO = [...BROWSER, "video", "html"];
  const SLOT_LABELS = { startingSoon:"Starting Soon", brb:"BRB", ending:"Ending", offline:"Offline" };
  const SLOT_MODE_LABELS = { builtin:"Built-in CastNexus scene", scene:"Overlay Studio scene", url:"StreamElements / browser URL", html:"Custom HTML scene", media:"Image / video background" };

  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const scenes = () => ST.lib?.scenes || [];
  const scene = () => scenes().find(s => s.id === ST.sceneId) || null;
  const layers = () => scene()?.layers || [];
  const selected = () => layers().find(l => l.id === ST.selectedId) || null;
  const login = () => encodeURIComponent(S.status?.twitchLogin || "");

  function newId() { return "l_" + Math.random().toString(16).slice(2, 14); }

  // ------------------------------------------------------------------ data
  async function loadLibrary() {
    const data = await api("/api/scenes/library");
    applyServer(data);
  }

  function applyServer(data) {
    if (!data?.library) return;
    ST.meta = data;
    // Never clobber an edit that is still waiting to be saved.
    if (!ST.pending) ST.lib = data.library;
    else ST.lib = { ...data.library, scenes:data.library.scenes.map(s => (s.id === ST.sceneId ? scene() || s : s)) };
    if (!scenes().some(s => s.id === ST.sceneId && s.orientation === ST.orientation)) {
      ST.sceneId = ST.lib.live?.[ST.orientation] || scenes().find(s => s.orientation === ST.orientation)?.id || null;
    }
  }

  function pushHistory() {
    const s = scene();
    if (!s) return;
    ST.history.push({ sceneId:s.id, layers:clone(s.layers) });
    if (ST.history.length > 60) ST.history.shift();
    ST.future = [];
  }

  function queueSave(delay = 450) {
    const s = scene();
    if (!s) return;
    ST.pending = true;
    clearTimeout(ST.saveTimer);
    const sceneId = s.id;
    ST.saveTimer = setTimeout(async () => {
      const current = scenes().find(x => x.id === sceneId);
      if (!current) return;
      try {
        const data = await api(`/api/scenes/library/scenes/${encodeURIComponent(sceneId)}`, { method:"PUT", body:{ layers:current.layers, name:current.name } });
        ST.pending = false;
        if (data?.scene) {
          const i = ST.lib.scenes.findIndex(x => x.id === sceneId);
          // Keep local object identity for the scene being edited so drag
          // state stays valid; only adopt server-normalised values.
          if (i >= 0) ST.lib.scenes[i] = data.scene;
        }
        ST.meta = { ...ST.meta, ...data, library:ST.lib };
        setSaveState("Saved · live outputs updated");
      } catch (error) {
        setSaveState(error.message, true);
      }
    }, delay);
    setSaveState("Saving…");
  }

  function setSaveState(text, bad = false) {
    const el = $("#studio-save-state");
    if (el) { el.textContent = text; el.style.color = bad ? "var(--red)" : ""; }
  }

  async function write(url, method, body, okMessage) {
    try {
      const data = await api(url, { method, body });
      applyServer(data);
      if (okMessage) toast(okMessage, "success");
      renderStudioInto();
      return data;
    } catch (error) {
      toast(error.message, "error");
      return null;
    }
  }

  // --------------------------------------------------------------- layout
  function fitZoom() {
    const wrap = $("#studio-canvas-wrap");
    const s = scene();
    if (!wrap || !s) return 0.4;
    const available = Math.max(200, wrap.clientWidth - 40);
    const maxHeight = Math.max(240, window.innerHeight * 0.62);
    return clamp(Math.min(available / s.canvas.width, maxHeight / s.canvas.height), 0.08, 2);
  }

  function zoom() { return ST.zoom || fitZoom(); }

  window.renderStudio = function renderStudio() {
    queueMicrotask(mountStudio);
    return `
      ${pageHead("SCENES · LAYERS · BROWSER SOURCES", "Overlay Studio", "Build horizontal and vertical scenes that CastNexus renders on the server, including StreamElements alerts with audio. Changes go live without restarting the stream.", `<button class="btn btn-ghost" id="studio-add-scene">＋ New scene</button><button class="btn btn-primary" id="studio-add-source">＋ Add source</button>`)}
      <div id="studio-root"><div class="card-panel"><p>Loading scene library…</p></div></div>`;
  };

  async function mountStudio() {
    if (S.page !== "studio") return;
    try {
      await loadLibrary();
    } catch (error) {
      const root = $("#studio-root");
      if (root) root.innerHTML = `<div class="card-panel"><div class="callout warn">Could not load the scene library: ${esc(error.message)}</div></div>`;
      return;
    }
    renderStudioInto();
    $("#studio-add-source")?.addEventListener("click", openAddSource);
    $("#studio-add-scene")?.addEventListener("click", () => openSceneModal());
  }

  function renderStudioInto() {
    const root = $("#studio-root");
    if (!root || !ST.lib) return;
    const s = scene();
    root.innerHTML = `
      <section class="studio-shell">
        <aside class="studio-side">${scenesPanel()}${programPanel()}${slotsPanel()}</aside>
        <div class="studio-center">
          ${toolbar()}
          <div id="studio-canvas-wrap" class="studio-canvas-wrap"><div id="studio-canvas-outer" class="studio-canvas-outer"><div id="studio-canvas" class="studio-canvas ${ST.grid ? "grid-on" : ""}" tabindex="0" style="--grid:${GRID}px"></div></div></div>
          <div class="studio-canvas-meta"><span>${s ? `${esc(s.name)} · ${s.canvas.width}×${s.canvas.height} · ${s.orientation === "vertical" ? "9:16" : "16:9"}` : "No scene"}</span><span id="studio-save-state">${ST.pending ? "Saving…" : "All changes saved"}</span></div>
        </div>
        <aside class="card-panel studio-props" id="studio-props">${propsPanel()}</aside>
      </section>
      <section class="studio-bottom">
        <div class="card-panel"><div class="card-title-row"><h3>Layers</h3><span class="badge">TOP → BOTTOM</span></div><div id="studio-layers" class="layer-list">${layersPanel()}</div></div>
        <div class="card-panel"><div class="card-title-row"><h3>Audio mixer</h3><span class="badge cyan">SERVER-SIDE</span></div>${mixerPanel()}</div>
      </section>
      <div class="section-title">Program output preview</div>
      <section class="card-panel">${previewsPanel()}</section>
      <div class="section-title">Program output settings</div>
      <section class="card-panel">${programSettingsPanel()}</section>`;
    drawCanvas();
    wireStudio();
  }

  function scenesPanel() {
    const list = scenes().filter(s => s.orientation === ST.orientation);
    const live = ST.lib.live?.[ST.orientation];
    return `<div class="card-panel">
      <div class="studio-tabs"><button class="studio-tab ${ST.orientation === "landscape" ? "active" : ""}" data-orient="landscape">16:9 Horizontal</button><button class="studio-tab ${ST.orientation === "vertical" ? "active" : ""}" data-orient="vertical">9:16 Vertical</button></div>
      <h3>Scenes</h3>
      <div class="scene-list">${list.map(s => `<div class="scene-item ${s.id === ST.sceneId ? "active" : ""}" data-scene-select="${esc(s.id)}"><span class="scene-name">${esc(s.name)}</span>${s.id === live ? `<span class="badge green">LIVE</span>` : ""}<span class="scene-item-actions"><button title="Switch live" data-scene-live="${esc(s.id)}">●</button><button title="Rename" data-scene-rename="${esc(s.id)}">✎</button><button title="Duplicate" data-scene-dup="${esc(s.id)}">⧉</button><button title="Delete" data-scene-del="${esc(s.id)}">×</button></span></div>`).join("")}</div>
      <p style="margin:10px 0 0">● switches what the <strong>${ST.orientation === "vertical" ? "vertical" : "horizontal"}</strong> gameplay program shows. No restart.</p>
    </div>`;
  }

  function programPanel() {
    const cs = ST.meta?.currentScene;
    const key = !cs || cs.kind === "none" ? "none" : cs.kind === "builtin" ? cs.name : "custom";
    const buttons = [["none", "Live / Gameplay"], ["startingSoon", "Starting Soon"], ["brb", "BRB"], ["ending", "Ending"], ["offline", "Offline"]];
    return `<div class="card-panel"><h3>On air</h3><div class="scene-buttons">${buttons.map(([k, label]) => `<button class="scene-button ${key === k ? "active" : ""}" data-program-switch="${k}">${esc(label)}</button>`).join("")}</div>
      <p style="margin:8px 0 0">Horizontal: <strong>${esc(ST.meta?.onAir?.landscape?.sceneName || "—")}</strong><br>Vertical: <strong>${esc(ST.meta?.onAir?.vertical?.sceneName || "—")}</strong></p></div>`;
  }

  function slotsPanel() {
    const slots = ST.lib.slots || {};
    return `<div class="card-panel"><h3>Starting Soon · BRB · Ending</h3>${Object.keys(SLOT_LABELS).map(name => {
      const slot = slots[name] || { mode:"builtin" };
      const detail = slot.mode === "scene" ? (scenes().find(s => s.id === slot.sceneId)?.name || "scene") : slot.mode === "url" ? (safeHost(slot.url) || "URL") : slot.mode === "media" ? (slot.mediaType === "video" ? "video" : "image") : slot.mode === "html" ? "custom HTML" : "default";
      return `<div class="slot-row"><div><strong>${SLOT_LABELS[name]}</strong><small>${esc(SLOT_MODE_LABELS[slot.mode] || slot.mode)} · ${esc(detail)}${slot.audio?.enabled && ["url", "html", "media"].includes(slot.mode) ? " · 🔊" : ""}</small></div><button class="btn btn-ghost btn-sm" data-slot-edit="${name}">Edit</button></div>`;
    }).join("")}</div>`;
  }

  function safeHost(url) { try { return new URL(url).hostname; } catch { return ""; } }

  function toolbar() {
    const sel = selected();
    return `<div class="studio-toolbar">
      <button class="tool-btn" data-zoom="out" title="Zoom out">−</button><button class="tool-btn" data-zoom="fit" title="Fit">${Math.round(zoom() * 100)}%</button><button class="tool-btn" data-zoom="in" title="Zoom in">＋</button>
      <span class="sep"></span>
      <button class="tool-btn ${ST.grid ? "on" : ""}" data-toggle="grid" title="Grid">Grid</button>
      <button class="tool-btn ${ST.snap ? "on" : ""}" data-toggle="snap" title="Snap to grid, edges and other layers">Snap</button>
      <button class="tool-btn ${ST.safe ? "on" : ""}" data-toggle="safe" title="Safe-area guides (editor only, never broadcast)">Safe area</button>
      <button class="tool-btn ${ST.live ? "on" : ""}" data-toggle="live" title="Render live browser content in the editor (runs in YOUR browser only)">Live content</button>
      <span class="sep"></span>
      <button class="tool-btn" data-align="hcenter" ${sel ? "" : "disabled"} title="Centre horizontally">⇔</button>
      <button class="tool-btn" data-align="vcenter" ${sel ? "" : "disabled"} title="Centre vertically">⇕</button>
      <button class="tool-btn" data-align="fill" ${sel ? "" : "disabled"} title="Fill canvas">⤢</button>
      <span class="sep"></span>
      <button class="tool-btn" data-order="up" ${sel ? "" : "disabled"} title="Bring forward">▲</button>
      <button class="tool-btn" data-order="down" ${sel ? "" : "disabled"} title="Send backward">▼</button>
      <button class="tool-btn" data-layer-dup ${sel ? "" : "disabled"} title="Duplicate (Ctrl+D)">⧉</button>
      <button class="tool-btn" data-layer-del ${sel ? "" : "disabled"} title="Delete (Del)">🗑</button>
      <span class="sep"></span>
      <button class="tool-btn" data-undo ${ST.history.length ? "" : "disabled"} title="Undo (Ctrl+Z)">↶</button>
      <button class="tool-btn" data-redo ${ST.future.length ? "" : "disabled"} title="Redo (Ctrl+Y)">↷</button>
      ${sel?.type === "program" ? `<span class="sep"></span><button class="tool-btn ${ST.reposition ? "on" : ""}" data-toggle="reposition" title="Drag the gameplay inside its box (or hold Alt while dragging)">✥ Reposition gameplay</button>` : ""}
    </div>`;
  }

  // --------------------------------------------------------------- canvas
  function layerInner(layer) {
    const c = layer.config || {};
    const meta = LAYER_META[layer.type] || { icon:"?", label:layer.type };
    const ph = sub => `<div class="st-placeholder" style="font-size:${Math.max(14, Math.min(layer.width, layer.height) / 9)}px"><span class="st-icon">${meta.icon}</span>${esc(layer.name)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
    const text = extra => `<div style="display:flex;align-items:center;justify-content:${c.align === "left" ? "flex-start" : c.align === "right" ? "flex-end" : "center"};width:100%;height:100%;font-size:${Number(c.fontSize) || 48}px;font-weight:${Number(c.fontWeight) || 700};color:${esc(c.color || "#fff")};${c.fontFamily ? `font-family:${esc(c.fontFamily)};` : ""}${c.shadow !== false ? "text-shadow:0 2px 12px rgba(0,0,0,.7);" : ""}${c.background && c.background !== "transparent" ? `background:${esc(c.background)};` : ""}white-space:pre-wrap;line-height:1.1">${esc(c.text || "")}${extra || ""}</div>`;
    switch (layer.type) {
      case "program": return `<div class="st-program">GAMEPLAY / OBS</div>`;
      case "color": return `<div style="width:100%;height:100%;background:${esc(c.color || "#7c5cff")}"></div>`;
      case "gradient": return `<div style="width:100%;height:100%;background:linear-gradient(${Number(c.angle) || 135}deg,${esc(c.from || "#7c5cff")},${esc(c.to || "#ff2bd6")})"></div>`;
      case "background": return `<div style="width:100%;height:100%;background:${esc(c.color || "#05060a")}">${c.src ? `<img src="${esc(c.src)}" style="object-fit:${esc(c.fit || "cover")}" alt="">` : ""}</div>`;
      case "image": case "gif": return c.src ? `<img src="${esc(c.src)}" style="object-fit:${esc(c.fit || "cover")}" alt="">` : ph("No image URL");
      case "video": return c.src && ST.live ? `<video src="${esc(c.src)}" muted autoplay loop playsinline style="object-fit:${esc(c.fit || "cover")}"></video>` : ph(c.src ? safeHost(c.src) : "No video URL");
      case "text": return text("");
      case "clock": return text(`<span data-st-clock>${new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}</span>`);
      case "countdown": return text("<span>05:00</span>");
      case "webcam": return `<div style="width:100%;height:100%;box-sizing:border-box;border:${Number(c.borderWidth) || 0}px solid ${esc(c.borderColor || "#00f0ff")};border-radius:${Number(c.radius) || 0}px;${c.glow !== false ? `box-shadow:0 0 28px ${esc(c.borderColor || "#00f0ff")}66` : ""}"></div>`;
      case "css": return ph("Custom CSS (not visible)");
      default:
        if (BROWSER.includes(layer.type)) {
          if (!c.url) return ph("No URL set");
          if (!ST.live) return ph(safeHost(c.url) + (layer.audio?.enabled && !layer.audio?.muted ? " · 🔊" : ""));
          return `<iframe src="${esc(c.url)}" sandbox="allow-scripts allow-same-origin" allow="autoplay" style="background:${c.transparent === false ? esc(c.background || "#05060a") : "transparent"}"></iframe>`;
        }
        if (layer.type === "html" && ST.live) return `<iframe sandbox="allow-scripts" srcdoc="${esc(`<!doctype html><style>html,body{margin:0;background:transparent}${c.css || ""}</style>${c.html || ""}`)}"></iframe>`;
        return ph(meta.desc);
    }
  }

  function boxStyle(layer, index) {
    return `left:${layer.x}px;top:${layer.y}px;width:${layer.width}px;height:${layer.height}px;z-index:${index + 1};opacity:${layer.visible === false ? 1 : layer.opacity ?? 1};${layer.rotation ? `transform:rotate(${layer.rotation}deg);` : ""}`;
  }

  function drawCanvas() {
    const s = scene();
    const canvas = $("#studio-canvas"), outer = $("#studio-canvas-outer");
    if (!canvas || !outer || !s) return;
    const z = zoom();
    outer.style.width = `${s.canvas.width * z}px`;
    outer.style.height = `${s.canvas.height * z}px`;
    canvas.style.width = `${s.canvas.width}px`;
    canvas.style.height = `${s.canvas.height}px`;
    canvas.style.transform = `scale(${z})`;
    canvas.innerHTML = s.layers.map((layer, i) => `<div class="st-layer ${layer.id === ST.selectedId ? "selected" : ""} ${layer.locked ? "locked" : ""} ${layer.visible === false ? "hidden-layer" : ""}" data-layer="${esc(layer.id)}" style="${boxStyle(layer, i)}"><div class="st-content">${layerInner(layer)}</div>${layer.id === ST.selectedId && !layer.locked ? handlesHtml() : ""}${layer.id === ST.selectedId && layer.type === "program" ? `<div class="st-program-frame" data-program-frame></div>` : ""}</div>`).join("") + safeHtml(s);
    if (selected()?.type === "program") drawProgramFrame();
  }

  function handlesHtml() {
    return ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map(h => {
      const pos = { nw:[0, 0], n:[50, 0], ne:[100, 0], e:[100, 50], se:[100, 100], s:[50, 100], sw:[0, 100], w:[0, 50] }[h];
      return `<span class="st-handle" data-h="${h}" style="left:${pos[0]}%;top:${pos[1]}%;transform:scale(${1 / zoom()})"></span>`;
    }).join("");
  }

  // Editor-only safe-area guides. They are drawn in the dashboard canvas and
  // never exist in the broadcast renderer.
  function safeHtml(s) {
    if (!ST.safe) return "";
    const W = s.canvas.width, H = s.canvas.height;
    if (s.orientation === "vertical") {
      return `<div class="st-safe"><div class="zone" style="left:${W * .06}px;top:${H * .14}px;width:${W * .74}px;height:${H * .62}px"></div><div class="block" style="left:${W * .84}px;top:${H * .34}px;width:${W * .14}px;height:${H * .44}px">UI</div><div class="block" style="left:0;top:${H * .78}px;width:${W}px;height:${H * .22}px">Captions · chat · buttons</div><div class="block" style="left:0;top:0;width:${W}px;height:${H * .08}px">Top bar</div><div class="centre-v"></div><div class="centre-h"></div></div>`;
    }
    return `<div class="st-safe"><div class="zone" style="left:${W * .05}px;top:${H * .05}px;width:${W * .9}px;height:${H * .9}px"></div><div class="centre-v"></div><div class="centre-h"></div></div>`;
  }

  // Where the gameplay video sits inside a program layer (assumes a 16:9
  // source, which is what OBS/consoles send; the renderer uses the real size).
  function programRect(layer, srcW = 1920, srcH = 1080) {
    const p = layer.program || {}, c = p.crop || {};
    const l = +c.left || 0, r = +c.right || 0, t = +c.top || 0, b = +c.bottom || 0;
    const cw = srcW * Math.max(.05, 1 - l - r), ch = srcH * Math.max(.05, 1 - t - b);
    const W = layer.width, H = layer.height;
    let sx, sy;
    if (p.fit === "stretch") { sx = W / cw; sy = H / ch; } else { const s = p.fit === "fit" ? Math.min(W / cw, H / ch) : Math.max(W / cw, H / ch); sx = sy = s; }
    const k = +p.scale || 1; sx *= k; sy *= k;
    const dw = cw * sx, dh = ch * sy;
    return { x:(W - dw) / 2 + (+p.offsetX || 0) * W, y:(H - dh) / 2 + (+p.offsetY || 0) * H, w:dw, h:dh };
  }

  function drawProgramFrame() {
    const layer = selected();
    const el = $(`[data-layer="${CSS.escape(layer.id)}"] [data-program-frame]`);
    if (!el) return;
    const r = programRect(layer);
    Object.assign(el.style, { left:`${r.x}px`, top:`${r.y}px`, width:`${r.w}px`, height:`${r.h}px` });
  }

  function updateBox(layer) {
    const el = $(`[data-layer="${CSS.escape(layer.id)}"]`);
    if (!el) return;
    const i = layers().indexOf(layer);
    el.setAttribute("style", boxStyle(layer, i));
    if (layer.type === "program") drawProgramFrame();
  }

  // ------------------------------------------------------------- snapping
  function snapMove(layer, x, y) {
    if (!ST.snap) return { x, y, guides:[] };
    const s = scene(), t = SNAP_PX / zoom();
    const xs = [0, s.canvas.width / 2, s.canvas.width], ys = [0, s.canvas.height / 2, s.canvas.height];
    for (const other of layers()) {
      if (other.id === layer.id || other.visible === false) continue;
      xs.push(other.x, other.x + other.width / 2, other.x + other.width);
      ys.push(other.y, other.y + other.height / 2, other.y + other.height);
    }
    const guides = [];
    const pick = (value, size, targets, axis) => {
      let best = null;
      for (const anchor of [0, size / 2, size]) for (const target of targets) {
        const d = target - (value + anchor);
        if (Math.abs(d) <= t && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, target };
      }
      if (best) { guides.push({ axis, at:best.target }); return value + best.d; }
      return ST.grid ? Math.round(value / GRID) * GRID : value;
    };
    return { x:pick(x, layer.width, xs, "v"), y:pick(y, layer.height, ys, "h"), guides };
  }

  function snapValue(v, targets) {
    if (!ST.snap) return v;
    const t = SNAP_PX / zoom();
    for (const target of targets) if (Math.abs(target - v) <= t) return target;
    return ST.grid ? Math.round(v / GRID) * GRID : v;
  }

  function showGuides(guides) {
    const canvas = $("#studio-canvas");
    if (!canvas) return;
    canvas.querySelectorAll(".st-guide").forEach(g => g.remove());
    for (const g of guides || []) {
      const el = document.createElement("div");
      el.className = `st-guide ${g.axis}`;
      el.style[g.axis === "v" ? "left" : "top"] = `${g.at}px`;
      el.style[g.axis === "v" ? "width" : "height"] = `${Math.max(1, 2 / zoom())}px`;
      canvas.appendChild(el);
    }
  }

  // ---------------------------------------------------------- interaction
  function canvasPoint(event) {
    const rect = $("#studio-canvas").getBoundingClientRect();
    const z = zoom();
    return { x:(event.clientX - rect.left) / z, y:(event.clientY - rect.top) / z };
  }

  function wireCanvas() {
    const canvas = $("#studio-canvas");
    if (!canvas) return;
    canvas.addEventListener("pointerdown", event => {
      const handle = event.target.closest(".st-handle");
      const box = event.target.closest(".st-layer");
      canvas.focus({ preventScroll:true });
      if (!box) { if (ST.selectedId) { ST.selectedId = null; refreshSelection(); } return; }
      const layer = layers().find(l => l.id === box.dataset.layer);
      if (!layer) return;
      if (ST.selectedId !== layer.id) { ST.selectedId = layer.id; refreshSelection(); }
      if (layer.locked) return;
      event.preventDefault();
      const start = canvasPoint(event);
      const origin = { x:layer.x, y:layer.y, w:layer.width, h:layer.height, program:clone(layer.program || {}) };
      const mode = handle ? `resize:${handle.dataset.h}` : (layer.type === "program" && (ST.reposition || event.altKey) ? "frame" : "move");
      let moved = false;
      pushHistory();
      canvas.setPointerCapture(event.pointerId);
      const onMove = e => {
        const p = canvasPoint(e);
        const dx = p.x - start.x, dy = p.y - start.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 1) return;
        moved = true;
        if (mode === "move") {
          const snapped = snapMove(layer, origin.x + dx, origin.y + dy);
          layer.x = Math.round(snapped.x); layer.y = Math.round(snapped.y);
          showGuides(snapped.guides);
        } else if (mode === "frame") {
          layer.program = { ...origin.program, offsetX:clamp((origin.program.offsetX || 0) + dx / layer.width, -2, 2), offsetY:clamp((origin.program.offsetY || 0) + dy / layer.height, -2, 2) };
        } else {
          resizeLayer(layer, origin, mode.slice(7), dx, dy, e.shiftKey);
        }
        updateBox(layer);
        syncPropsInputs(layer);
      };
      const onUp = () => {
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("pointercancel", onUp);
        showGuides([]);
        if (moved) { drawCanvas(); queueSave(); } else ST.history.pop();
      };
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", onUp);
      canvas.addEventListener("pointercancel", onUp);
    });
    canvas.addEventListener("dblclick", event => {
      const box = event.target.closest(".st-layer");
      const layer = box && layers().find(l => l.id === box.dataset.layer);
      if (layer?.type === "program") { ST.reposition = !ST.reposition; refreshSelection(); toast(ST.reposition ? "Drag to reposition the gameplay inside its box" : "Reposition off", "success"); }
    });
  }

  function resizeLayer(layer, o, h, dx, dy, keepAspect) {
    let { x, y, w, h:height } = { x:o.x, y:o.y, w:o.w, h:o.h };
    const s = scene();
    const xs = [0, s.canvas.width / 2, s.canvas.width, ...layers().filter(l => l.id !== layer.id).flatMap(l => [l.x, l.x + l.width])];
    const ys = [0, s.canvas.height / 2, s.canvas.height, ...layers().filter(l => l.id !== layer.id).flatMap(l => [l.y, l.y + l.height])];
    if (h.includes("e")) w = snapValue(o.x + o.w + dx, xs) - x;
    if (h.includes("s")) height = snapValue(o.y + o.h + dy, ys) - y;
    if (h.includes("w")) { const nx = snapValue(o.x + dx, xs); w = o.x + o.w - nx; x = nx; }
    if (h.includes("n")) { const ny = snapValue(o.y + dy, ys); height = o.y + o.h - ny; y = ny; }
    if (keepAspect && o.w && o.h) {
      const ratio = o.w / o.h;
      if (h === "n" || h === "s") w = height * ratio; else height = w / ratio;
      if (h.includes("w")) x = o.x + o.w - w;
      if (h.includes("n")) y = o.y + o.h - height;
    }
    layer.x = Math.round(x); layer.y = Math.round(y);
    layer.width = Math.max(8, Math.round(w)); layer.height = Math.max(8, Math.round(height));
  }

  function refreshSelection() {
    drawCanvas();
    const props = $("#studio-props");
    if (props) { props.innerHTML = propsPanel(); wireProps(); }
    const list = $("#studio-layers");
    if (list) { list.innerHTML = layersPanel(); wireLayerList(); }
    const tb = $(".studio-toolbar");
    if (tb) { tb.outerHTML = toolbar(); wireToolbar(); }
  }

  function wireKeyboard() {
    if (ST.keyHandler) document.removeEventListener("keydown", ST.keyHandler);
    ST.keyHandler = event => {
      if (S.page !== "studio") return;
      if (event.target.closest("input,textarea,select,[contenteditable]") || $("#modal-root")?.children.length) return;
      const layer = selected();
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key.toLowerCase() === "z") { event.preventDefault(); return undo(); }
      if (ctrl && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) { event.preventDefault(); return redo(); }
      if (!layer) return;
      if (ctrl && event.key.toLowerCase() === "d") { event.preventDefault(); return duplicateLayer(layer); }
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); return deleteLayer(layer); }
      const step = event.shiftKey ? 10 : 1;
      const moves = { ArrowLeft:[-step, 0], ArrowRight:[step, 0], ArrowUp:[0, -step], ArrowDown:[0, step] };
      if (moves[event.key] && !layer.locked) {
        event.preventDefault();
        pushHistory();
        layer.x += moves[event.key][0]; layer.y += moves[event.key][1];
        updateBox(layer); syncPropsInputs(layer); queueSave(600);
      }
    };
    document.addEventListener("keydown", ST.keyHandler);
  }

  function undo() {
    const entry = ST.history.pop();
    const s = entry && scenes().find(x => x.id === entry.sceneId);
    if (!s) return;
    ST.future.push({ sceneId:s.id, layers:clone(s.layers) });
    s.layers = entry.layers;
    if (!s.layers.some(l => l.id === ST.selectedId)) ST.selectedId = null;
    refreshSelection(); queueSave(200);
  }

  function redo() {
    const entry = ST.future.pop();
    const s = entry && scenes().find(x => x.id === entry.sceneId);
    if (!s) return;
    ST.history.push({ sceneId:s.id, layers:clone(s.layers) });
    s.layers = entry.layers;
    refreshSelection(); queueSave(200);
  }

  function duplicateLayer(layer) {
    pushHistory();
    const copy = { ...clone(layer), id:newId(), name:`${layer.name} copy`, x:layer.x + 30, y:layer.y + 30, locked:false };
    const list = layers();
    list.splice(list.indexOf(layer) + 1, 0, copy);
    ST.selectedId = copy.id;
    refreshSelection(); queueSave(200);
  }

  async function deleteLayer(layer) {
    if (!(await confirmAction("Delete layer", `Remove ${layer.name} from ${scene()?.name}?`))) return;
    pushHistory();
    scene().layers = layers().filter(l => l.id !== layer.id);
    ST.selectedId = null;
    refreshSelection(); queueSave(200);
  }

  function moveOrder(layer, direction) {
    const list = layers(), i = list.indexOf(layer), j = direction === "up" ? i + 1 : i - 1;
    if (j < 0 || j >= list.length) return;
    pushHistory();
    [list[i], list[j]] = [list[j], list[i]];
    refreshSelection(); queueSave(200);
  }

  // ------------------------------------------------------------- panels
  function field(label, html, full = false) { return `<div class="${full ? "full" : ""}"><label>${esc(label)}</label>${html}</div>`; }
  function num(id, value, attrs = "") { return `<input type="number" data-prop="${id}" value="${esc(value)}" ${attrs}>`; }
  function cfgInput(key, value, type = "text", attrs = "") { return `<input type="${type}" data-cfg="${key}" value="${esc(value ?? "")}" ${attrs}>`; }
  function rangeRow(attrName, key, value, min, max, step, fmt) { return `<div class="range-row"><input type="range" ${attrName}="${key}" min="${min}" max="${max}" step="${step}" value="${esc(value)}"><output>${fmt(value)}</output></div>`; }

  function propsPanel() {
    const layer = selected();
    if (!layer) {
      return `<h3>Properties</h3><p>Select a layer on the canvas or in the Layers list. Drag to move, use the handles to resize (Shift keeps the aspect ratio), arrow keys nudge 1 px (Shift = 10 px).</p><div class="callout">Browser sources are sandboxed: they cannot reach the dashboard, its APIs, the host or the Docker socket.</div>`;
    }
    const c = layer.config || {};
    const meta = LAYER_META[layer.type] || { label:layer.type };
    let html = `<div class="card-title-row"><h3>${esc(meta.icon || "")} ${esc(meta.label)}</h3><span class="badge">${esc(layer.type.toUpperCase())}</span></div><div class="props-grid">
      ${field("Name", `<input data-prop="name" value="${esc(layer.name)}">`, true)}
      ${field("X", num("x", layer.x))}${field("Y", num("y", layer.y))}
      ${field("Width", num("width", layer.width, 'min="1"'))}${field("Height", num("height", layer.height, 'min="1"'))}
      ${field("Rotation °", num("rotation", layer.rotation || 0, 'step="1"'))}${field("Opacity", rangeRow("data-prop", "opacity", layer.opacity ?? 1, 0, 1, 0.01, v => `${Math.round(v * 100)}%`))}
      <div class="full" style="display:flex;gap:14px"><label class="check-inline"><input type="checkbox" data-prop-bool="visible" ${layer.visible !== false ? "checked" : ""}> Visible</label><label class="check-inline"><input type="checkbox" data-prop-bool="locked" ${layer.locked ? "checked" : ""}> Locked</label></div>`;
    if (BROWSER.includes(layer.type)) {
      html += `<div class="props-section full">Source</div>${field(layer.type === "streamelements" ? "StreamElements overlay URL" : "URL", cfgInput("url", c.url, "url", 'placeholder="https://streamelements.com/overlay/…"'), true)}
        <label class="check-inline full"><input type="checkbox" data-cfg-bool="transparent" ${c.transparent !== false ? "checked" : ""}> Transparent background</label>
        <div class="full callout" style="margin:0">No StreamElements API key is needed - CastNexus renders the overlay URL like an OBS browser source.</div>`;
    }
    if (["image", "gif", "background"].includes(layer.type)) html += `<div class="props-section full">Image</div>${field("Image URL", cfgInput("src", c.src, "url", 'placeholder="https://…"'), true)}${field("Fit", `<select data-cfg="fit">${["cover", "contain", "fill"].map(v => `<option ${c.fit === v ? "selected" : ""}>${v}</option>`).join("")}</select>`)}${layer.type === "background" ? field("Colour", cfgInput("color", c.color || "#05060a", "color")) : ""}`;
    if (layer.type === "video") html += `<div class="props-section full">Video</div>${field("Video URL", cfgInput("src", c.src, "url", 'placeholder="https://…/loop.mp4"'), true)}${field("Fit", `<select data-cfg="fit">${["cover", "contain", "fill"].map(v => `<option ${c.fit === v ? "selected" : ""}>${v}</option>`).join("")}</select>`)}<label class="check-inline"><input type="checkbox" data-cfg-bool="loop" ${c.loop !== false ? "checked" : ""}> Loop</label>`;
    if (["text", "clock", "countdown"].includes(layer.type)) {
      html += `<div class="props-section full">Text</div>${field(layer.type === "text" ? "Text" : "Prefix text", `<textarea data-cfg="text" style="min-height:54px">${esc(c.text || "")}</textarea>`, true)}
        ${field("Font size", cfgInput("fontSize", c.fontSize || 48, "number", 'min="6" max="600"'))}${field("Weight", `<select data-cfg="fontWeight">${[300, 400, 500, 600, 700, 800, 900].map(v => `<option ${Number(c.fontWeight) === v ? "selected" : ""}>${v}</option>`).join("")}</select>`)}
        ${field("Colour", cfgInput("color", c.color || "#ffffff", "color"))}${field("Align", `<select data-cfg="align">${["left", "center", "right"].map(v => `<option ${c.align === v ? "selected" : ""}>${v}</option>`).join("")}</select>`)}
        ${field("Font family", cfgInput("fontFamily", c.fontFamily, "text", 'placeholder="Inter, sans-serif"'), true)}
        <label class="check-inline full"><input type="checkbox" data-cfg-bool="shadow" ${c.shadow !== false ? "checked" : ""}> Text shadow</label>`;
      if (layer.type === "clock") html += field("Format", `<select data-cfg="format">${["24h", "24h-seconds", "12h", "12h-seconds"].map(v => `<option ${c.format === v ? "selected" : ""}>${v}</option>`).join("")}</select>`) + field("Time zone", cfgInput("timeZone", c.timeZone, "text", 'placeholder="Europe/London"'));
      if (layer.type === "countdown") html += field("Minutes from switch", cfgInput("countdownMinutes", c.countdownMinutes || 0, "number", 'min="0" max="1440"')) + field("Or fixed time", cfgInput("countdownAt", c.countdownAt ? new Date(c.countdownAt).toISOString().slice(0, 16) : "", "datetime-local")) + field("When finished", cfgInput("doneText", c.doneText || "Starting now"), true);
    }
    if (layer.type === "color") html += `<div class="props-section full">Colour</div>${field("Colour", cfgInput("color", c.color || "#7c5cff", "color"))}`;
    if (layer.type === "gradient") html += `<div class="props-section full">Gradient</div>${field("From", cfgInput("from", c.from || "#7c5cff", "color"))}${field("To", cfgInput("to", c.to || "#ff2bd6", "color"))}${field("Angle", cfgInput("angle", c.angle ?? 135, "number", 'min="0" max="360"'))}`;
    if (layer.type === "webcam") html += `<div class="props-section full">Frame</div>${field("Border colour", cfgInput("borderColor", c.borderColor || "#00f0ff", "color"))}${field("Border width", cfgInput("borderWidth", c.borderWidth ?? 6, "number", 'min="0" max="80"'))}${field("Corner radius", cfgInput("radius", c.radius ?? 18, "number", 'min="0"'))}${field("Label", cfgInput("label", c.label, "text", 'placeholder="@you"'))}<label class="check-inline full"><input type="checkbox" data-cfg-bool="glow" ${c.glow !== false ? "checked" : ""}> Glow</label>`;
    if (layer.type === "html") html += `<div class="props-section full">Custom HTML</div>${field("HTML", `<textarea data-cfg="html">${esc(c.html || "")}</textarea>`, true)}${field("CSS", `<textarea data-cfg="css">${esc(c.css || "")}</textarea>`, true)}<div class="full callout" style="margin:0">Runs in an opaque-origin sandbox: scripts work, but the code cannot read CastNexus, its cookies or its APIs.</div>`;
    if (layer.type === "css") html += `<div class="props-section full">Custom CSS</div>${field("CSS for the program page", `<textarea data-cfg="css">${esc(c.css || "")}</textarea>`, true)}`;
    if (layer.type === "music") html += `<div class="props-section full">Music</div>${field("Effects", `<select data-cfg="effects">${["reduced", "minimal", "full"].map(v => `<option ${c.effects === v ? "selected" : ""}>${v}</option>`).join("")}</select>`, true)}`;
    if (layer.type === "program") {
      const p = layer.program || {}, crop = p.crop || {};
      html += `<div class="props-section full">Gameplay framing</div>
        ${field("Mode", `<select data-program="fit">${[["fit", "Fit (show everything)"], ["fill", "Fill (crop edges)"], ["crop", "Crop (manual)"], ["stretch", "Stretch"]].map(([v, l]) => `<option value="${v}" ${p.fit === v ? "selected" : ""}>${l}</option>`).join("")}</select>`, true)}
        ${field("Scale", rangeRow("data-program", "scale", p.scale ?? 1, 0.2, 4, 0.01, v => `${Math.round(v * 100)}%`), true)}
        ${field("Position X", rangeRow("data-program", "offsetX", p.offsetX ?? 0, -1, 1, 0.005, v => `${Math.round(v * 100)}%`))}${field("Position Y", rangeRow("data-program", "offsetY", p.offsetY ?? 0, -1, 1, 0.005, v => `${Math.round(v * 100)}%`))}
        ${field("Crop left", rangeRow("data-crop", "left", crop.left ?? 0, 0, 0.45, 0.005, v => `${Math.round(v * 100)}%`))}${field("Crop right", rangeRow("data-crop", "right", crop.right ?? 0, 0, 0.45, 0.005, v => `${Math.round(v * 100)}%`))}
        ${field("Crop top", rangeRow("data-crop", "top", crop.top ?? 0, 0, 0.45, 0.005, v => `${Math.round(v * 100)}%`))}${field("Crop bottom", rangeRow("data-crop", "bottom", crop.bottom ?? 0, 0, 0.45, 0.005, v => `${Math.round(v * 100)}%`))}
        <div class="full"><button class="btn btn-ghost btn-sm" data-program-reset>Reset framing</button></div>
        <div class="full callout" style="margin:0">Tip: double-click the gameplay (or hold Alt) and drag to move the picture inside its box. 16:9 is never stretched into 9:16 unless you pick Stretch.</div>`;
    }
    if (AUDIO.includes(layer.type)) {
      const a = layer.audio || {};
      html += `<div class="props-section full">Audio</div>
        <label class="check-inline"><input type="checkbox" data-audio-bool="enabled" ${a.enabled ? "checked" : ""}> Browser audio</label><label class="check-inline"><input type="checkbox" data-audio-bool="muted" ${a.muted ? "checked" : ""}> Mute</label>
        ${field("Volume", rangeRow("data-audio", "volume", a.volume ?? 1, 0, 2, 0.01, v => `${Math.round(v * 100)}%`), true)}
        ${field("Monitor", `<select data-audio-sel="monitor">${[["output", "Output (broadcast)"], ["server", "Server only (not broadcast)"], ["off", "Off"]].map(([v, l]) => `<option value="${v}" ${a.monitor === v ? "selected" : ""}>${l}</option>`).join("")}</select>`, true)}`;
    }
    html += `<div class="full" style="display:flex;gap:6px;margin-top:12px"><button class="btn btn-ghost btn-sm" data-layer-dup>Duplicate</button><button class="btn btn-danger btn-sm" data-layer-del>Delete</button></div></div>`;
    return html;
  }

  function syncPropsInputs(layer) {
    for (const key of ["x", "y", "width", "height"]) {
      const input = $(`#studio-props [data-prop="${key}"]`);
      if (input && document.activeElement !== input) input.value = layer[key];
    }
    for (const key of ["offsetX", "offsetY"]) {
      const input = $(`#studio-props [data-program="${key}"]`);
      if (input && layer.program) { input.value = layer.program[key]; const out = input.parentElement.querySelector("output"); if (out) out.textContent = `${Math.round(layer.program[key] * 100)}%`; }
    }
  }

  function layersPanel() {
    const list = layers().slice().reverse();
    if (!list.length) return `<div class="empty-state"><strong>No layers</strong>Use ＋ Add source.</div>`;
    return list.map(layer => {
      const meta = LAYER_META[layer.type] || { icon:"?" };
      const audible = AUDIO.includes(layer.type) && layer.audio?.enabled && !layer.audio?.muted;
      return `<div class="layer-row ${layer.id === ST.selectedId ? "active" : ""}" draggable="true" data-layer-row="${esc(layer.id)}"><button class="ico-btn ${layer.visible === false ? "off" : ""}" data-layer-vis="${esc(layer.id)}" title="Show / hide">👁</button><button class="ico-btn ${layer.locked ? "" : "off"}" data-layer-lock="${esc(layer.id)}" title="Lock">🔒</button><span>${meta.icon}</span><span class="layer-name">${esc(layer.name)}</span>${audible ? `<span title="Audio in broadcast">🔊</span>` : ""}<span class="layer-type">${esc(layer.type)}</span></div>`;
    }).join("");
  }

  function mixerPanel() {
    const mixer = ST.lib.mixer || {};
    const bus = (id, label) => {
      const row = mixer[id] || { volume:1 };
      return `<div class="mixer-row"><span class="mixer-name">${esc(label)}</span><input type="range" min="0" max="2" step="0.01" value="${row.volume ?? 1}" data-mixer="${id}"><output>${Math.round((row.volume ?? 1) * 100)}%</output><span class="mixer-btns"><button class="${row.muted ? "on" : ""}" data-mixer-mute="${id}">MUTE</button><button class="solo ${row.solo ? "on" : ""}" data-mixer-solo="${id}">SOLO</button></span></div>`;
    };
    const audioLayers = scenes().flatMap(s => s.layers.filter(l => AUDIO.includes(l.type) && l.audio?.enabled).map(l => ({ s, l })));
    return `<div class="mixer">${bus("program", "OBS / program")}${bus("browser", "Browser sources")}${bus("music", "Scene music")}</div>
      ${audioLayers.length ? `<div class="props-section">Browser layers with audio</div><div class="mixer">${audioLayers.map(({ s, l }) => `<div class="mixer-row"><span class="mixer-name" title="${esc(s.name)}">${esc(l.name)}</span><input type="range" min="0" max="2" step="0.01" value="${l.audio.volume ?? 1}" data-layer-volume="${esc(s.id)}|${esc(l.id)}"><output>${Math.round((l.audio.volume ?? 1) * 100)}%</output><span class="mixer-btns"><button class="${l.audio.muted ? "on" : ""}" data-layer-mute="${esc(s.id)}|${esc(l.id)}">MUTE</button></span></div>`).join("")}</div>` : `<p style="margin-top:10px">Add a StreamElements / browser / video layer with audio enabled and it appears here.</p>`}
      <p style="margin-top:10px">${ST.meta?.browserAudioNeeded ? "Browser audio capture is <strong>active</strong> for this account's program renderers." : "No layer currently needs browser audio, so the renderer stays muted (cheapest)."}</p>`;
  }

  function previewsPanel() {
    const guides = ST.safe ? "&guides=1" : "";
    const h = `/overlay/${login()}/program/landscape?preview=1${guides}`, v = `/overlay/${login()}/program/vertical?preview=1${guides}`;
    return `<div class="card-title-row"><div><h3>Horizontal and vertical program</h3><p>Exactly what the server renderers show right now (${esc(ST.meta?.onAir?.landscape?.sceneName || "—")} / ${esc(ST.meta?.onAir?.vertical?.sceneName || "—")}). These previews run in your browser only.</p></div><div class="page-actions"><button class="btn btn-ghost btn-sm" data-open-url="${esc(h)}">Open 16:9 ↗</button><button class="btn btn-ghost btn-sm" data-open-url="${esc(v)}">Open 9:16 ↗</button></div></div>
      <div class="program-previews"><div class="program-preview h"><span class="preview-label badge purple">HORIZONTAL · ${esc(sizeLabel("landscape"))}</span><iframe src="${esc(h)}" allow="autoplay" loading="lazy"></iframe></div><div class="program-preview v"><span class="preview-label badge cyan">VERTICAL · ${esc(sizeLabel("vertical"))}</span><iframe src="${esc(v)}" allow="autoplay" loading="lazy"></iframe></div></div>`;
  }

  function sizeLabel(o) {
    const p = ST.lib.programs?.[o];
    return p ? `${p.width}×${p.height} @ ${p.fps}` : "";
  }

  function programSettingsPanel() {
    const p = ST.lib.programs || {};
    const row = o => {
      const v = p[o] || {};
      const presets = o === "vertical" ? [[1080, 1920], [720, 1280], [540, 960]] : [[1920, 1080], [1280, 720], [960, 540]];
      return `<div class="card-panel" style="padding:12px"><h3>${o === "vertical" ? "9:16 Vertical program" : "16:9 Horizontal program"}</h3><div class="props-grid">
        ${field("Resolution", `<select data-program-size="${o}"><option value="auto" ${v.auto ? "selected" : ""}>Auto (hardware test picks size + FPS)</option>${presets.map(([w, h]) => `<option value="${w}x${h}" ${!v.auto && v.width === w && v.height === h ? "selected" : ""}>${w}×${h}</option>`).join("")}<option value="custom" ${!v.auto && !presets.some(([w, h]) => v.width === w && v.height === h) ? "selected" : ""}>Custom…</option></select>`, true)}
        ${field("Width", `<input type="number" data-program-w="${o}" value="${v.width || ""}" min="128" max="3840" step="2">`)}${field("Height", `<input type="number" data-program-h="${o}" value="${v.height || ""}" min="128" max="3840" step="2">`)}
        ${field("FPS", `<select data-program-fps="${o}">${[24, 25, 30, 48, 50, 60].map(f => `<option ${Number(v.fps) === f ? "selected" : ""}>${f}</option>`).join("")}</select>`)}${field("Bitrate kbps", `<input type="number" data-program-br="${o}" value="${v.bitrateKbps || ""}" placeholder="auto" min="300" max="50000">`)}
      </div></div>`;
    };
    return `<p>Destinations set to “Match program” stream-copy these encodes, so any number of platforms share one render + one encode per orientation. The vertical program only runs while a 9:16 destination is live.</p>
      <div class="grid grid-2">${row("landscape")}${row("vertical")}</div>
      <div class="props-grid" style="max-width:520px;margin-top:10px">${field("Scene effects in the server renderer", `<select data-program-effects><option value="auto" ${!p.effects || p.effects === "auto" ? "selected" : ""}>Auto (reduced unless COMPOSITOR_GPU=true)</option><option value="full" ${p.effects === "full" ? "selected" : ""}>Full (all 60 Hz animations - heavy on CPU)</option><option value="reduced" ${p.effects === "reduced" ? "selected" : ""}>Reduced (recommended for CPU hosts)</option><option value="minimal" ${p.effects === "minimal" ? "selected" : ""}>Minimal</option></select>`, true)}</div>
      <div class="page-actions" style="margin-top:10px"><button class="btn btn-primary btn-sm" data-program-save>Save program settings</button></div>`;
  }

  // --------------------------------------------------------------- wiring
  function wireToolbar() {
    const root = $("#studio-root");
    if (!root) return;
    $$("[data-zoom]", root).forEach(b => b.onclick = () => {
      const z = zoom();
      ST.zoom = b.dataset.zoom === "fit" ? null : clamp(z * (b.dataset.zoom === "in" ? 1.25 : 0.8), 0.05, 3);
      refreshSelection();
    });
    $$("[data-toggle]", root).forEach(b => b.onclick = () => {
      const key = b.dataset.toggle;
      ST[key] = !ST[key];
      if (key === "grid") $("#studio-canvas")?.classList.toggle("grid-on", ST.grid);
      if (key === "safe") { const pv = $(".program-previews")?.parentElement; if (pv) pv.innerHTML = previewsPanel(); }
      refreshSelection();
    });
    $$("[data-align]", root).forEach(b => b.onclick = () => {
      const layer = selected(), s = scene();
      if (!layer || layer.locked) return;
      pushHistory();
      if (b.dataset.align === "hcenter") layer.x = Math.round((s.canvas.width - layer.width) / 2);
      if (b.dataset.align === "vcenter") layer.y = Math.round((s.canvas.height - layer.height) / 2);
      if (b.dataset.align === "fill") Object.assign(layer, { x:0, y:0, width:s.canvas.width, height:s.canvas.height });
      refreshSelection(); queueSave(200);
    });
    $$("[data-order]", root).forEach(b => b.onclick = () => { const l = selected(); if (l) moveOrder(l, b.dataset.order); });
    $$("[data-layer-dup]", root).forEach(b => b.onclick = () => { const l = selected(); if (l) duplicateLayer(l); });
    $$("[data-layer-del]", root).forEach(b => b.onclick = () => { const l = selected(); if (l) deleteLayer(l); });
    $$("[data-undo]", root).forEach(b => b.onclick = undo);
    $$("[data-redo]", root).forEach(b => b.onclick = redo);
  }

  function wireProps() {
    const root = $("#studio-props");
    const layer = selected();
    if (!root || !layer) return;
    const commit = (redraw = true) => { if (redraw) drawCanvas(); else updateBox(layer); queueSave(); };
    $$("[data-prop]", root).forEach(input => {
      input.addEventListener("focus", pushHistory, { once:true });
      input.oninput = () => {
        const key = input.dataset.prop;
        if (key === "name") { layer.name = input.value; return commit(false); }
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        layer[key] = key === "opacity" ? value : Math.round(value);
        const out = input.parentElement.querySelector("output");
        if (out) out.textContent = `${Math.round(value * 100)}%`;
        commit(false);
      };
      if (input.dataset.prop === "name") input.onchange = () => { const list = $("#studio-layers"); if (list) { list.innerHTML = layersPanel(); wireLayerList(); } };
    });
    $$("[data-prop-bool]", root).forEach(input => input.onchange = () => { pushHistory(); layer[input.dataset.propBool] = input.checked; refreshSelection(); queueSave(200); });
    $$("[data-cfg]", root).forEach(input => {
      input.addEventListener("focus", pushHistory, { once:true });
      const handler = () => {
        const key = input.dataset.cfg;
        let value = input.value;
        if (input.type === "number" || ["fontSize", "fontWeight", "angle", "borderWidth", "radius", "countdownMinutes"].includes(key)) value = Number(value);
        if (key === "countdownAt") value = input.value ? new Date(input.value).toISOString() : "";
        layer.config = { ...(layer.config || {}), [key]:value };
        commit(true);
      };
      input.oninput = input.type === "url" || input.tagName === "TEXTAREA" ? null : handler;
      input.onchange = handler;
    });
    $$("[data-cfg-bool]", root).forEach(input => input.onchange = () => { pushHistory(); layer.config = { ...(layer.config || {}), [input.dataset.cfgBool]:input.checked }; commit(true); });
    $$("[data-audio]", root).forEach(input => input.oninput = () => { layer.audio = { ...(layer.audio || {}), [input.dataset.audio]:Number(input.value) }; input.parentElement.querySelector("output").textContent = `${Math.round(input.value * 100)}%`; queueSave(300); });
    $$("[data-audio-bool]", root).forEach(input => input.onchange = () => { pushHistory(); layer.audio = { ...(layer.audio || {}), [input.dataset.audioBool]:input.checked }; commit(true); });
    $$("[data-audio-sel]", root).forEach(input => input.onchange = () => { pushHistory(); layer.audio = { ...(layer.audio || {}), [input.dataset.audioSel]:input.value }; queueSave(200); });
    $$("[data-program]", root).forEach(input => {
      input.addEventListener("pointerdown", pushHistory, { once:true });
      const handler = () => {
        const key = input.dataset.program;
        layer.program = { ...(layer.program || {}), [key]:key === "fit" ? input.value : Number(input.value) };
        const out = input.parentElement.querySelector("output");
        if (out) out.textContent = `${Math.round(Number(input.value) * 100)}%`;
        drawProgramFrame(); queueSave(300);
      };
      input.oninput = handler; input.onchange = handler;
    });
    $$("[data-crop]", root).forEach(input => input.oninput = () => {
      const p = layer.program || {};
      layer.program = { ...p, crop:{ ...(p.crop || {}), [input.dataset.crop]:Number(input.value) } };
      input.parentElement.querySelector("output").textContent = `${Math.round(input.value * 100)}%`;
      drawProgramFrame(); queueSave(300);
    });
    const reset = $("[data-program-reset]", root);
    if (reset) reset.onclick = () => { pushHistory(); layer.program = { fit:scene()?.orientation === "vertical" ? "fill" : "fit", scale:1, offsetX:0, offsetY:0, crop:{ left:0, right:0, top:0, bottom:0 } }; refreshSelection(); queueSave(200); };
    $$("[data-layer-dup]", root).forEach(b => b.onclick = () => duplicateLayer(layer));
    $$("[data-layer-del]", root).forEach(b => b.onclick = () => deleteLayer(layer));
  }

  function wireLayerList() {
    const root = $("#studio-layers");
    if (!root) return;
    let dragId = null;
    $$("[data-layer-row]", root).forEach(row => {
      row.onclick = event => { if (event.target.closest("button")) return; ST.selectedId = row.dataset.layerRow; refreshSelection(); };
      row.ondragstart = e => { dragId = row.dataset.layerRow; e.dataTransfer.effectAllowed = "move"; };
      row.ondragover = e => { e.preventDefault(); row.classList.add("drag-over"); };
      row.ondragleave = () => row.classList.remove("drag-over");
      row.ondrop = e => {
        e.preventDefault(); row.classList.remove("drag-over");
        const targetId = row.dataset.layerRow;
        if (!dragId || dragId === targetId) return;
        pushHistory();
        const list = layers();
        const from = list.findIndex(l => l.id === dragId);
        const [moved] = list.splice(from, 1);
        const to = list.findIndex(l => l.id === targetId);
        // Rows are shown top -> bottom, the array is bottom -> top.
        list.splice(to + 1, 0, moved);
        refreshSelection(); queueSave(200);
      };
    });
    $$("[data-layer-vis]", root).forEach(b => b.onclick = () => { const l = layers().find(x => x.id === b.dataset.layerVis); if (!l) return; pushHistory(); l.visible = l.visible === false; refreshSelection(); queueSave(200); });
    $$("[data-layer-lock]", root).forEach(b => b.onclick = () => { const l = layers().find(x => x.id === b.dataset.layerLock); if (!l) return; l.locked = !l.locked; refreshSelection(); queueSave(200); });
  }

  function wireMixer() {
    const root = $("#studio-root");
    const sendMixer = () => {
      clearTimeout(ST.mixerTimer);
      ST.mixerTimer = setTimeout(() => api("/api/scenes/library/mixer", { method:"PUT", body:ST.lib.mixer }).then(applyServer).catch(e => toast(e.message, "error")), 250);
    };
    $$("[data-mixer]", root).forEach(input => input.oninput = () => { const bus = input.dataset.mixer; ST.lib.mixer[bus] = { ...(ST.lib.mixer[bus] || {}), volume:Number(input.value) }; input.nextElementSibling.textContent = `${Math.round(input.value * 100)}%`; sendMixer(); });
    $$("[data-mixer-mute]", root).forEach(b => b.onclick = () => { const bus = b.dataset.mixerMute; ST.lib.mixer[bus] = { ...(ST.lib.mixer[bus] || {}), muted:!ST.lib.mixer[bus]?.muted }; b.classList.toggle("on", ST.lib.mixer[bus].muted); sendMixer(); });
    $$("[data-mixer-solo]", root).forEach(b => b.onclick = () => { const bus = b.dataset.mixerSolo; ST.lib.mixer[bus] = { ...(ST.lib.mixer[bus] || {}), solo:!ST.lib.mixer[bus]?.solo }; b.classList.toggle("on", ST.lib.mixer[bus].solo); sendMixer(); });
    const layerFor = key => { const [sid, lid] = key.split("|"); const s = scenes().find(x => x.id === sid); return { s, l:s?.layers.find(x => x.id === lid) }; };
    const saveLayerScene = s => api(`/api/scenes/library/scenes/${encodeURIComponent(s.id)}`, { method:"PUT", body:{ layers:s.layers } }).catch(e => toast(e.message, "error"));
    $$("[data-layer-volume]", root).forEach(input => {
      let timer = null;
      input.oninput = () => { const { s, l } = layerFor(input.dataset.layerVolume); if (!l) return; l.audio = { ...l.audio, volume:Number(input.value) }; input.nextElementSibling.textContent = `${Math.round(input.value * 100)}%`; clearTimeout(timer); timer = setTimeout(() => saveLayerScene(s), 300); };
    });
    $$("[data-layer-mute]", root).forEach(b => b.onclick = () => { const { s, l } = layerFor(b.dataset.layerMute); if (!l) return; l.audio = { ...l.audio, muted:!l.audio.muted }; b.classList.toggle("on", l.audio.muted); saveLayerScene(s); });
  }

  function wireStudio() {
    const root = $("#studio-root");
    if (!root) return;
    $$("[data-orient]", root).forEach(b => b.onclick = () => { ST.orientation = b.dataset.orient; ST.sceneId = ST.lib.live?.[ST.orientation] || scenes().find(s => s.orientation === ST.orientation)?.id; ST.selectedId = null; ST.zoom = null; renderStudioInto(); });
    $$("[data-scene-select]", root).forEach(row => row.onclick = event => { if (event.target.closest("button")) return; ST.sceneId = row.dataset.sceneSelect; ST.selectedId = null; ST.zoom = null; ST.history = []; ST.future = []; renderStudioInto(); });
    $$("[data-scene-live]", root).forEach(b => b.onclick = () => write("/api/scenes/library/live", "POST", { orientation:ST.orientation, sceneId:b.dataset.sceneLive }, "Live scene switched"));
    $$("[data-scene-rename]", root).forEach(b => b.onclick = () => openSceneModal(scenes().find(s => s.id === b.dataset.sceneRename)));
    $$("[data-scene-dup]", root).forEach(b => b.onclick = async () => { const data = await write("/api/scenes/library/scenes", "POST", { duplicateOf:b.dataset.sceneDup }, "Scene duplicated"); if (data?.scene) { ST.sceneId = data.scene.id; renderStudioInto(); } });
    $$("[data-scene-del]", root).forEach(b => b.onclick = async () => { const s = scenes().find(x => x.id === b.dataset.sceneDel); if (!s || !(await confirmAction("Delete scene", `Delete ${s.name}? Destinations pinned to it will follow the live scene instead.`))) return; await write(`/api/scenes/library/scenes/${encodeURIComponent(s.id)}`, "DELETE", undefined, "Scene deleted"); });
    $$("[data-program-switch]", root).forEach(b => b.onclick = async () => { const k = b.dataset.programSwitch; await setScene(k === "none" ? { kind:"none" } : { kind:"builtin", name:k }); });
    $$("[data-slot-edit]", root).forEach(b => b.onclick = () => openSlotModal(b.dataset.slotEdit));
    const sizeSel = $$("[data-program-size]", root);
    sizeSel.forEach(sel => sel.onchange = () => { if (sel.value === "custom" || sel.value === "auto") return; const [w, h] = sel.value.split("x"); $(`[data-program-w="${sel.dataset.programSize}"]`, root).value = w; $(`[data-program-h="${sel.dataset.programSize}"]`, root).value = h; });
    const saveProgram = $("[data-program-save]", root);
    if (saveProgram) saveProgram.onclick = () => {
      const body = { effects:$("[data-program-effects]", root)?.value || "auto" };
      for (const o of ["landscape", "vertical"]) body[o] = { auto:$(`[data-program-size="${o}"]`, root).value === "auto", width:Number($(`[data-program-w="${o}"]`, root).value), height:Number($(`[data-program-h="${o}"]`, root).value), fps:Number($(`[data-program-fps="${o}"]`, root).value), bitrateKbps:$(`[data-program-br="${o}"]`, root).value ? Number($(`[data-program-br="${o}"]`, root).value) : null };
      write("/api/scenes/library/programs", "PUT", body, "Program settings saved - renderers restart with the new size");
    };
    $$("[data-open-url]", root).forEach(b => b.onclick = () => openUrl(b.dataset.openUrl));
    wireToolbar(); wireCanvas(); wireProps(); wireLayerList(); wireMixer(); wireKeyboard();
    window.removeEventListener("resize", ST.onResize || (() => {}));
    ST.onResize = () => { if (S.page === "studio" && !ST.zoom) drawCanvas(); };
    window.addEventListener("resize", ST.onResize);
  }

  // ---------------------------------------------------------------- modals
  function defaultLayer(type) {
    const s = scene();
    const W = s.canvas.width, H = s.canvas.height;
    const full = ["program", "background", "css", "streamelements", "alertbox"].includes(type) || (type === "music");
    const sizes = { text:[W * .5, H * .12], clock:[W * .2, H * .08], countdown:[W * .3, H * .12], chat:[W * .28, H * .5], webcam:[W * .3, W * .3 * 9 / 16], nowplaying:[W * .22, W * .22 * .24], color:[W * .25, H * .25], gradient:[W * .3, H * .3], image:[W * .25, H * .25], gif:[W * .2, W * .2], video:[W * .4, W * .4 * 9 / 16], browser:[W * .4, H * .4], streamlabs:[W, H], webpage:[W * .5, H * .5], iframe:[W * .5, H * .5], html:[W * .4, H * .3] };
    const [w, h] = full ? [W, H] : (sizes[type] || [W * .3, H * .3]);
    return {
      id:newId(), type, name:LAYER_META[type]?.label || type,
      x:Math.round((W - w) / 2), y:Math.round((H - h) / 2), width:Math.round(w), height:Math.round(h),
      rotation:0, opacity:1, visible:true, locked:false,
      config:{ text:type === "text" ? "Your text" : "", color:type === "color" ? "#7c5cff" : type === "text" || type === "clock" || type === "countdown" ? "#ffffff" : undefined, transparent:true, fit:"cover", effects:"reduced", countdownMinutes:type === "countdown" ? 5 : undefined },
      audio:{ enabled:AUDIO.includes(type) && type !== "html", volume:1, muted:false, monitor:"output" },
      ...(type === "program" ? { program:{ fit:s.orientation === "vertical" ? "fill" : "fit", scale:1, offsetX:0, offsetY:0, crop:{ left:0, right:0, top:0, bottom:0 } } } : {}),
    };
  }

  function openAddSource() {
    if (!scene()) return toast("Create a scene first", "error");
    modalShell("Add source", `ADD TO ${scene().name.toUpperCase()}`, `<div class="add-source-grid">${ADD_ORDER.map(type => `<button class="add-source-tile" data-add-type="${type}"><span class="tile-icon">${LAYER_META[type].icon}</span><strong>${esc(LAYER_META[type].label)}</strong><small>${esc(LAYER_META[type].desc)}</small></button>`).join("")}</div>`, "", true);
    $$("[data-add-type]").forEach(b => b.onclick = () => openSourceForm(b.dataset.addType));
  }

  function openSourceForm(type) {
    const s = scene(), base = defaultLayer(type);
    const needsUrl = BROWSER.includes(type);
    const needsSrc = ["image", "gif", "video", "background"].includes(type);
    const body = `<div class="form-grid">
      <div class="full"><label>Name</label><input id="src-name" value="${esc(base.name)}"></div>
      ${needsUrl ? `<div class="full"><label>${type === "streamelements" ? "StreamElements overlay URL" : type === "streamlabs" ? "Streamlabs widget URL" : "URL"}</label><input id="src-url" type="url" placeholder="${type === "streamelements" ? "https://streamelements.com/overlay/xxxxxxxx/yyyyyyyy" : "https://…"}"></div>` : ""}
      ${needsSrc ? `<div class="full"><label>${type === "video" ? "Video URL (mp4/webm)" : "Image URL"}</label><input id="src-src" type="url" placeholder="https://…"></div>` : ""}
      ${type === "text" ? `<div class="full"><label>Text</label><textarea id="src-text">Your text</textarea></div>` : ""}
      ${type === "html" ? `<div class="full"><label>HTML</label><textarea id="src-html" placeholder="<div class='box'>Hello</div>"></textarea></div><div class="full"><label>CSS</label><textarea id="src-css"></textarea></div>` : ""}
      ${type === "css" ? `<div class="full"><label>CSS</label><textarea id="src-css"></textarea></div>` : ""}
      ${type === "color" ? `<div><label>Colour</label><input id="src-color" type="color" value="#7c5cff"></div>` : ""}
      <div><label>Width</label><input id="src-w" type="number" value="${base.width}" min="1"></div><div><label>Height</label><input id="src-h" type="number" value="${base.height}" min="1"></div>
      ${AUDIO.includes(type) ? `<label class="check-row full"><input id="src-audio" type="checkbox" ${base.audio.enabled ? "checked" : ""}> Enable audio (mixed into the broadcast server-side)</label><div class="full"><label>Volume</label><input id="src-vol" type="range" min="0" max="2" step="0.01" value="1"></div>` : ""}
    </div>
    ${type === "streamelements" ? `<div class="callout" style="margin-top:12px">Paste the overlay URL from StreamElements → My overlays → Copy URL. No API key is required. Alerts play their sounds into the stream.</div>` : ""}
    ${needsUrl ? `<div class="callout" style="margin-top:12px">Browser sources are rendered in a sandbox with autoplay allowed. They cannot access CastNexus, your stream keys or the host.</div>` : ""}
    <div id="modal-error" class="form-error"></div>`;
    modalShell(`Add ${LAYER_META[type].label}`, `${s.orientation === "vertical" ? "9:16" : "16:9"} · ${s.canvas.width}×${s.canvas.height}`, body, `<button class="btn btn-ghost" id="src-back">← Back</button><button class="btn btn-primary" id="src-add">Add layer</button>`, true);
    $("#src-back").onclick = openAddSource;
    $("#src-add").onclick = () => {
      const layer = { ...base, name:$("#src-name").value.trim() || base.name, width:Number($("#src-w").value) || base.width, height:Number($("#src-h").value) || base.height };
      layer.x = Math.round((s.canvas.width - layer.width) / 2); layer.y = Math.round((s.canvas.height - layer.height) / 2);
      const url = $("#src-url")?.value.trim(), src = $("#src-src")?.value.trim();
      if (needsUrl) { if (!/^https?:\/\//i.test(url || "")) { $("#modal-error").textContent = "Enter an http(s) URL"; return; } layer.config.url = url; }
      if (needsSrc) { if (!/^https?:\/\//i.test(src || "")) { $("#modal-error").textContent = "Enter an http(s) URL"; return; } layer.config.src = src; }
      if (type === "text") layer.config.text = $("#src-text").value;
      if (type === "html") { layer.config.html = $("#src-html").value; layer.config.css = $("#src-css").value; }
      if (type === "css") layer.config.css = $("#src-css").value;
      if (type === "color") layer.config.color = $("#src-color").value;
      if ($("#src-audio")) layer.audio = { ...layer.audio, enabled:$("#src-audio").checked, volume:Number($("#src-vol").value) };
      pushHistory();
      // Backgrounds go to the very bottom; gameplay sits just above any
      // background/colour/gradient layers; everything else goes on top.
      if (type === "background") s.layers.unshift(layer);
      else if (type === "program") {
        const firstOverlay = s.layers.findIndex(l => !["background", "color", "gradient"].includes(l.type));
        s.layers.splice(firstOverlay < 0 ? s.layers.length : firstOverlay, 0, layer);
      } else s.layers.push(layer);
      ST.selectedId = layer.id;
      closeModal(); refreshSelection(); queueSave(100);
      toast(`${LAYER_META[type].label} added`, "success");
    };
  }

  function openSceneModal(existing = null) {
    const o = existing?.orientation || ST.orientation;
    modalShell(existing ? "Rename scene" : "New scene", existing ? "SCENE" : `NEW ${o === "vertical" ? "9:16" : "16:9"} SCENE`, `<div class="form-grid">
      <div class="full"><label>Name</label><input id="scene-name" value="${esc(existing?.name || (o === "vertical" ? "Vertical scene" : "New scene"))}"></div>
      ${existing ? "" : `<div class="full"><label>Canvas</label><select id="scene-orient"><option value="landscape" ${o === "landscape" ? "selected" : ""}>16:9 · 1920×1080</option><option value="vertical" ${o === "vertical" ? "selected" : ""}>9:16 · 1080×1920</option><option value="custom">Custom size…</option></select></div><div><label>Width</label><input id="scene-w" type="number" placeholder="1920"></div><div><label>Height</label><input id="scene-h" type="number" placeholder="1080"></div>
      <div class="full"><label>Type</label><select id="scene-kind"><option value="gameplay">Gameplay</option><option value="chatting">Just Chatting</option><option value="intermission">Starting Soon / BRB / Ending</option><option value="music">Music</option><option value="custom">Custom</option></select></div>
      <label class="check-row full"><input id="scene-program" type="checkbox" checked> Start with the Gameplay / OBS layer</label>`}
    </div><div id="modal-error" class="form-error"></div>`, `<button class="btn btn-ghost" data-modal-close>Cancel</button><button class="btn btn-primary" id="scene-save">${existing ? "Save" : "Create scene"}</button>`);
    $$("[data-modal-close]").forEach(b => b.onclick = closeModal);
    $("#scene-save").onclick = async () => {
      const name = $("#scene-name").value.trim();
      if (!name) return ($("#modal-error").textContent = "Name is required");
      if (existing) {
        const data = await write(`/api/scenes/library/scenes/${encodeURIComponent(existing.id)}`, "PUT", { name }, "Scene renamed");
        if (data) closeModal();
        return;
      }
      let orientation = $("#scene-orient").value, canvas;
      const w = Number($("#scene-w").value), h = Number($("#scene-h").value);
      if (orientation === "custom" || (w && h)) { if (!w || !h) return ($("#modal-error").textContent = "Enter width and height"); orientation = h > w ? "vertical" : "landscape"; canvas = { width:w, height:h }; }
      const data = await write("/api/scenes/library/scenes", "POST", { name, orientation, canvas, kind:$("#scene-kind").value, withProgram:$("#scene-program").checked }, "Scene created");
      if (data?.scene) { ST.orientation = data.scene.orientation; ST.sceneId = data.scene.id; closeModal(); renderStudioInto(); }
    };
  }

  function openSlotModal(name) {
    const slot = ST.lib.slots?.[name] || { mode:"builtin" };
    const sceneOptions = scenes().map(s => `<option value="${esc(s.id)}" ${slot.sceneId === s.id ? "selected" : ""}>${esc(s.name)} · ${s.orientation === "vertical" ? "9:16" : "16:9"}</option>`).join("");
    const render = mode => `
      <div class="form-grid">
        <div class="full"><label>${esc(SLOT_LABELS[name])} shows</label><select id="slot-mode">${Object.entries(SLOT_MODE_LABELS).map(([v, l]) => `<option value="${v}" ${mode === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
        ${mode === "builtin" ? `<div class="full callout">The original CastNexus ${esc(SLOT_LABELS[name])} scene (title, countdown, socials, optional profile music).${name !== "offline" ? ` <button class="btn btn-ghost btn-sm" id="slot-edit-builtin">Edit text & colours</button>` : ""}</div>` : ""}
        ${mode === "scene" ? `<div class="full"><label>Overlay Studio scene</label><select id="slot-scene">${sceneOptions}</select></div>` : ""}
        ${mode === "url" ? `<div class="full"><label>StreamElements / browser URL</label><input id="slot-url" type="url" value="${esc(slot.url || "")}" placeholder="https://streamelements.com/overlay/xxxxxxxx"></div>` : ""}
        ${mode === "html" ? `<div class="full"><label>HTML</label><textarea id="slot-html">${esc(slot.html || "")}</textarea></div><div class="full"><label>CSS</label><textarea id="slot-css">${esc(slot.css || "")}</textarea></div>` : ""}
        ${mode === "media" ? `<div class="full"><label>Image or video URL</label><input id="slot-media" type="url" value="${esc(slot.mediaUrl || "")}" placeholder="https://…/brb-loop.mp4"></div>` : ""}
        ${["url", "html", "media"].includes(mode) ? `<label class="check-row full"><input id="slot-audio" type="checkbox" ${slot.audio?.enabled !== false ? "checked" : ""}> Include this scene's audio in the stream</label><div class="full"><label>Volume</label><input id="slot-vol" type="range" min="0" max="2" step="0.01" value="${slot.audio?.volume ?? 1}"></div>` : ""}
      </div>
      <div class="callout" style="margin-top:12px">Applies to every output (16:9 and 9:16) while ${esc(SLOT_LABELS[name])} is on air. Switching to it never restarts the stream.</div>
      <div id="modal-error" class="form-error"></div>`;
    const show = mode => {
      modalShell(`${SLOT_LABELS[name]} scene`, "SCENE SLOT", render(mode), `<button class="btn btn-ghost" data-modal-close>Cancel</button><button class="btn btn-primary" id="slot-save">Save</button>`, true);
      $$("[data-modal-close]").forEach(b => b.onclick = closeModal);
      $("#slot-mode").onchange = e => show(e.target.value);
      const builtin = $("#slot-edit-builtin");
      if (builtin) builtin.onclick = () => openBuiltinModal(name);
      $("#slot-save").onclick = async () => {
        const body = { mode, sceneId:$("#slot-scene")?.value || null, url:$("#slot-url")?.value.trim() || "", html:$("#slot-html")?.value || "", css:$("#slot-css")?.value || "", mediaUrl:$("#slot-media")?.value.trim() || "", audio:{ enabled:$("#slot-audio") ? $("#slot-audio").checked : true, volume:Number($("#slot-vol")?.value ?? 1), muted:false } };
        try { applyServer(await api(`/api/scenes/library/slots/${name}`, { method:"PUT", body })); closeModal(); renderStudioInto(); toast(`${SLOT_LABELS[name]} updated`, "success"); }
        catch (error) { $("#modal-error").textContent = error.message; }
      };
    };
    show(slot.mode || "builtin");
  }

  // Keep the On-air panel in sync after a scene switch from anywhere.
  const originalSetScene = window.setScene;
  if (typeof originalSetScene === "function") {
    window.setScene = async function studioAwareSetScene(sceneValue) {
      await originalSetScene.call(this, sceneValue);
      if (S.page === "studio") { try { await loadLibrary(); renderStudioInto(); } catch {} }
    };
  }
})();
