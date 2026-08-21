// CacheStream-inspired scene primitives adapted for RestreamNode's plain Express renderer.

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function cssUrl(value) {
  return `'${String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function hexAlpha(color, alpha) {
  const c = String(color || "").trim();
  const short = /^#([0-9a-f]{3})$/i.exec(c);
  if (short) {
    const h = short[1];
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const full = /^#([0-9a-f]{6})$/i.exec(c);
  if (full) {
    const h = full[1];
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return c || `rgba(0, 240, 255, ${alpha})`;
}

function page({ title, body, bodyCss = "", transparent = true }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
  body {
    background: ${transparent ? "transparent" : "#05060a"};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  ${bodyCss}
</style></head>
<body>${body}</body></html>`;
}

// ---------------------------------------------------------------------------
// CacheStream-inspired scene shell.
//
// The source project uses React/Next.js components (SceneFrame + scene-base.css).
// RestreamNode intentionally stays dependency-light, so the same visual language
// is rendered as self-contained HTML/CSS fragments that work in ordinary OBS
// Browser Sources AND in the built-in headless Chromium compositor.

const SCENE_BASE_CSS = `
  .rn-scene, .rn-music-stage {
    --rn-accent: #00f0ff;
    --rn-accent-solid: #00f0ff;
    --rn-accent-glow: rgba(0,240,255,.55);
    --rn-accent-soft: rgba(0,240,255,.4);
    --rn-accent-line: rgba(0,240,255,.35);
    --rn-accent2: rgba(138,43,255,.18);
    box-sizing: border-box;
    position: relative;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    isolation: isolate;
    color: #e6f7ff;
    background: #05060a;
    font-family: "Segoe UI", system-ui, -apple-system, "JetBrains Mono", Menlo, Consolas, monospace;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
    animation: rn-scene-in 400ms cubic-bezier(.2,.8,.2,1) both;
  }
  @keyframes rn-scene-in { from { opacity:0; transform:scale(1.012); } to { opacity:1; transform:scale(1); } }
  .rn-bg { position:absolute; inset:0; z-index:-3; background-position:center; background-size:cover; }
  .rn-bg::after { content:""; position:absolute; inset:0; background:rgba(2,3,6,.48); }
  .rn-wash {
    position:absolute; inset:0; pointer-events:none; z-index:-2;
    background:
      radial-gradient(ellipse at 50% 35%, var(--rn-accent) 0%, transparent 60%),
      radial-gradient(ellipse at 50% 100%, var(--rn-accent2) 0%, transparent 70%);
  }
  .rn-grid {
    position:absolute; inset:0; pointer-events:none; z-index:-1;
    background-image:
      linear-gradient(rgba(0,240,255,.06) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,240,255,.06) 1px, transparent 1px);
    background-size:80px 80px;
    mask-image:radial-gradient(ellipse at center,#000 35%,transparent 75%);
    -webkit-mask-image:radial-gradient(ellipse at center,#000 35%,transparent 75%);
    animation:rn-grid-drift 14s linear infinite;
    will-change:background-position;
  }
  @keyframes rn-grid-drift { from { background-position:0 0,0 0; } to { background-position:0 80px,80px 0; } }
  .rn-scanlines {
    position:absolute; inset:0; pointer-events:none; z-index:0; opacity:.55; mix-blend-mode:overlay;
    background:repeating-linear-gradient(to bottom,rgba(255,255,255,.015) 0 1px,transparent 1px 3px);
  }
  .rn-brand {
    position:absolute; top:32px; left:32px; z-index:3; display:inline-flex; align-items:center; gap:.7rem;
    font-size:.85rem; letter-spacing:.38em; text-transform:uppercase; color:rgba(230,247,255,.56);
    text-shadow:0 0 8px rgba(0,240,255,.25);
  }
  .rn-brand img { height:44px; width:44px; border-radius:50%; object-fit:cover; filter:drop-shadow(0 0 12px rgba(0,240,255,.28)); }
  .rn-corner {
    position:absolute; bottom:28px; right:32px; z-index:3; font-family:"JetBrains Mono",monospace;
    font-size:.78rem; letter-spacing:.18em; color:rgba(230,247,255,.42); text-transform:uppercase;
  }
  .rn-content {
    position:relative; z-index:2; width:100%; height:100%; display:flex; flex-direction:column;
    align-items:center; justify-content:center; gap:1.4rem; padding:4rem; box-sizing:border-box; text-align:center;
  }
  .rn-eyebrow {
    font-size:clamp(.85rem,1.1vw,1.05rem); letter-spacing:.4em; text-transform:uppercase;
    color:rgba(230,247,255,.62); padding:.55rem 1.4rem; border:1px solid var(--rn-accent-line);
    border-radius:999px; background:rgba(10,13,24,.55); backdrop-filter:blur(4px);
    display:inline-flex; align-items:center; gap:.6rem;
  }
  .rn-pulse { width:8px; height:8px; border-radius:50%; background:var(--rn-accent-solid); box-shadow:0 0 12px var(--rn-accent-solid); animation:rn-pulse 1.6s ease-in-out infinite; }
  @keyframes rn-pulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }
  .rn-title {
    margin:0; max-width:92vw; font-size:clamp(3.2rem,9vw,9rem); font-weight:800; line-height:1.05;
    letter-spacing:.04em; text-transform:uppercase; color:#e6f7ff;
    text-shadow:0 0 8px var(--rn-accent-glow),0 0 28px var(--rn-accent-glow),0 0 80px var(--rn-accent-soft);
    animation:rn-title-pulse 3.6s ease-in-out infinite; will-change:transform;
  }
  @keyframes rn-title-pulse { 0%,100% { transform:scale(1); } 50% { transform:scale(1.012); } }
  .rn-subtitle { margin:0; max-width:900px; font-size:clamp(1rem,1.6vw,1.6rem); letter-spacing:.18em; color:rgba(230,247,255,.75); }
  .rn-glitch { position:relative; }
  .rn-glitch::before,.rn-glitch::after { content:attr(data-text); position:absolute; inset:0; pointer-events:none; mix-blend-mode:screen; }
  .rn-glitch::before { color:#ff2bd6; animation:rn-glitch-a 4.8s steps(1) infinite; text-shadow:0 0 18px rgba(255,43,214,.55); }
  .rn-glitch::after { color:#00f0ff; animation:rn-glitch-b 5.6s steps(1) infinite; text-shadow:0 0 18px rgba(0,240,255,.55); }
  @keyframes rn-glitch-a { 0%,92%,100%{transform:translate(0);opacity:0}93%{transform:translate(-4px,1px);opacity:.6}95%{transform:translate(3px,-1px);opacity:.55}97%{transform:translate(-2px,2px);opacity:.5} }
  @keyframes rn-glitch-b { 0%,90%,100%{transform:translate(0);opacity:0}91%{transform:translate(2px,-2px);opacity:.55}94%{transform:translate(-3px,1px);opacity:.6}96%{transform:translate(1px,2px);opacity:.5} }
  .rn-countdown-label { font-size:.7rem; letter-spacing:.18em; text-transform:uppercase; color:rgba(230,247,255,.58); }
  .rn-countdown {
    display:inline-flex; gap:1.4rem; font-family:"JetBrains Mono","Segoe UI",monospace; font-variant-numeric:tabular-nums;
    padding:1rem 1.6rem; border:1px solid var(--rn-accent-line); border-radius:8px;
    background:rgba(10,13,24,.58); backdrop-filter:blur(4px);
  }
  .rn-countdown-cell { display:flex; flex-direction:column; align-items:center; gap:.3rem; min-width:4.5rem; }
  .rn-countdown-num { font-size:clamp(2.4rem,4vw,3.6rem); font-weight:800; letter-spacing:.05em; color:var(--rn-accent-solid); text-shadow:0 0 18px var(--rn-accent-glow); line-height:1; }
  .rn-countdown-lbl { font-size:.7rem; letter-spacing:.28em; text-transform:uppercase; color:rgba(230,247,255,.5); }
  .rn-social { display:flex; gap:1.2rem; margin-top:1rem; flex-wrap:wrap; justify-content:center; }
  .rn-social-item { display:inline-flex; align-items:center; gap:.55rem; padding:.7rem 1.15rem; border:1px solid var(--rn-accent-line); border-radius:6px; background:rgba(10,13,24,.58); font-size:1rem; color:#e6f7ff; }
  .rn-social-svc { font-size:.68rem; letter-spacing:.24em; text-transform:uppercase; color:rgba(230,247,255,.55); }
  @media (max-width:800px) { .rn-content{padding:2rem}.rn-brand{top:18px;left:18px}.rn-corner{right:18px;bottom:18px}.rn-countdown{gap:.6rem;padding:.8rem}.rn-countdown-cell{min-width:3.2rem} }
`;

function sceneStyleVars(accent) {
  const a = accent || "#00f0ff";
  return [
    `--rn-accent:${hexAlpha(a, 0.18)}`,
    `--rn-accent-solid:${escapeHtml(a)}`,
    `--rn-accent-glow:${hexAlpha(a, 0.55)}`,
    `--rn-accent-soft:${hexAlpha(a, 0.40)}`,
    `--rn-accent-line:${hexAlpha(a, 0.35)}`,
    `--rn-accent2:${hexAlpha("#8a2bff", 0.18)}`,
  ].join(";");
}

function accountBrand(account) {
  return {
    name: account?.displayName || account?.twitchLogin || "RestreamNode",
    image: account?.profileImageUrl || "",
  };
}

function sceneFrameFragment({ account, title, subtitle, accent, backgroundUrl, eyebrow, corner, extra = "", glitch = true }) {
  const brand = accountBrand(account);
  const bg = backgroundUrl ? `<div class="rn-bg" style="background-image:url(${cssUrl(backgroundUrl)})"></div>` : "";
  const brandHtml = `<div class="rn-brand">${brand.image ? `<img src="${escapeHtml(brand.image)}" alt="">` : ""}<span>${escapeHtml(brand.name)}</span></div>`;
  return `
    <style>${SCENE_BASE_CSS}</style>
    <section class="rn-scene" style="${sceneStyleVars(accent)}">
      ${bg}<div class="rn-wash"></div><div class="rn-grid"></div><div class="rn-scanlines"></div>
      ${brandHtml}${corner ? `<div class="rn-corner">${escapeHtml(corner)}</div>` : ""}
      <div class="rn-content">
        ${eyebrow ? `<div class="rn-eyebrow"><span class="rn-pulse"></span>${escapeHtml(eyebrow)}</div>` : ""}
        <h1 class="rn-title${glitch ? " rn-glitch" : ""}" data-text="${escapeHtml(title)}">${escapeHtml(title)}</h1>
        ${subtitle ? `<p class="rn-subtitle">${escapeHtml(subtitle)}</p>` : ""}
        ${extra}
      </div>
    </section>`;
}

function countdownBlock(countdownAt, countdownLabel) {
  if (!countdownAt) return "";
  const timestamp = Date.parse(countdownAt);
  if (!Number.isFinite(timestamp)) return "";
  const iso = new Date(timestamp).toISOString();
  return `
    <div class="rn-countdown-label">${escapeHtml(countdownLabel || "Live in")}</div>
    <div class="rn-countdown" aria-label="${escapeHtml(countdownLabel || "countdown")}">
      <div class="rn-countdown-cell" id="rn-cd-days-cell" style="display:none"><div id="rn-cd-days" class="rn-countdown-num">00</div><div class="rn-countdown-lbl">Days</div></div>
      <div class="rn-countdown-cell"><div id="rn-cd-hours" class="rn-countdown-num">00</div><div class="rn-countdown-lbl">Hours</div></div>
      <div class="rn-countdown-cell"><div id="rn-cd-min" class="rn-countdown-num">00</div><div class="rn-countdown-lbl">Min</div></div>
      <div class="rn-countdown-cell"><div id="rn-cd-sec" class="rn-countdown-num">00</div><div class="rn-countdown-lbl">Sec</div></div>
    </div>
    <script>
      (function () {
        var target = new Date(${JSON.stringify(iso)}).getTime();
        function pad(n) { return String(n).padStart(2, "0"); }
        function tick() {
          var total = Math.floor(Math.max(0, target - Date.now()) / 1000);
          var d = Math.floor(total / 86400);
          var h = Math.floor((total % 86400) / 3600);
          var m = Math.floor((total % 3600) / 60);
          var s = total % 60;
          var daysCell = document.getElementById("rn-cd-days-cell");
          if (daysCell) daysCell.style.display = d > 0 ? "flex" : "none";
          var days = document.getElementById("rn-cd-days"); if (days) days.textContent = pad(d);
          var hours = document.getElementById("rn-cd-hours"); if (hours) hours.textContent = pad(h);
          var min = document.getElementById("rn-cd-min"); if (min) min.textContent = pad(m);
          var sec = document.getElementById("rn-cd-sec"); if (sec) sec.textContent = pad(s);
        }
        tick();
        window.__rnCountdownTimer && clearInterval(window.__rnCountdownTimer);
        window.__rnCountdownTimer = setInterval(tick, 1000);
      })();
    </script>`;
}

function startingSoonFragment(cfg, query = {}, account) {
  const backgroundUrl = query.background || query.bg || cfg.backgroundUrl || "";
  return sceneFrameFragment({
    account,
    title: query.title || cfg.title || "Starting Soon",
    subtitle: query.subtitle || cfg.subtitle || "Stream begins shortly · stand by",
    accent: query.accent || cfg.accent || "#00f0ff",
    backgroundUrl,
    eyebrow: "Standby",
    corner: "On standby",
    extra: countdownBlock(query.at || cfg.countdownAt, query.label || cfg.countdownLabel || "Live in"),
  });
}

function brbFragment(cfg, query = {}, account) {
  return sceneFrameFragment({
    account,
    title: query.title || cfg.title || "BRB",
    subtitle: query.subtitle || cfg.subtitle || "Be right back · grabbing coffee",
    accent: query.accent || cfg.accent || "#8a2bff",
    backgroundUrl: query.background || query.bg || cfg.backgroundUrl || "",
    eyebrow: "Intermission",
    corner: "Intermission",
  });
}

function endingFragment(cfg, query = {}, account) {
  const handles = [
    ["Twitch", query.twitch || cfg.twitch],
    ["YouTube", query.youtube || cfg.youtube],
    ["X", query.twitter || cfg.twitter],
    ["Discord", query.discord || cfg.discord],
  ].filter(([, value]) => value);
  const extra = handles.length
    ? `<div class="rn-social">${handles.map(([service, value]) => `<div class="rn-social-item"><span class="rn-social-svc">${escapeHtml(service)}</span><span>${escapeHtml(value)}</span></div>`).join("")}</div>`
    : "";
  return sceneFrameFragment({
    account,
    title: query.title || cfg.title || "Thanks for watching",
    subtitle: query.subtitle || cfg.subtitle || "Stream over · see you next time",
    accent: query.accent || cfg.accent || "#ff2bd6",
    backgroundUrl: query.background || query.bg || cfg.backgroundUrl || "",
    eyebrow: "Off air",
    corner: "Off air",
    extra,
  });
}

function offlineFragment(cfg = {}, query = {}, account) {
  return sceneFrameFragment({
    account,
    title: query.title || cfg.title || "OFFLINE",
    subtitle: query.subtitle || cfg.subtitle || "Channel is not live right now",
    accent: query.accent || cfg.accent || "#4ade80",
    backgroundUrl: query.background || query.bg || cfg.backgroundUrl || "",
    eyebrow: "Idle",
    corner: "Status · Offline",
    glitch: false,
  });
}

// ---------------------------------------------------------------------------
// "Now Playing" mini-widget - layerable onto any scene fragment.

const CORNER_CSS = {
  br: "bottom:24px; right:24px;", bl: "bottom:24px; left:24px;",
  tr: "top:24px; right:24px;", tl: "top:24px; left:24px;",
};

function nowPlayingWidget(login, corner) {
  const pos = CORNER_CSS[corner] || CORNER_CSS.br;
  return `
    <style>
      #cs-now-playing { position:fixed; ${pos} z-index:20; display:none; gap:12px; align-items:center; min-width:230px; width:min(340px,calc(100vw - 48px)); max-width:340px; box-sizing:border-box; padding:11px 15px; border:1px solid rgba(0,240,255,.22); border-radius:10px; color:#fff; background:rgba(5,6,10,.72); backdrop-filter:blur(7px); box-shadow:0 0 28px rgba(0,240,255,.10); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
      #cs-now-playing .np-icon { flex:0 0 auto; font-size:26px; color:#00f0ff; text-shadow:0 0 12px rgba(0,240,255,.6); }
      #cs-now-playing .np-copy { min-width:0; flex:1 1 auto; overflow:hidden; }
      #cs-now-playing .np-k { font-size:9px; letter-spacing:.28em; text-transform:uppercase; color:#8aa0ad; }
      #cs-now-playing .np-t { width:100%; font-weight:750; font-size:13px; line-height:1.14; overflow:hidden; text-overflow:clip; white-space:nowrap; }
      #cs-now-playing .np-a { width:100%; font-size:11px; line-height:1.2; color:#c8c8d0; overflow:hidden; text-overflow:clip; white-space:nowrap; }
    </style>
    <aside id="cs-now-playing"><div class="np-icon">&#9835;</div><div class="np-copy"><div class="np-k">Now playing</div><div id="cs-np-title" class="np-t">&mdash;</div><div id="cs-np-artist" class="np-a"></div></div></aside>
    <script>
      (function () {
        function fitOneLine(el, maxPx, minPx) {
          if (!el || !el.clientWidth) return;
          var size = Number(maxPx) || parseFloat(getComputedStyle(el).fontSize) || 13;
          var floor = Math.min(size, Number(minPx) || 8);
          el.style.fontSize = size + "px";
          while (size > floor && el.scrollWidth > el.clientWidth + 1) {
            size = Math.max(floor, size - .5);
            el.style.fontSize = size + "px";
          }
        }
        function fitMeta() {
          requestAnimationFrame(function () {
            fitOneLine(document.getElementById("cs-np-title"), 13, 8);
            fitOneLine(document.getElementById("cs-np-artist"), 11, 7);
          });
        }
        function poll() {
          fetch(${JSON.stringify(`/overlay/${encodeURIComponent(login)}/music/now.json`)}, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (now) {
              var el = document.getElementById("cs-now-playing");
              if (!el) return;
              if (!now || now.mode !== "playing" || !now.track) { el.style.display = "none"; return; }
              el.style.display = "flex";
              document.getElementById("cs-np-title").textContent = now.track.title || "Untitled";
              document.getElementById("cs-np-artist").textContent = now.track.artist || "";
              fitMeta();
            })
            .catch(function () {});
        }
        poll();
        window.addEventListener("resize", fitMeta);
        window.__rnNowPlayingTimer && clearInterval(window.__rnNowPlayingTimer);
        window.__rnNowPlayingTimer = setInterval(poll, 2000);
      })();
    </script>`;
}

function withWidgets(fragment, overlayConfig, login) {
  const np = overlayConfig?.nowPlaying;
  if (!np?.enabled) return fragment;
  return fragment + nowPlayingWidget(login, np.corner);
}

module.exports = {
  escapeHtml, cssUrl, hexAlpha, page, SCENE_BASE_CSS, sceneStyleVars,
  startingSoonFragment, brbFragment, endingFragment, offlineFragment,
  nowPlayingWidget, withWidgets,
};
