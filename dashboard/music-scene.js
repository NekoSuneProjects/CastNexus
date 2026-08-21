const { escapeHtml, cssUrl, SCENE_BASE_CSS, sceneStyleVars } = require("./scenes");

// CastNexus 24/7 radio scene.
// The layout intentionally stays landscape-first at small iframe sizes so the
// dashboard preview matches the real 16:9 broadcast instead of switching into
// a stacked mobile layout that can make the spectrum overlap the cover.
function musicSceneFragment(login, cfg = {}, query = {}, account) {
  const accent = query.accent || cfg.accent || "#00f0ff";
  const backgroundUrl = query.background || query.bg || cfg.backgroundUrl || cfg.background || "";
  const station = query.station || cfg.station || `${account?.displayName || account?.twitchLogin || "CastNexus"} Radio`;
  const fallbackTitle = query.title || cfg.title || "CastNexus Radio";
  const coverUrl = query.cover || cfg.coverUrl || account?.profileImageUrl || "";
  const bg = backgroundUrl ? `<div class="rn-music-bg" style="background-image:url(${cssUrl(backgroundUrl)})"></div>` : "";

  return `
    <style>
      ${SCENE_BASE_CSS}

      .rn-music-stage {
        position:relative;
        display:grid;
        grid-template-rows:minmax(0,1fr) auto;
        min-height:100vh;
        overflow:hidden;
        background:#04050a;
        padding:clamp(18px,4vh,70px) clamp(20px,4vw,80px) clamp(16px,3vh,48px);
      }
      .rn-music-bg {
        position:absolute;
        inset:0;
        z-index:-4;
        background-size:cover;
        background-position:center;
        filter:saturate(.9) contrast(1.04);
        transform:scale(1.02);
      }
      .rn-music-bg::after {
        content:"";
        position:absolute;
        inset:0;
        background:linear-gradient(90deg,rgba(4,5,10,.82),rgba(4,5,10,.48) 55%,rgba(4,5,10,.68));
      }
      .rn-music-stage::after {
        content:"";
        position:absolute;
        inset:0;
        pointer-events:none;
        z-index:0;
        background:repeating-linear-gradient(0deg,rgba(0,240,255,.018) 0 1px,transparent 1px 5px);
        mix-blend-mode:screen;
      }

      .rn-music-main {
        position:relative;
        z-index:2;
        min-height:0;
        display:grid;
        grid-template-columns:minmax(0,.82fr) minmax(0,1.18fr);
        gap:clamp(28px,5vw,92px);
        align-items:center;
      }

      .rn-art-column {
        min-width:0;
        display:grid;
        place-items:center;
      }
      .rn-cover-wrap {
        position:relative;
        width:min(34vw,48vh,500px);
        min-width:0;
        aspect-ratio:1;
      }
      .rn-cover-halo {
        position:absolute;
        inset:-12%;
        z-index:-2;
        border-radius:50%;
        background:radial-gradient(circle,var(--rn-accent-glow),transparent 64%);
        filter:blur(18px);
        opacity:.62;
      }
      .rn-cover {
        position:absolute;
        inset:0;
        z-index:3;
        width:100%;
        height:100%;
        object-fit:cover;
        border-radius:clamp(12px,1.2vw,24px);
        border:1px solid var(--rn-accent-line);
        box-shadow:0 24px 80px rgba(0,0,0,.48),0 0 50px var(--rn-accent),inset 0 1px rgba(255,255,255,.08);
        background:linear-gradient(135deg,var(--rn-accent),rgba(138,43,255,.18));
      }
      .rn-cover-placeholder {
        position:absolute;
        inset:0;
        z-index:2;
        border-radius:clamp(12px,1.2vw,24px);
        border:1px solid var(--rn-accent-line);
        display:flex;
        align-items:center;
        justify-content:center;
        font-size:clamp(48px,8vw,120px);
        color:var(--rn-accent-solid);
        background:radial-gradient(circle at 42% 36%,var(--rn-accent),rgba(5,6,10,.96) 66%);
        text-shadow:0 0 24px var(--rn-accent-glow);
      }
      .rn-vinyl {
        position:absolute;
        z-index:1;
        top:50%;
        right:-29%;
        width:78%;
        aspect-ratio:1;
        border-radius:50%;
        transform:translateY(-50%);
        opacity:.78;
        border:1px solid var(--rn-accent-line);
        box-shadow:0 18px 58px rgba(0,0,0,.62),0 0 34px rgba(0,240,255,.06);
        background:
          radial-gradient(circle at 50% 50%,var(--rn-accent-solid) 0 4%,#0a0d14 4.5% 13%,#171c29 13.5% 16%,#070910 16.5% 22%,#151a25 22.5% 32%,#070910 32.5% 34%,#151a25 34.5% 46%,#070910 46.5% 48%,#111621 48.5% 64%,#06080d 64.5% 66%,#11151e 66.5%);
        animation:rn-vinyl-spin 16s linear infinite;
      }
      @keyframes rn-vinyl-spin {
        from { transform:translateY(-50%) rotate(0); }
        to { transform:translateY(-50%) rotate(360deg); }
      }

      .rn-music-meta {
        min-width:0;
        display:flex;
        flex-direction:column;
        justify-content:center;
        gap:clamp(5px,1vh,13px);
      }
      .rn-music-badge {
        width:fit-content;
        display:inline-flex;
        align-items:center;
        gap:8px;
        padding:clamp(5px,.7vh,8px) clamp(10px,1.2vw,16px);
        border:1px solid var(--rn-accent-line);
        border-radius:999px;
        background:rgba(5,6,10,.58);
        color:var(--rn-accent-solid);
        font-size:clamp(8px,.72vw,12px);
        font-weight:800;
        letter-spacing:.24em;
        text-transform:uppercase;
        box-shadow:inset 0 1px rgba(255,255,255,.04);
      }
      .rn-music-title {
        max-width:100%;
        font-size:clamp(22px,4.2vw,78px);
        font-weight:850;
        line-height:1.02;
        letter-spacing:-.035em;
        text-shadow:0 0 22px var(--rn-accent-glow);
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
      }
      .rn-music-artist {
        max-width:100%;
        font-size:clamp(12px,1.55vw,28px);
        color:rgba(230,247,255,.72);
        letter-spacing:.035em;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
      }
      .rn-progress {
        width:min(760px,100%);
        height:clamp(3px,.45vh,6px);
        background:rgba(255,255,255,.10);
        border-radius:999px;
        overflow:hidden;
        margin-top:clamp(2px,.7vh,8px);
      }
      .rn-progress > span {
        display:block;
        width:0%;
        height:100%;
        border-radius:inherit;
        background:linear-gradient(90deg,var(--rn-accent-solid),#8a2bff,#ff2bd6);
        box-shadow:0 0 16px var(--rn-accent-glow);
        transition:width .35s linear;
      }
      .rn-time {
        margin-top:1px;
        font-family:"JetBrains Mono",ui-monospace,monospace;
        font-size:clamp(8px,.68vw,12px);
        letter-spacing:.10em;
        color:rgba(230,247,255,.42);
      }

      .rn-spectrum-shell {
        width:100%;
        min-width:0;
        height:clamp(64px,18vh,190px);
        margin-top:clamp(7px,1.3vh,16px);
        padding:clamp(8px,1.2vh,14px) clamp(10px,1.2vw,18px) clamp(8px,1vh,12px);
        position:relative;
        overflow:hidden;
        border:1px solid rgba(255,255,255,.075);
        border-radius:clamp(10px,1vw,18px);
        background:linear-gradient(180deg,rgba(7,11,21,.66),rgba(3,6,13,.42));
        box-shadow:inset 0 1px rgba(255,255,255,.025),0 14px 38px rgba(0,0,0,.16);
      }
      .rn-spectrum-shell::before {
        content:"LIVE SPECTRUM";
        position:absolute;
        top:clamp(5px,.7vh,9px);
        left:clamp(8px,1vw,14px);
        z-index:2;
        font-size:clamp(6px,.52vw,9px);
        font-weight:800;
        letter-spacing:.22em;
        color:rgba(230,247,255,.28);
      }
      .rn-spectrum-shell::after {
        content:"";
        position:absolute;
        left:clamp(10px,1.2vw,18px);
        right:clamp(10px,1.2vw,18px);
        bottom:clamp(8px,1vh,12px);
        height:1px;
        background:linear-gradient(90deg,transparent,var(--rn-accent-line),transparent);
      }
      #rn-spectrum {
        width:100%;
        height:100%;
        display:block;
        filter:drop-shadow(0 0 9px var(--rn-accent-glow));
      }

      .rn-music-footer {
        position:relative;
        z-index:3;
        min-width:0;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:18px;
        padding-top:clamp(8px,1.8vh,22px);
      }
      .rn-station {
        min-width:0;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        font-size:clamp(7px,.66vw,11px);
        font-weight:800;
        letter-spacing:.34em;
        text-transform:uppercase;
        color:rgba(230,247,255,.34);
      }
      .rn-clock {
        flex:0 0 auto;
        font-family:"JetBrains Mono",ui-monospace,monospace;
        font-size:clamp(8px,.7vw,12px);
        letter-spacing:.16em;
        color:rgba(230,247,255,.42);
      }

      /* Keep 16:9 previews landscape. Only genuinely narrow/portrait windows stack. */
      @media (max-aspect-ratio:4/5) {
        .rn-music-stage { overflow:auto; }
        .rn-music-main { grid-template-columns:1fr; gap:28px; }
        .rn-cover-wrap { width:min(70vw,42vh,440px); }
        .rn-music-meta { align-items:center; text-align:center; }
        .rn-spectrum-shell { width:min(760px,100%); }
      }
      @media (max-height:360px) and (min-aspect-ratio:4/3) {
        .rn-music-stage { padding-top:12px; padding-bottom:10px; }
        .rn-cover-wrap { width:min(30vw,43vh,360px); }
        .rn-spectrum-shell { height:58px; margin-top:4px; }
        .rn-music-badge { padding:4px 9px; }
        .rn-music-footer { padding-top:6px; }
      }
    </style>

    <main class="rn-music-stage" style="${sceneStyleVars(accent)}">
      ${bg}
      <div class="rn-wash"></div>
      <div class="rn-grid"></div>
      <div class="rn-scanlines"></div>

      <div class="rn-music-main">
        <div class="rn-art-column">
          <div class="rn-cover-wrap">
            <div class="rn-cover-halo"></div>
            <div class="rn-vinyl"></div>
            <div id="rn-cover-placeholder" class="rn-cover-placeholder">&#9835;</div>
            ${coverUrl ? `<img id="rn-cover" class="rn-cover" src="${escapeHtml(coverUrl)}" alt="" onerror="this.style.display='none'">` : ""}
          </div>
        </div>

        <div class="rn-music-meta">
          <span class="rn-music-badge"><span class="rn-pulse"></span><span id="rn-mode">ON AIR · NOW PLAYING</span></span>
          <div id="rn-track-title" class="rn-music-title">${escapeHtml(fallbackTitle)}</div>
          <div id="rn-track-artist" class="rn-music-artist">—</div>
          <div class="rn-progress"><span id="rn-progress-bar"></span></div>
          <div id="rn-track-time" class="rn-time">00:00 / 00:00</div>
          <div class="rn-spectrum-shell"><canvas id="rn-spectrum"></canvas></div>
        </div>
      </div>

      <div class="rn-music-footer">
        <span class="rn-station">${escapeHtml(station)}</span>
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
        var displayBars = new Array(BAR_COUNT).fill(.03);

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
            analyser.smoothingTimeConstant = .82;
            analyser.minDecibels = -88;
            analyser.maxDecibels = -18;
            gain = audioContext.createGain();
            source = audioContext.createMediaElementSource(audio);
            source.connect(analyser);
            analyser.connect(gain);
            gain.connect(audioContext.destination);
            if (audioContext.state === "suspended") audioContext.resume().catch(function () {});
          } catch (e) {
            analyser = null;
          }
        }

        function apply(now) {
          currentNow = now;
          var playing = now && now.mode === "playing" && now.track;
          document.getElementById("rn-mode").textContent = playing ? "ON AIR · NOW PLAYING" : "ON AIR · STANDBY";
          document.getElementById("rn-track-title").textContent = playing ? (now.track.title || "Untitled") : ${JSON.stringify(fallbackTitle)};
          document.getElementById("rn-track-artist").textContent = playing ? (now.track.artist || "—") : "Waiting for the next track";

          var pos = playing ? Number(now.positionS || 0) : 0;
          var dur = playing ? Number(now.durationS || 0) : 0;
          document.getElementById("rn-track-time").textContent = fmt(pos) + " / " + fmt(dur);
          document.getElementById("rn-progress-bar").style.width = dur > 0 ? Math.max(0, Math.min(100, pos / dur * 100)) + "%" : "0%";

          if (!playing) {
            if (!audio.paused) audio.pause();
            return;
          }

          ensureGraph();
          var vol = Math.max(0, Math.min(1, Number(now.volume == null ? .7 : now.volume)));
          if (gain) gain.gain.value = vol; else audio.volume = vol;

          if (now.track.id !== loadedTrackId) {
            loadedTrackId = now.track.id;
            audio.src = ${JSON.stringify(`/overlay/${encodeURIComponent(login)}/music/file/`)} + encodeURIComponent(now.track.id);
            var wanted = Math.max(0, Number(now.positionS || 0));
            var seek = function () {
              try {
                audio.currentTime = Number.isFinite(audio.duration) && audio.duration > 0
                  ? Math.min(wanted, Math.max(0, audio.duration - .05))
                  : wanted;
              } catch (e) {}
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
            .then(function (r) { return r.json(); })
            .then(apply)
            .catch(function () {});
        }

        // Average logarithmically-sized frequency bands and gently compensate
        // the upper bands. This avoids the old "huge bass bars then flatline"
        // shape while still reflecting the actual track energy.
        function analyseBars(data, n) {
          var bars = [];
          var usable = Math.max(8, Math.floor(data.length * .82));
          for (var i = 0; i < n; i++) {
            var p0 = i / n, p1 = (i + 1) / n;
            var start = Math.floor(Math.pow(p0, 1.55) * usable);
            var end = Math.max(start + 1, Math.floor(Math.pow(p1, 1.55) * usable));
            var sum = 0, count = 0;
            for (var j = start; j < end && j < data.length; j++) {
              sum += data[j];
              count++;
            }
            var raw = count ? (sum / count) / 255 : 0;
            var compensation = .82 + (i / Math.max(1, n - 1)) * .58;
            bars.push(Math.min(1, Math.pow(raw * compensation, .82)));
          }
          return bars;
        }

        function procedural(n) {
          var t = performance.now() / 680, bars = [];
          for (var i = 0; i < n; i++) {
            var envelope = .34 + .12 * Math.sin(i * .19 + .8);
            var wave = .09 * Math.sin(t * 1.55 + i * .39) + .055 * Math.sin(t * .82 - i * .21);
            bars.push(Math.max(.055, Math.min(.55, envelope + wave)));
          }
          return bars;
        }

        function smoothBars(target) {
          for (var i = 0; i < BAR_COUNT; i++) {
            var next = Number(target[i] || 0);
            var current = displayBars[i] || 0;
            var speed = next > current ? .42 : .14;
            displayBars[i] = current + (next - current) * speed;
          }
          return displayBars;
        }

        function roundedBar(ctx, x, y, w, h, radius) {
          if (h <= 0 || w <= 0) return;
          if (typeof ctx.roundRect === "function") {
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, Math.min(radius, w / 2, h / 2));
            ctx.fill();
          } else {
            ctx.fillRect(x, y, w, h);
          }
        }

        function drawBars(ctx, bars, w, h, dpr) {
          var padX = 2 * dpr;
          var padTop = 14 * dpr;
          var padBottom = 3 * dpr;
          var drawH = Math.max(1, h - padTop - padBottom);
          var gap = Math.max(2, 3.2 * dpr);
          var barW = Math.max(1, (w - padX * 2 - gap * (bars.length - 1)) / bars.length);
          var grad = ctx.createLinearGradient(0, h, 0, padTop);
          grad.addColorStop(0, "rgba(0,240,255,.96)");
          grad.addColorStop(.55, "rgba(111,88,255,.92)");
          grad.addColorStop(1, "rgba(255,43,214,.92)");
          ctx.fillStyle = grad;
          ctx.shadowColor = "rgba(0,240,255,.22)";
          ctx.shadowBlur = 7 * dpr;

          for (var i = 0; i < bars.length; i++) {
            var level = Math.max(.025, Math.min(1, bars[i]));
            var barH = Math.max(2 * dpr, level * drawH);
            var x = padX + i * (barW + gap);
            var y = h - padBottom - barH;
            roundedBar(ctx, x, y, barW, barH, 2.5 * dpr);
          }
          ctx.shadowBlur = 0;
        }

        function draw() {
          if (!canvas) return;
          var ctx = canvas.getContext("2d");
          if (!ctx) return;
          var dpr = Math.min(2, window.devicePixelRatio || 1);
          var w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
          var h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
          if (canvas.width !== w) canvas.width = w;
          if (canvas.height !== h) canvas.height = h;
          ctx.clearRect(0, 0, w, h);

          var target;
          if (analyser && currentNow && currentNow.mode === "playing") {
            var data = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(data);
            target = analyseBars(data, BAR_COUNT);
          } else {
            target = procedural(BAR_COUNT);
          }
          drawBars(ctx, smoothBars(target), w, h, dpr);
        }

        function clock() {
          var el = document.getElementById("rn-clock");
          if (el) el.textContent = new Date().toLocaleTimeString("en-GB", { hour12:false });
        }

        poll();
        clock();
        window.__rnMusicPoll && clearInterval(window.__rnMusicPoll);
        window.__rnMusicPoll = setInterval(poll, POLL_MS);
        window.__rnMusicDraw && clearInterval(window.__rnMusicDraw);
        window.__rnMusicDraw = setInterval(draw, 1000 / RENDER_FPS);
        window.__rnMusicClock && clearInterval(window.__rnMusicClock);
        window.__rnMusicClock = setInterval(clock, 1000);
        draw();
      })();
    </script>`;
}

module.exports = { musicSceneFragment };
