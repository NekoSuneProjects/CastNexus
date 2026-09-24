"use strict";

// Per-destination output layouts, Music 24/7 performance controls, system
// performance monitor and the Console / PC source overlay panel.

(function installOutputsUi() {
  const OUT = { caps:null, perfTimer:null, perf:null, lib:null };
  const RESOLUTIONS = {
    landscape:[["", "Match program (stream copy)"], ["1920x1080", "1920×1080"], ["1280x720", "1280×720"], ["960x540", "960×540"]],
    vertical:[["", "Match program (stream copy)"], ["1080x1920", "1080×1920"], ["720x1280", "720×1280"], ["540x960", "540×960"]],
  };
  const MODE_INFO = {
    source:["Source / Passthrough", "Raw OBS feed · stream copy · no overlays"],
    landscape:["Horizontal 16:9", "Overlay Studio 16:9 program"],
    vertical:["Vertical 9:16", "Overlay Studio 9:16 program"],
    custom:["Custom", "Any size, e.g. 1080×1350"],
  };

  async function caps() {
    if (!OUT.caps) OUT.caps = await api("/api/destinations/capabilities").catch(() => null);
    return OUT.caps;
  }

  function fmtBytes(bytes) {
    if (!(bytes > 0)) return "—";
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  }
  function fmtPct(v) { return v == null ? "—" : `${Math.round(v)}%`; }

  // ------------------------------------------------------ destination rows
  function outputLabel(d) {
    const o = d.output || {};
    if (!d.outputConfigured) return d.layout === "vertical" ? "9:16 VERTICAL" : d.layout === "landscape" ? "16:9 LANDSCAPE" : "SOURCE";
    if (o.mode === "source") return "PASSTHROUGH";
    const size = o.width && o.height ? ` ${o.width}×${o.height}` : "";
    return `${o.mode === "vertical" ? "9:16" : o.mode === "custom" ? "CUSTOM" : "16:9"}${size}${o.fps ? ` @${o.fps}` : ""}`;
  }

  function healthBadge(d) {
    const h = d.health;
    if (!d.enabled) return `<span class="badge">OFF</span>`;
    if (!h) return `<span class="badge purple">ENABLED</span>`;
    const map = { live:["green", "LIVE"], starting:["cyan", "STARTING"], waiting:["yellow", "WAITING"], reconnecting:["yellow", "RECONNECTING"], error:["", "ERROR"], idle:["", "IDLE"] };
    const [cls, label] = map[h.state] || ["", String(h.state || "").toUpperCase()];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  window.destinationRow = function destinationRow(d) {
    const platform = window.CastNexusDestinationPresets?.byId(d.platform) || (window.CastNexusDestinationPresets?.presets || []).find(p => String(d.name || "").toLowerCase().startsWith(p.name.toLowerCase())) || { mark:"↗", colour:"#8d73ff" };
    const h = d.health;
    const healthText = h ? [h.encoder ? `Encoder: ${h.encoder}` : "", h.restarts ? `${h.restarts} restart${h.restarts === 1 ? "" : "s"}` : "", h.state === "waiting" && h.waitReason ? h.waitReason : "", h.lastErrorKind && h.state !== "live" ? `Last error: ${h.lastErrorKind}` : ""].filter(Boolean).join(" · ") : "";
    const mode = d.output?.mode || d.layout;
    return `<div class="list-row destination-item"><div class="destination-icon" style="color:${esc(platform.colour)}">${esc(platform.mark)}</div><div class="item-main"><strong>${esc(d.name)}</strong><span>${esc(d.urlMasked || "")} · ${esc(d.route || "")}</span>${healthText ? `<span class="dest-health ${h?.lastErrorKind && h.state !== "live" ? "bad" : ""}">${esc(healthText)}</span>` : ""}</div><span class="badge ${mode === "vertical" ? "cyan" : mode === "source" ? "" : "purple"}">${esc(outputLabel(d))}</span>${healthBadge(d)}<div class="item-actions"><label class="toggle"><input type="checkbox" data-dest-toggle="${esc(d.id)}" ${d.enabled ? "checked" : ""}><span class="toggle-track"></span></label><button class="icon-button" data-edit-dest="${esc(d.id)}" title="Edit">✎</button><button class="icon-button" data-delete-dest="${esc(d.id)}" title="Delete">×</button></div></div>`;
  };

  // ------------------------------------------------ destination editor modal
  function outputForm(output, capabilities) {
    const o = output || { mode:"landscape" };
    const orientation = o.mode === "vertical" ? "vertical" : "landscape";
    const scenes = (capabilities?.scenes || []).filter(s => o.mode === "custom" || s.orientation === orientation);
    const res = o.width && o.height ? `${o.width}x${o.height}` : "";
    const resolutionChoices = RESOLUTIONS[orientation];
    const encoders = capabilities?.encoders || [{ id:"auto", label:"Auto", available:true }, { id:"cpu", label:"CPU x264", available:true }];
    const captionModes = capabilities?.captions?.modes || [{ id:"off", label:"Off", available:true }];
    const f = o.framing || {};
    return `
      <div class="full"><label>Output mode</label><div class="mode-pills">${Object.entries(MODE_INFO).map(([id, [label, sub]]) => `<button type="button" class="mode-pill ${o.mode === id ? "active" : ""}" data-out-mode="${id}">${esc(label)}<small>${esc(sub)}</small></button>`).join("")}</div></div>
      ${o.mode === "source" ? `<div class="full callout">Passthrough copies the incoming OBS/console stream as-is: no decode, no encode, no overlays. Audio is normalised to AAC (Twitch ingest keeps the original audio).</div>` : `
      <div class="dest-output-grid full">
        ${o.mode !== "custom" ? `<div><label>Scene</label><select id="out-scene"><option value="">Follow the live ${orientation === "vertical" ? "9:16" : "16:9"} scene</option>${scenes.map(s => `<option value="${esc(s.id)}" ${o.sceneId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>` : `<div><label>Scene</label><select id="out-scene"><option value="">Follow the live scene</option>${scenes.map(s => `<option value="${esc(s.id)}" ${o.sceneId === s.id ? "selected" : ""}>${esc(s.name)} · ${s.orientation === "vertical" ? "9:16" : "16:9"}</option>`).join("")}</select></div>`}
        ${o.mode === "custom" ? `<div><label>Width × Height</label><div style="display:flex;gap:6px"><input id="out-w" type="number" min="128" max="3840" step="2" value="${o.width || 1080}"><input id="out-h" type="number" min="128" max="3840" step="2" value="${o.height || 1350}"></div></div>` : `<div><label>Resolution</label><select id="out-res">${resolutionChoices.map(([v, l]) => `<option value="${v}" ${res === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`}
        <div><label>FPS</label><select id="out-fps"><option value="">Match program</option>${[24, 25, 30, 48, 50, 60].map(v => `<option ${Number(o.fps) === v ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div><label>Video encoder</label><select id="out-enc">${encoders.map(e => `<option value="${esc(e.id)}" ${o.videoEncoder === e.id ? "selected" : ""} ${e.available ? "" : "disabled"}>${esc(e.label)}${e.available ? "" : " (not available)"}</option>`).join("")}</select></div>
        <div><label>Video bitrate (kbps)</label><input id="out-vbr" type="number" min="300" max="50000" placeholder="Match program" value="${o.videoBitrateKbps || ""}"></div>
        <div><label>Audio</label><div style="display:flex;gap:6px"><select id="out-abr"><option value="">128 kbps</option>${[96, 160, 192, 256, 320].map(v => `<option value="${v}" ${Number(o.audioBitrateKbps) === v ? "selected" : ""}>${v} kbps</option>`).join("")}</select><select id="out-arate"><option value="">Default rate</option><option value="44100" ${o.audioRate === 44100 ? "selected" : ""}>44.1 kHz</option><option value="48000" ${o.audioRate === 48000 ? "selected" : ""}>48 kHz</option></select></div></div>
        <div class="full"><label>Caption mode</label><select id="out-cc">${captionModes.map(m => `<option value="${esc(m.id)}" ${o.captionMode === m.id ? "selected" : ""} ${m.available ? "" : "disabled"}>${esc(m.label)}${m.available ? "" : " (coming soon)"}</option>`).join("")}</select></div>
        ${o.mode !== "landscape" ? `<div class="full"><label>Gameplay framing when the compositor is off</label><div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px"><select id="out-fit">${[["fill", "Fill / crop"], ["fit", "Fit (blur bars)"], ["crop", "Crop"], ["stretch", "Stretch"]].map(([v, l]) => `<option value="${v}" ${(f.fit || "fill") === v ? "selected" : ""}>${l}</option>`).join("")}</select><input id="out-scale" type="number" step="0.05" min="0.1" max="8" value="${f.scale ?? 1}" title="Scale"><input id="out-ox" type="number" step="0.01" min="-1" max="1" value="${f.offsetX ?? 0}" title="Offset X"><input id="out-oy" type="number" step="0.01" min="-1" max="1" value="${f.offsetY ?? 0}" title="Offset Y"></div><small class="muted">With the compositor on, framing comes from the vertical scene's Gameplay layer in Overlay Studio.</small></div>` : ""}
      </div>`}
      <div class="full dest-route" id="out-route">…</div>`;
  }

  function readOutput(mode) {
    if (mode === "source") return { mode:"source" };
    const out = { mode };
    const scene = $("#out-scene")?.value;
    out.sceneId = scene || null;
    if (mode === "custom") { out.width = Number($("#out-w").value) || 1080; out.height = Number($("#out-h").value) || 1350; }
    else { const r = $("#out-res")?.value; if (r) { const [w, h] = r.split("x").map(Number); out.width = w; out.height = h; } }
    out.fps = $("#out-fps")?.value ? Number($("#out-fps").value) : null;
    out.videoEncoder = $("#out-enc")?.value || "auto";
    out.videoBitrateKbps = $("#out-vbr")?.value ? Number($("#out-vbr").value) : null;
    out.audioBitrateKbps = $("#out-abr")?.value ? Number($("#out-abr").value) : null;
    out.audioRate = $("#out-arate")?.value ? Number($("#out-arate").value) : null;
    out.captionMode = $("#out-cc")?.value || "off";
    if ($("#out-fit")) out.framing = { fit:$("#out-fit").value, scale:Number($("#out-scale").value) || 1, offsetX:Number($("#out-ox").value) || 0, offsetY:Number($("#out-oy").value) || 0 };
    return out;
  }

  function describeRoute(output, capabilities) {
    if (output.mode === "source") return "Stream copy of the raw OBS / console feed. Zero video CPU/GPU cost.";
    const orientation = output.mode === "vertical" || (output.mode === "custom" && output.height > output.width) ? "vertical" : "landscape";
    const program = capabilities?.programs?.[orientation] || {};
    const match = (!output.width || (output.width === program.width && output.height === program.height)) && (!output.fps || output.fps === program.fps) && !output.videoBitrateKbps && (output.videoEncoder || "auto") === "auto" && !["server", "burnin"].includes(output.captionMode);
    const compositorOn = !!S.compositor?.enabled;
    if (!compositorOn) return orientation === "vertical" || output.mode === "custom" ? "Compositor is off: FFmpeg converts the raw 16:9 feed using the framing below (one transcode)." : match ? "Compositor is off: stream copy of the raw feed." : "Compositor is off: one FFmpeg transcode of the raw feed.";
    return match
      ? `Shares the ${orientation === "vertical" ? "9:16" : "16:9"} program (${program.width}×${program.height}@${program.fps}) by stream copy - no extra encode.`
      : `Re-encodes the ${orientation === "vertical" ? "9:16" : "16:9"} program to ${output.width || program.width}×${output.height || program.height}@${output.fps || program.fps}. Destinations with identical settings share one encode.`;
  }

  window.openDestinationModal = async function openDestinationModal(dest = null) {
    const catalog = window.CastNexusDestinationPresets;
    const capabilities = await caps();
    let output = dest ? { ...(dest.output || { mode:"landscape" }) } : { mode:"landscape" };
    const renderForm = preset => {
      const automatic = !!preset?.autoUrl;
      const fullUrl = !!preset?.fullUrl;
      const draw = () => {
        modalShell(dest ? `Edit ${dest.name}` : preset.name, "OUTPUT ROUTE", `
          ${!dest ? `<button class="destination-back" id="dest-back" type="button">← All platforms</button><div class="destination-selected"><span class="platform-mark" style="--platform:${esc(preset.colour)}">${esc(preset.mark)}</span><div><strong>${esc(preset.name)}</strong><span>${esc(preset.help)}</span></div></div>` : ""}
          <div class="form-grid">
            <div class="full"><label>Name</label><input id="dest-name" value="${esc(dest?.name || preset?.name || "")}" placeholder="TikTok Vertical"></div>
            ${dest ? `<div class="full"><label>New complete URL (leave blank to keep current)</label><input id="dest-url" placeholder="rtmps://…" value=""></div>` : fullUrl ? `<div class="full"><label>Complete SRT URL</label><input id="dest-url" placeholder="srt://host:port?mode=caller…"></div>` : `${automatic ? `<div class="full"><label>RTMPS server · filled automatically</label><input id="dest-url" value="${esc(preset.autoUrl)}" readonly></div>` : `<div class="full"><label>RTMP / RTMPS server URL</label><input id="dest-url" placeholder="rtmps://…"></div>`}<div class="full"><label>Stream key</label><input id="dest-key" type="password" autocomplete="off" placeholder="Paste stream key"></div>`}
            ${outputForm(output, capabilities)}
          </div>
          ${dest && !dest.outputConfigured ? `<div class="callout" style="margin-top:12px">This destination still uses its original “${esc(dest.layout)}” layout. Saving here switches it to the new per-destination output settings.</div>` : ""}
          <div class="callout" style="margin-top:12px">Stream keys are secrets. CastNexus stores the completed destination server-side and masks it in the dashboard.</div>
          <div id="modal-error" class="form-error"></div>`, `<button class="btn btn-ghost" data-modal-close>Cancel</button><button class="btn btn-primary" id="dest-save">Save destination</button>`, true);
        $$("[data-modal-close]").forEach(b => b.onclick = closeModal);
        if ($("#dest-back")) $("#dest-back").onclick = renderPicker;
        const updateRoute = () => { const r = $("#out-route"); if (r) r.textContent = describeRoute(readOutput(output.mode), capabilities); };
        $$("[data-out-mode]").forEach(b => b.onclick = () => {
          const keep = { name:$("#dest-name").value, url:$("#dest-url")?.value, key:$("#dest-key")?.value };
          output = { ...readOutput(output.mode), mode:b.dataset.outMode, width:null, height:null };
          draw();
          $("#dest-name").value = keep.name; if ($("#dest-url") && keep.url !== undefined && !$("#dest-url").readOnly) $("#dest-url").value = keep.url; if ($("#dest-key") && keep.key) $("#dest-key").value = keep.key;
        });
        $$("#out-scene,#out-res,#out-fps,#out-enc,#out-vbr,#out-cc,#out-w,#out-h").forEach(el => el.addEventListener("change", updateRoute));
        updateRoute();
        $("#dest-save").onclick = async () => {
          const name = $("#dest-name").value.trim();
          const serverUrl = $("#dest-url").value.trim();
          const url = dest ? serverUrl : fullUrl ? serverUrl : catalog.destinationUrl(preset, serverUrl, $("#dest-key")?.value);
          const body = { name, output:readOutput(output.mode) };
          try {
            if (dest) { if (url) body.url = url; await api(`/api/destinations/${encodeURIComponent(dest.id)}`, { method:"PUT", body }); }
            else await api("/api/destinations", { method:"POST", body:{ ...body, url, platform:preset.id } });
            closeModal(); await refreshAndRender(); toast("Destination saved", "success");
          } catch (e) { $("#modal-error").textContent = e.message; }
        };
      };
      draw();
    };
    const renderPicker = () => {
      modalShell("Add destination", "CHOOSE A PLATFORM", `<p class="muted">Choose a service. CastNexus fills verified fixed ingest servers automatically; services that issue event-specific URLs will ask for both values.</p><div class="platform-grid">${catalog.presets.map(p => `<button class="platform-tile" type="button" data-platform="${esc(p.id)}"><span class="platform-mark" style="--platform:${esc(p.colour)}">${esc(p.mark)}</span><strong>${esc(p.name)}</strong><small>${p.autoUrl ? "SERVER AUTO-FILLED" : p.fullUrl ? "COMPLETE URL" : "URL + KEY"}</small></button>`).join("")}</div>`, "", true);
      $$('[data-modal-close]').forEach(b => b.onclick = closeModal);
      $$('[data-platform]').forEach(button => button.onclick = () => {
        const preset = catalog.byId(button.dataset.platform);
        // Vertical-first platforms default to a 9:16 output.
        if (/tiktok|instagram|shorts|kick-vertical|reels/i.test(preset.id + preset.name)) output = { mode:"vertical" };
        renderForm(preset);
      });
    };
    if (dest) renderForm({ id:"custom-rtmp", name:"Custom RTMP", mark:"RTMP", colour:"#8d73ff" });
    else renderPicker();
  };

  const baseRenderDestinations = window.renderDestinations;
  window.renderDestinations = function renderDestinations() {
    const html = baseRenderDestinations();
    return html.replace("Source/passthrough uses stream copy. Forced 16:9 or 9:16 uses FFmpeg video transcoding, so those routes consume more CPU/GPU.", "Source/Passthrough is a pure stream copy. Horizontal and Vertical destinations that “Match program” share one server-side render + encode per orientation; only destinations with a different size, FPS, bitrate or encoder re-encode, and identical ones share that encode too.");
  };

  // ------------------------------------------------ Music 24/7 performance
  function musicPerformancePanel() {
    const p = activeProfile();
    if (!p) return "";
    const perf = p.musicPerformance || {};
    const rt = S.status?.music24?.runtime || null;
    const vertical = p.canvasMode === "vertical";
    const sizes = vertical ? [[1080, 1920], [720, 1280], [540, 960]] : [[1920, 1080], [1280, 720], [960, 540]];
    const size = perf.width && perf.height ? `${perf.width}x${perf.height}` : "";
    const modes = [["auto", "Auto"], ["max", "Maximum Quality"], ["balanced", "Balanced"], ["low", "Low CPU"], ["ultra", "Ultra Low CPU"]];
    return `<section class="card-panel" style="margin-top:14px">
      <div class="card-title-row"><div><div class="eyebrow">MUSIC 24/7 RENDERER</div><h3>Performance & encoder</h3></div><span class="badge ${rt?.gpuEncoding ? "green" : "cyan"}">${rt ? (rt.gpuEncoding ? "GPU ENCODING" : "CPU ENCODING") : p.mode === "music" ? "NOT RUNNING" : "MUSIC PROFILES ONLY"}</span></div>
      <div class="props-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div><label>Performance mode</label><select id="mp-mode">${modes.map(([v, l]) => `<option value="${v}" ${(perf.mode || "auto") === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div><label>Music render FPS</label><select id="mp-render"><option value="">Mode default</option>${[10, 15, 20, 24, 30, 60].map(v => `<option ${Number(perf.renderFps) === v ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div><label>Output FPS</label><select id="mp-fps"><option value="">Auto (hardware test)</option>${[24, 30, 60].map(v => `<option ${Number(perf.fps) === v ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div><label>Resolution</label><select id="mp-size"><option value="">Auto (hardware test)</option>${sizes.map(([w, h]) => `<option value="${w}x${h}" ${size === `${w}x${h}` ? "selected" : ""}>${w}×${h}</option>`).join("")}</select></div>
        <div><label>Music encoder</label><select id="mp-enc">${[["auto", "Auto"], ["nvenc", "NVIDIA NVENC"], ["qsv", "Intel QuickSync"], ["vaapi", "VAAPI"], ["amf", "AMD AMF"], ["cpu", "CPU x264"]].map(([v, l]) => `<option value="${v}" ${(perf.encoder || "auto") === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div><label>Video bitrate (kbps)</label><input id="mp-br" type="number" min="500" max="20000" placeholder="3500" value="${perf.bitrateKbps || ""}"></div>
      </div>
      <p style="margin-top:8px">With <strong>Auto</strong> mode and <strong>Auto</strong> resolution, CastNexus tests this machine (Pi / VPS / PC, GPU encoder, real browser GPU, CPU speed) before the stream starts and pushes the best resolution, FPS and mode it can hold${rt?.autoTier ? ` - now <strong>${esc(rt.autoTier)}</strong> (${esc(rt.autoReason || "")})` : ""}. If the stream cannot keep up it steps down one level automatically. Audio quality is never reduced - only how often the visualiser redraws. Hardware encoders are probed first and fall back automatically (NVENC → QSV/VAAPI → x264).</p>
      ${rt ? `<div class="music-perf-status">
        <span>Encoder</span><strong>${esc(rt.encoder || "—")}${rt.encoderFallbackReason ? ` <small class="muted">(${esc(rt.encoderFallbackReason)})</small>` : ""}</strong>
        <span>Resolution</span><strong>${esc(rt.resolution || "—")}</strong>
        <span>Output FPS</span><strong>${esc(rt.fps ?? "—")}${rt.measuredEncodeFps != null ? ` <small class="muted">measured ${esc(rt.measuredEncodeFps)}</small>` : ""}</strong>
        <span>Render FPS</span><strong>${esc(rt.renderFps ?? "—")}${rt.measuredRenderFps != null ? ` <small class="muted">browser ${esc(rt.measuredRenderFps)}/s</small>` : ""}</strong>
        <span>Mode</span><strong>${esc(rt.performanceLabel || "—")} · spectrum ${esc(rt.spectrumHz ?? "—")} Hz · ${esc(rt.effects || "")}</strong>
        <span>CPU usage</span><strong>${rt.cpuPercent != null ? `${rt.cpuPercent}% of one core` : "measuring…"}</strong>
        <span>GPU encoding</span><strong>${rt.gpuEncoding ? "Active" : "Inactive"}</strong>
        <span>Memory</span><strong>${fmtBytes(rt.rssBytes)}</strong>
      </div>${rt.components?.length ? `<table class="perf-table"><tr><th>Component</th><th class="num">CPU</th><th class="num">RAM</th></tr>${rt.components.map(c => `<tr><td>${esc(c.label)}</td><td class="num">${c.cpuPercent == null ? "—" : `${c.cpuPercent}%`}</td><td class="num">${fmtBytes(c.rssBytes)}</td></tr>`).join("")}</table>` : ""}` : ""}
      <div class="page-actions" style="margin-top:12px"><button class="btn btn-primary btn-sm" id="mp-save">Save & apply</button></div>
    </section>`;
  }

  const baseRenderMusic = window.renderMusic;
  window.renderMusic = function renderMusicWithPerformance() {
    return baseRenderMusic() + musicPerformancePanel();
  };

  async function saveMusicPerformance() {
    const p = activeProfile();
    if (!p) return;
    const size = $("#mp-size").value;
    const [width, height] = size ? size.split("x").map(Number) : [null, null];
    p.musicPerformance = {
      mode:$("#mp-mode").value,
      renderFps:$("#mp-render").value ? Number($("#mp-render").value) : null,
      fps:$("#mp-fps").value ? Number($("#mp-fps").value) : null,
      width, height,
      encoder:$("#mp-enc").value,
      bitrateKbps:$("#mp-br").value ? Number($("#mp-br").value) : null,
    };
    try { await saveProfileStore(); toast("Music 24/7 settings saved - the renderer restarts with them in a few seconds", "success"); }
    catch (e) { toast(e.message, "error"); }
  }

  // --------------------------------------------------- system performance
  function perfPanel() {
    return `<div class="section-title">System performance</div><section class="card-panel" id="perf-panel"><p>Measuring…</p></section>`;
  }

  function renderPerf() {
    const el = $("#perf-panel");
    const d = OUT.perf;
    if (!el || !d) return;
    const g = d.groups || {};
    const m = d.music24?.runtime;
    const program = type => d.programs?.find(p => p.orientation === type);
    // Target size/fps plus what is really happening: frames the browser drew
    // and frames FFmpeg took in per second (a low encode rate = stutter).
    const progLabel = p => p ? `${p.width}×${p.height} @ ${p.fps} · ${p.state}${p.measuredEncodeFps != null ? ` · encoding ${p.measuredEncodeFps} fps` : ""}${p.measuredRenderFps != null ? ` · browser ${p.measuredRenderFps} fps` : ""}${p.measuredEncodeFps != null && p.measuredEncodeFps < p.renderFps * 0.8 ? " ⚠ below target" : ""}` : "not running";
    const hw = d.hardware;
    const hardwareHtml = hw ? `<div class="card-title-row" style="margin-top:14px"><div><h3>Hardware test</h3><p>${hw.probed ? `Tested ${esc(new Date(hw.probedAt).toLocaleString())} in ${(hw.probeMs / 1000).toFixed(1)} s.` : "Estimate - the first hardware test is still running."} Auto quality below is chosen from these results before any stream starts, and steps down automatically if a stream cannot keep up.</p></div><button class="btn btn-ghost btn-sm" id="hw-retest">Re-test hardware</button></div>
      <table class="perf-table">
        <tr><th>Host</th><td>${esc(hw.hostType?.label || "—")} · ${hw.cores} cores · ${esc(hw.cpuModel || "")}</td></tr>
        <tr><th>Video encoder</th><td>${esc(hw.encoder)}${hw.hardwareEncoder ? " (GPU)" : " (CPU)"}</td></tr>
        <tr><th>Browser rendering</th><td>${hw.chromiumGpu ? `GPU · ${esc(hw.chromiumRenderer || "")}` : `Software (CPU)${hw.chromiumRenderer ? ` · ${esc(hw.chromiumRenderer)}` : ""}${hw.chromiumReason ? ` · ${esc(hw.chromiumReason)}` : ""}`}</td></tr>
        <tr><th>CPU speed</th><td>${hw.x264MsPerFrame1080p} ms per 1080p x264 frame (${hw.cpuSpeedVsReference}× an i7-6700K core) · CastNexus budget ${hw.budget ? `${Math.round(hw.budget.share * 100)}% = ${hw.budget.cores.toFixed(1)} cores` : "—"}</td></tr>
        <tr><th>Auto · Music 24/7</th><td><strong>${hw.music.width}×${hw.music.height} @ ${hw.music.fps} fps · ${esc(hw.music.mode)}</strong> (~${hw.music.cores} cores)</td></tr>
        <tr><th>Auto · Overlay programs</th><td><strong>${hw.program.width}×${hw.program.height} @ ${hw.program.fps} fps</strong> (~${hw.program.cores} cores)${hw.sourceStream?.fps ? ` · source is ${hw.sourceStream.fps} fps, programs are capped to it` : ""}</td></tr>
        ${Object.keys(hw.tooHeavy || {}).some(k => hw.tooHeavy[k]?.length) ? `<tr><th>Stepped down</th><td>${esc(Object.entries(hw.tooHeavy).map(([k, v]) => `${k}: ${v.join(", ")} too heavy`).join(" · "))}</td></tr>` : ""}
      </table>` : "";
    el.innerHTML = hardwareHtml + `<div class="perf-grid" style="margin-top:12px">
      <div class="perf-tile"><div class="perf-k">System CPU</div><div class="perf-v">${fmtPct(d.system?.cpuPercent)}</div><div class="perf-s">${d.system?.cores || "?"} cores · load ${(d.system?.loadAverage || []).join(" / ")}</div></div>
      <div class="perf-tile"><div class="perf-k">RAM</div><div class="perf-v">${fmtBytes(d.system?.ramUsedBytes)}</div><div class="perf-s">of ${fmtBytes(d.system?.ramTotalBytes)}</div></div>
      <div class="perf-tile"><div class="perf-k">Program renderer</div><div class="perf-v">${g.program?.measured ? `${g.program.cpuPercent}%` : "—"}</div><div class="perf-s">${fmtBytes(g.program?.rssBytes)} · % of one core</div></div>
      <div class="perf-tile"><div class="perf-k">Music 24/7</div><div class="perf-v">${g.music24?.measured ? `${g.music24.cpuPercent}%` : "—"}</div><div class="perf-s">${m ? `${esc(m.encoder)} · ${esc(m.resolution)} @ ${esc(m.fps)}` : "idle"}</div></div>
    </div>
    <table class="perf-table">
      <tr><th>Encoder</th><td>${esc(d.encoder?.selected?.label || "—")}${d.encoder?.fallback ? " (software fallback)" : ""}</td></tr>
      <tr><th>Horizontal program</th><td>${esc(progLabel(program("landscape")))}${program("landscape")?.encoder ? ` · ${esc(program("landscape").encoder)}` : ""}</td></tr>
      <tr><th>Vertical program</th><td>${esc(progLabel(program("vertical")))}${program("vertical")?.encoder ? ` · ${esc(program("vertical").encoder)}` : ""}</td></tr>
      <tr><th>Destinations</th><td>${(d.destinations || []).filter(x => x.enabled).map(x => `${esc(x.name)} <strong>${esc((x.health?.state || (x.active ? "starting" : "off")).toUpperCase())}</strong>`).join(" · ") || "none enabled"}</td></tr>
    </table>
    ${(d.components || []).length ? `<table class="perf-table"><tr><th>Component</th><th class="num">CPU (one core)</th><th class="num">RAM</th></tr>${d.components.map(c => `<tr><td>${esc(c.label)}</td><td class="num">${c.cpuPercent == null ? "—" : `${c.cpuPercent}%`}</td><td class="num">${fmtBytes(c.rssBytes)}</td></tr>`).join("")}</table>` : ""}
    ${d.supported ? "" : `<p class="muted" style="margin-top:8px">Per-process CPU is available on Linux/Docker (and on Windows at a slower refresh).</p>`}`;
    const retest = $("#hw-retest");
    if (retest) retest.onclick = async () => {
      retest.disabled = true; retest.textContent = "Testing…";
      try { await api("/api/system/hardware/probe", { method:"POST" }); OUT.perf = await api("/api/system/performance"); renderPerf(); toast("Hardware re-tested - Auto streams use the new results", "success"); }
      catch (e) { toast(e.message, "error"); retest.disabled = false; retest.textContent = "Re-test hardware"; }
    };
  }

  function startPerfPolling() {
    stopPerfPolling();
    const tick = async () => {
      if (!["overview", "settings"].includes(S.page) || document.hidden) return;
      try { OUT.perf = await api("/api/system/performance"); renderPerf(); } catch {}
    };
    tick();
    // The server caches samples (2 s Linux / 15 s Windows), so 3 s is plenty.
    OUT.perfTimer = setInterval(tick, 3000);
  }
  function stopPerfPolling() { if (OUT.perfTimer) { clearInterval(OUT.perfTimer); OUT.perfTimer = null; } }

  const baseRenderOverview = window.renderOverview;
  window.renderOverview = function renderOverviewWithPerf() { return baseRenderOverview() + perfPanel(); };
  const baseRenderSettings = window.renderSettings;
  window.renderSettings = function renderSettingsWithPerf() { return baseRenderSettings() + perfPanel(); };

  // ------------------------------------------- Console / PC overlay panel
  function sourceOverlayPanel(kind) {
    const label = kind === "console" ? "Console" : "OBS / PC";
    return `<div class="section-title">${kind === "console" ? "Console overlays & layouts" : "Overlays & layouts"}</div>
    <section class="card-panel" id="source-overlay-panel" data-source-kind="${kind}">
      <div class="card-title-row"><div><h3>${esc(label)} feed → Overlay Studio program</h3><p>${kind === "console" ? "The captured console broadcast is the Gameplay layer of your scenes. CastNexus adds StreamElements alerts (with sound), chat, frames and Starting Soon/BRB/Ending on the server, and can send a separate 9:16 layout to vertical platforms - the console itself only streams once." : "OBS sends one master stream. CastNexus adds overlays, browser-source audio and horizontal/vertical layouts on the server."}</p></div><span class="badge ${S.compositor?.enabled ? "green" : ""}">${S.compositor?.enabled ? "OVERLAYS ON" : "OVERLAYS OFF"}</span></div>
      <div id="source-overlay-body"><p>Loading scenes…</p></div>
    </section>`;
  }

  async function fillSourceOverlayPanel() {
    const body = $("#source-overlay-body");
    if (!body) return;
    try { OUT.lib = await api("/api/scenes/library"); } catch (e) { body.innerHTML = `<div class="callout warn">${esc(e.message)}</div>`; return; }
    const lib = OUT.lib.library;
    const opts = o => lib.scenes.filter(s => s.orientation === o).map(s => `<option value="${esc(s.id)}" ${lib.live[o] === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("");
    const vScene = lib.scenes.find(s => s.id === lib.live.vertical);
    const vProgram = vScene?.layers.find(l => l.type === "program");
    const loginPart = encodeURIComponent(S.status?.twitchLogin || "");
    body.innerHTML = `
      <div class="props-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div><label>Live 16:9 scene</label><select data-src-live="landscape">${opts("landscape")}</select></div>
        <div><label>Live 9:16 scene</label><select data-src-live="vertical">${opts("vertical")}</select></div>
        <div><label>Vertical gameplay framing</label><select data-src-vfit ${vProgram ? "" : "disabled"}>${[["fill", "Fill / crop centre"], ["fit", "Fit whole picture"], ["crop", "Crop"], ["stretch", "Stretch"]].map(([v, l]) => `<option value="${v}" ${vProgram?.program?.fit === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      </div>
      <div class="section-title" style="margin-top:14px">Program</div>${sceneButtons()}
      <div class="program-previews" style="margin-top:12px"><div class="program-preview h"><span class="preview-label badge purple">16:9</span><iframe src="/overlay/${loginPart}/program/landscape?preview=1" loading="lazy" allow="autoplay"></iframe></div><div class="program-preview v"><span class="preview-label badge cyan">9:16</span><iframe src="/overlay/${loginPart}/program/vertical?preview=1" loading="lazy" allow="autoplay"></iframe></div></div>
      <div class="page-actions" style="margin-top:12px"><button class="btn btn-primary btn-sm" data-nav="studio">Open Overlay Studio</button><button class="btn btn-ghost btn-sm" data-nav="destinations">Destinations & layouts</button></div>
      ${kind() === "console" ? `<div class="callout" style="margin-top:12px">Console tip: PS5/Xbox broadcasts are 16:9. For TikTok/Shorts use a 9:16 destination - the vertical scene crops the gameplay instead of squashing it. Drag the gameplay in Overlay Studio (double-click it) to choose which part of the screen stays visible.</div>` : ""}`;
    function kind() { return $("#source-overlay-panel")?.dataset.sourceKind; }
    $$("[data-src-live]", body).forEach(sel => sel.onchange = async () => { try { await api("/api/scenes/library/live", { method:"POST", body:{ orientation:sel.dataset.srcLive, sceneId:sel.value } }); toast("Live scene switched", "success"); } catch (e) { toast(e.message, "error"); } });
    const fit = $("[data-src-vfit]", body);
    if (fit && vScene && vProgram) fit.onchange = async () => {
      vProgram.program = { ...(vProgram.program || {}), fit:fit.value };
      try { await api(`/api/scenes/library/scenes/${encodeURIComponent(vScene.id)}`, { method:"PUT", body:{ layers:vScene.layers } }); toast("Vertical framing updated", "success"); } catch (e) { toast(e.message, "error"); }
    };
    $$("[data-scene]", body).forEach(b => b.onclick = () => { try { setScene(JSON.parse(b.dataset.scene)); } catch {} });
    $$("[data-nav]", body).forEach(b => b.onclick = () => navigate(b.dataset.nav));
  }

  const baseConsole = window.renderConsoleSourceSetup;
  window.renderConsoleSourceSetup = function renderConsoleSourceSetupWithOverlays() { return baseConsole() + sourceOverlayPanel("console"); };
  const basePc = window.renderPcSourceSetup;
  window.renderPcSourceSetup = function renderPcSourceSetupWithOverlays() { return basePc() + sourceOverlayPanel("pc"); };

  // Scene buttons: add Offline next to the originals.
  const baseSceneButtons = window.sceneButtons;
  window.sceneButtons = function sceneButtonsWithOffline() {
    const html = baseSceneButtons();
    const active = S.scene?.kind === "builtin" && S.scene.name === "offline";
    return html.replace(/<\/div>$/, `<button class="scene-button ${active ? "active" : ""}" data-scene='${esc(JSON.stringify({ kind:"builtin", name:"offline" }))}'>Offline</button></div>`);
  };

  // ------------------------------------------------------------- wiring
  const baseWirePage = window.wirePage;
  window.wirePage = function wirePageWithOutputs() {
    baseWirePage();
    const save = $("#mp-save");
    if (save) save.onclick = saveMusicPerformance;
    if ($("#source-overlay-panel")) fillSourceOverlayPanel();
    if ($("#perf-panel")) startPerfPolling(); else stopPerfPolling();
  };
})();
