const { escapeHtml, cssUrl, SCENE_BASE_CSS, sceneStyleVars } = require("./scenes");

// ---------------------------------------------------------------------------
// Full radio/music scene, adapted from CacheStream's docker branch.
//
// Key behavior ported:
// - 48 FFT bars at 30 FPS (matching the compositor capture rate)
// - Web Audio AnalyserNode, fftSize 256, smoothing 0.78
// - procedural animated fallback while idle / if analysis cannot start
// - animated vinyl + metadata + progress + clock
// - optional full-screen background image
// - same server-authoritative track timeline RestreamNode already uses
//
// In OBS this page emits the music audio as before. In the built-in compositor
// Chromium itself is launched with --mute-audio and music is mixed server-side,
// so rendering this scene cannot double the outgoing audio.

function musicSceneFragment(login, cfg = {}, query = {}, account) {
  const accent = query.accent || cfg.accent || "#00f0ff";
  const backgroundUrl = query.background || query.bg || cfg.backgroundUrl || cfg.background || "";
  const station = query.station || cfg.station || `${account?.displayName || account?.twitchLogin || "RestreamNode"} Radio`;
  const fallbackTitle = query.title || cfg.title || "RestreamNode Radio";
  const coverUrl = query.cover || cfg.coverUrl || account?.profileImageUrl || "";
  const bg = backgroundUrl ? `<div class="rn-music-bg" style="background-image:url(${cssUrl(backgroundUrl)})"></div>` : "";
  return `
    <style>
      ${SCENE_BASE_CSS}
      .rn-music-stage { display:grid; grid-template-rows:1fr auto; background:#04050a; }
      .rn-music-bg { position:absolute; inset:0; z-index:-4; background-size:cover; background-position:center; filter:saturate(.85); }
      .rn-music-bg::after { content:""; position:absolute; inset:0; background:rgba(4,5,10,.62); }
      .rn-music-stage::after { content:""; position:absolute; inset:0; pointer-events:none; z-index:0; background:repeating-linear-gradient(0deg,rgba(0,240,255,.022) 0 1px,transparent 1px 4px); mix-blend-mode:overlay; }
      .rn-music-top { position:relative; z-index:2; display:grid; grid-template-columns:minmax(300px,480px) 1fr; gap:64px; align-items:center; padding:64px 80px 24px; min-height:0; }
      .rn-cover-wrap { position:relative; width:min(35vw,480px); aspect-ratio:1; max-width:480px; }
      .rn-cover { position:absolute; inset:0; z-index:2; width:100%; height:100%; object-fit:cover; border-radius:8px; border:1px solid var(--rn-accent-line); box-shadow:0 0 0 1px rgba(0,240,255,.05) inset,0 0 80px var(--rn-accent),0 0 160px rgba(138,43,255,.18); background:linear-gradient(135deg,var(--rn-accent),rgba(138,43,255,.18)); }
      .rn-cover-placeholder { position:absolute; inset:0; z-index:1; border-radius:8px; border:1px dashed var(--rn-accent-line); display:flex; align-items:center; justify-content:center; font-size:96px; color:var(--rn-accent-solid); background:radial-gradient(circle at 50% 50%,var(--rn-accent),rgba(5,6,10,.95)); text-shadow:0 0 18px var(--rn-accent-glow); }
      .rn-vinyl { position:absolute; z-index:0; top:50%; right:-25%; width:75%; aspect-ratio:1; border-radius:50%; transform:translateY(-50%); opacity:.72; border:1px solid var(--rn-accent-line); box-shadow:0 0 60px rgba(0,0,0,.65); background:radial-gradient(circle at 50% 50%,#131722 0 14%,#06080f 14.5% 16%,#131722 16.5% 23%,#06080f 23.5% 24.5%,#131722 25% 37%,#06080f 37.5% 38.5%,#131722 39% 49%,#06080f 50%); animation:rn-vinyl-spin 18s linear infinite; }
      @keyframes rn-vinyl-spin { from { transform:translateY(-50%) rotate(0); } to { transform:translateY(-50%) rotate(360deg); } }
      .rn-music-meta { min-width:0; display:flex; flex-direction:column; gap:12px; }
      .rn-music-badge { width:fit-content; display:inline-flex; align-items:center; gap:8px; padding:6px 14px; border:1px solid var(--rn-accent-line); border-radius:999px; background:rgba(5,6,10,.58); color:var(--rn-accent-solid); font-size:12px; letter-spacing:.32em; text-transform:uppercase; }
      .rn-music-title { font-size:clamp(2.4rem,4.6vw,4.4rem); font-weight:800; line-height:1.1; letter-spacing:-.01em; text-shadow:0 0 18px var(--rn-accent-glow); overflow:hidden; text-overflow:ellipsis; }
      .rn-music-artist { font-size:clamp(1.2rem,2vw,1.6rem); color:rgba(230,247,255,.8); letter-spacing:.04em; }
      .rn-progress { width:min(720px,100%); height:4px; background:rgba(255,255,255,.10); border-radius:999px; overflow:hidden; margin-top:10px; }
      .rn-progress > span { display:block; width:0%; height:100%; background:linear-gradient(90deg,var(--rn-accent-solid),#8a2bff,#ff2bd6); transition:width .35s linear; }
      .rn-time { margin-top:2px; font-family:"JetBrains Mono",monospace; font-size:11px; letter-spacing:.12em; color:rgba(230,247,255,.45); }
      .rn-vis-wrap { position:relative; z-index:2; height:210px; padding:0 64px 52px; }
      #rn-spectrum { width:100%; height:100%; display:block; filter:drop-shadow(0 0 14px var(--rn-accent-glow)); }
      .rn-station { position:absolute; bottom:54px; left:80px; z-index:3; font-size:10px; letter-spacing:.42em; text-transform:uppercase; color:rgba(230,247,255,.36); }
      .rn-clock { position:absolute; bottom:54px; right:80px; z-index:3; font-family:"JetBrains Mono",monospace; font-size:11px; letter-spacing:.18em; color:rgba(230,247,255,.45); }
      @media (max-width:1000px) { .rn-music-top{grid-template-columns:1fr;gap:24px;padding:44px}.rn-cover-wrap{width:min(50vw,380px);justify-self:center}.rn-music-meta{align-items:center;text-align:center}.rn-vis-wrap{height:170px;padding:0 32px 45px}.rn-station{left:42px;bottom:48px}.rn-clock{right:42px;bottom:48px} }
    </style>
    <main class="rn-music-stage" style="${sceneStyleVars(accent)}">
      ${bg}<div class="rn-wash"></div><div class="rn-grid"></div><div class="rn-scanlines"></div>
      <div class="rn-music-top">
        <div class="rn-cover-wrap">
          <div class="rn-vinyl"></div>
          <div id="rn-cover-placeholder" class="rn-cover-placeholder">&#9835;</div>
          ${coverUrl ? `<img id="rn-cover" class="rn-cover" src="${escapeHtml(coverUrl)}" alt="" onerror="this.style.display='none'">` : ""}
        </div>
        <div class="rn-music-meta">
          <span class="rn-music-badge"><span class="rn-pulse"></span><span id="rn-mode">ON AIR · NOW PLAYING</span></span>
          <div id="rn-track-title" class="rn-music-title">${escapeHtml(fallbackTitle)}</div>
          <div id="rn-track-artist" class="rn-music-artist">—</div>
          <div class="rn-progress"><span id="rn-progress-bar"></span></div>
          <div id="rn-track-time" class="rn-time">00:00 / 00:00</div>
        </div>
      </div>
      <div class="rn-vis-wrap">
        <span class="rn-station">${escapeHtml(station)}</span>
        <canvas id="rn-spectrum"></canvas>
        <span id="rn-clock" class="rn-clock"></span>
      </div>
      <audio id="rn-music-audio" playsinline preload="auto" crossorigin="anonymous"></audio>
    </main>
    <script>
      (function () {
        var POLL_MS = 1000, BAR_COUNT = 48, RENDER_FPS = 30;
        var audio = document.getElementById("rn-music-audio");
        var canvas = document.getElementById("rn-spectrum");
        var analyser = null, audioContext = null, source = null, gain = null;
        var loadedTrackId = null, currentNow = null;
        function fmt(sec) {
          sec = Math.max(0, Number(sec) || 0);
          var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
          return String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
        }
        function ensureGraph() {
          if (audioContext) return;
          try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            audioContext = new AC();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.78;
            gain = audioContext.createGain();
            source = audioContext.createMediaElementSource(audio);
            source.connect(analyser);
            analyser.connect(gain);
            gain.connect(audioContext.destination);
            if (audioContext.state === "suspended") audioContext.resume().catch(function () {});
          } catch (e) { analyser = null; }
        }
        function apply(now) {
          currentNow = now;
          var playing = now && now.mode === "playing" && now.track;
          document.getElementById("rn-mode").textContent = playing ? "ON AIR · NOW PLAYING" : "ON AIR · SILENCE";
          document.getElementById("rn-track-title").textContent = playing ? (now.track.title || "Untitled") : ${JSON.stringify(fallbackTitle)};
          document.getElementById("rn-track-artist").textContent = playing ? (now.track.artist || "—") : "—";
          var pos = playing ? Number(now.positionS || 0) : 0;
          var dur = playing ? Number(now.durationS || 0) : 0;
          document.getElementById("rn-track-time").textContent = fmt(pos) + " / " + fmt(dur);
          document.getElementById("rn-progress-bar").style.width = dur > 0 ? Math.max(0, Math.min(100, pos / dur * 100)) + "%" : "0%";
          if (!playing) { if (!audio.paused) audio.pause(); return; }
          ensureGraph();
          var vol = Math.max(0, Math.min(1, Number(now.volume == null ? .7 : now.volume)));
          if (gain) gain.gain.value = vol; else audio.volume = vol;
          if (now.track.id !== loadedTrackId) {
            loadedTrackId = now.track.id;
            audio.src = ${JSON.stringify(`/overlay/${encodeURIComponent(login)}/music/file/`)} + encodeURIComponent(now.track.id);
            var wanted = Math.max(0, Number(now.positionS || 0));
            var seek = function () {
              try { audio.currentTime = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.min(wanted, Math.max(0, audio.duration - .05)) : wanted; } catch (e) {}
              audio.play().catch(function () {});
              audio.removeEventListener("loadedmetadata", seek);
            };
            audio.addEventListener("loadedmetadata", seek);
            audio.play().catch(function () {});
          } else if (Math.abs((audio.currentTime || 0) - pos) > 2.5) {
            try { audio.currentTime = pos; } catch (e) {}
          }
        }
        function poll() {
          fetch(${JSON.stringify(`/overlay/${encodeURIComponent(login)}/music/now.json`)}, { cache:"no-store" })
            .then(function (r) { return r.json(); }).then(apply).catch(function () {});
        }
        function sampleBars(data, n) {
          var step = Math.max(1, Math.floor(data.length / n)), bars = [];
          for (var i=0;i<n;i++) { var sum=0, count=0; for(var j=0;j<step && i*step+j<data.length;j++){sum+=data[i*step+j];count++;} bars.push(count ? sum/count/255 : 0); }
          return bars;
        }
        function procedural(n) {
          var t = performance.now()/600, bars=[];
          for(var i=0;i<n;i++){var base=.32+.14*Math.sin(t+i*.18), wob=.18*Math.sin(t*1.7+i*.43);bars.push(Math.max(.05,base+wob));}
          return bars;
        }
        function drawBars(ctx,bars,w,h) {
          var dpr=window.devicePixelRatio||1, gap=4*dpr, barW=(w-gap*(bars.length-1))/bars.length;
          var grad=ctx.createLinearGradient(0,h,0,0); grad.addColorStop(0,"rgba(0,240,255,.95)"); grad.addColorStop(.6,"rgba(138,43,255,.85)"); grad.addColorStop(1,"rgba(255,43,214,.85)");
          ctx.fillStyle=grad;
          for(var i=0;i<bars.length;i++){var barH=Math.max(2,bars[i]*h),x=i*(barW+gap),y=h-barH;ctx.fillRect(x,y,barW,barH);}
          ctx.globalAlpha=.18; ctx.scale(1,-1);
          for(var k=0;k<bars.length;k++){var bh=Math.max(2,bars[k]*h),xx=k*(barW+gap);ctx.fillRect(xx,-h-bh*.7,barW,bh*.7);}
          ctx.setTransform(1,0,0,1,0,0); ctx.globalAlpha=1;
        }
        function draw() {
          if (!canvas) return;
          var ctx=canvas.getContext("2d"); if(!ctx)return;
          var dpr=window.devicePixelRatio||1, w=Math.max(1,Math.floor(canvas.clientWidth*dpr)), h=Math.max(1,Math.floor(canvas.clientHeight*dpr));
          if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;ctx.clearRect(0,0,w,h);
          var bars;
          if(analyser && currentNow && currentNow.mode==="playing"){var data=new Uint8Array(analyser.frequencyBinCount);analyser.getByteFrequencyData(data);bars=sampleBars(data,BAR_COUNT);}else{bars=procedural(BAR_COUNT);}
          drawBars(ctx,bars,w,h);
        }
        function clock() { var el=document.getElementById("rn-clock"); if(el)el.textContent=new Date().toLocaleTimeString("en-GB",{hour12:false}); }
        poll(); clock();
        window.__rnMusicPoll && clearInterval(window.__rnMusicPoll); window.__rnMusicPoll=setInterval(poll,POLL_MS);
        window.__rnMusicDraw && clearInterval(window.__rnMusicDraw); window.__rnMusicDraw=setInterval(draw,1000/RENDER_FPS);
        window.__rnMusicClock && clearInterval(window.__rnMusicClock); window.__rnMusicClock=setInterval(clock,1000);
        draw();
      })();
    </script>`;
}

module.exports = { musicSceneFragment };
