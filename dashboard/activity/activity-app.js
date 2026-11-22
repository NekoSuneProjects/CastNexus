// CastNexus Discord Activity (HLS only): plays the ONE CastNexus channel the host owner
// selected (or DISCORD_ACTIVITY_CHANNEL) inside a Discord voice channel, so a
// PS5 / console / PC stream can be watched together without screen sharing.
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var inDiscord = params.has("frame_id");
  // Inside Discord the page is the mapped root ("/"). Opened directly it lives
  // at /activity/ - or /activity without a slash, where "." would mean "/".
  var BASE = /^\/activity\/?$/.test(location.pathname) ? "/activity/" : new URL(".", location.href).pathname;
  var POLL_MS = 8000;

  var $ = function (id) { return document.getElementById(id); };
  var config = null;
  var channel = null;      // last /api/channel answer
  var playingLogin = null; // login currently connected (null = not playing)
  var session = 0;         // bumps on every (re)connect so stale callbacks bail out
  var hls = null;
  var userUnmuted = false;
  var reconnectTimer = null;

  function url(rel) { return BASE + rel; }
  function show(id) { ["loading", "player", "error"].forEach(function (n) { $(n).classList.toggle("hidden", n !== id); }); }
  function fail(message) { $("error-text").textContent = message; show("error"); }
  function getJSON(rel) {
    return fetch(url(rel), { cache:"no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + rel);
      return r.json();
    });
  }
  function sourceLabel(source) {
    return { console:"Console", discord:"Console", pc:"PC", music:"24/7 Music", rerun:"Rerun" }[source] || "Live";
  }
  function overlay(text, detail) {
    $("player-overlay").classList.toggle("hidden", !text);
    if (text) $("overlay-text").textContent = text;
    $("overlay-detail").textContent = (text && detail) || "";
  }

  // --- Discord handshake ------------------------------------------------------
  function connectDiscord() {
    if (!inDiscord) return Promise.resolve(null);
    if (!config.clientId) return Promise.reject(new Error("DISCORD_CLIENT_ID is not set on the CastNexus server."));
    if (!config.sdk) return Promise.reject(new Error("The Discord Embedded App SDK is not installed on the CastNexus server."));
    $("loading-text").textContent = "Connecting to Discord…";
    return import(url("sdk/index.mjs")).then(function (mod) {
      var sdk = new mod.DiscordSDK(config.clientId, { disableConsoleLogOverride:true });
      // ready() never resolves outside a real Discord frame; don't hang forever.
      return Promise.race([
        sdk.ready().then(function () { return sdk; }),
        new Promise(function (resolve) { setTimeout(function () { resolve(sdk); }, 10000); }),
      ]);
    });
  }

  // --- Playback ---------------------------------------------------------------
  function stopPlayback() {
    session++;
    playingLogin = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    var video = $("video");
    video.pause();
    video.srcObject = null;
    video.removeAttribute("src");
    try { video.load(); } catch (e) {}
  }

  function streamPath(login) { return "public/" + encodeURIComponent(login); }
  // LL-HLS only, on the SAME URL as CastNexus' public playback link
  // (/hls/public/<login>/index.m3u8), root-absolute. Inside Discord, add the
  // URL Mapping  /hls -> <domain>/hls  so it reaches exactly that route.
  // Without it, Discord's root mapping sends it to <domain>/activity/hls, the
  // Activity's own guarded copy.
  function streamUrl(login) { return "/hls/" + streamPath(login) + "/index.m3u8"; }

  function updateUnmute() {
    var video = $("video");
    $("unmute").textContent = video.muted ? "🔊 Tap to unmute" : "🔇 Mute";
    $("unmute").classList.toggle("primary", video.muted);
  }

  function playVideo() {
    var video = $("video");
    video.muted = !userUnmuted;
    var p = video.play();
    if (p && p.catch) p.catch(function () {
      // Autoplay with sound was refused: fall back to muted and offer the button.
      userUnmuted = false; video.muted = true;
      video.play().catch(function () {});
      updateUnmute();
    });
    updateUnmute();
  }

  // A transport only counts as working once the video clock is really moving
  // (a "playing" event alone is not proof inside Discord). Resolves on
  // progress, rejects after `ms`.
  function waitForProgress(mine, label, ms) {
    var video = $("video");
    return new Promise(function (resolve, reject) {
      var start = video.currentTime, began = Date.now();
      var timer = setInterval(function () {
        if (mine !== session) { clearInterval(timer); return reject(new Error("superseded")); }
        if (video.currentTime > start + 0.4 && video.readyState >= 2) { clearInterval(timer); return resolve(); }
        if (Date.now() - began > ms) {
          clearInterval(timer);
          var err = video.error ? " (media error " + video.error.code + (video.error.message ? ": " + video.error.message : "") + ")" : "";
          reject(new Error(label + ": no video after " + Math.round(ms / 1000) + " s" + err + ", readyState " + video.readyState));
        }
      }, 250);
    });
  }

  function loadHlsLib() {
    if (window.Hls) return Promise.resolve(window.Hls);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url("hls.min.js");
      s.onload = function () { window.Hls ? resolve(window.Hls) : reject(new Error("hls.js failed to load")); };
      s.onerror = function () { reject(new Error("hls.js failed to load")); };
      document.head.appendChild(s);
    });
  }

  // hls.js playback (Media Source Extensions).
  //   "ll" = MediaMTX Low-Latency HLS (fMP4)          -> /activity/hls/...
  // The transmux worker is off: Discord's CSP may refuse blob: workers.
  function startHlsJs(login, mine, variant) {
    var video = $("video");
    var src = streamUrl(login);
    video.srcObject = null;
    if (!(window.MediaSource || window.ManagedMediaSource)) return Promise.reject(new Error(variant + "-hls: no Media Source Extensions"));
    if (mseBlocked) return Promise.reject(new Error(variant + "-hls: skipped, blob: media is blocked by this client's security policy"));
    var failNow = null;
    var early = new Promise(function (_res, rej) { failNow = rej; });
    var attempt = loadHlsLib().then(function (Hls) {
      if (mine !== session) throw new Error("superseded");
      if (!Hls.isSupported()) throw new Error(variant + "-hls: hls.js not supported here");
      hls = new Hls({
        enableWorker:false,
        lowLatencyMode:true,
        liveSyncDurationCount:2,
        backBufferLength:10,
        manifestLoadingMaxRetry:4, levelLoadingMaxRetry:4, fragLoadingMaxRetry:4,
      });
      var mediaRecoveries = 0, started = false;
      hls.on(Hls.Events.MANIFEST_PARSED, function () { playVideo(); });
      hls.on(Hls.Events.ERROR, function (_e, data) {
        if (!data || !data.fatal || mine !== session) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) { hls.recoverMediaError(); return; }
        var why = variant + "-hls: " + data.type + "/" + data.details + (data.response && data.response.code ? " (HTTP " + data.response.code + ")" : "") + (data.error && data.error.message ? " - " + data.error.message : "");
        if (!started) failNow(new Error(why)); else midStreamFailure(variant, why);
      });
      onPolicyBlock = function (why) { if (!started) failNow(new Error(variant + "-hls: " + why)); };
      hls.loadSource(src);
      hls.attachMedia(video);
      return Promise.race([waitForProgress(mine, variant + "-hls", 15000), early]).then(function () { started = true; onPolicyBlock = null; });
    });
    return Promise.race([attempt, early]).catch(function (err) {
      onPolicyBlock = null;
      if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
      throw err;
    });
  }

  // Browser-native playback of the same LL-HLS URL: no MediaSource, no blob:
  // URLs, so it survives the strictest CSP. The normal path on iOS (Discord
  // mobile), which has no MediaSource and plays LL-HLS natively.
  function startNativeHls(login, mine) {
    var video = $("video");
    if (!video.canPlayType("application/vnd.apple.mpegurl")) return Promise.reject(new Error("native-hls: not supported"));
    video.srcObject = null;
    video.src = streamUrl(login);
    video.onerror = function () { if (mine === session && transportOk === "native") midStreamFailure("native", "native-hls: media error " + (video.error && video.error.code)); };
    playVideo();
    return waitForProgress(mine, "native-hls", 15000);
  }

  // HLS only - every request goes over HTTPS through Discord's proxy, which is
  // the one path that reliably works inside the Activity sandbox.
  // Transports, best latency first; one that dies mid-stream is demoted.
  var TRANSPORT_LABELS = { ll:"LL-HLS", native:"LL-HLS (native)" };

  // If the client's Content Security Policy blocks blob: media (MSE) the
  // hls.js transports can never work there: skip straight to native HLS.
  var mseBlocked = false, onPolicyBlock = null;
  document.addEventListener("securitypolicyviolation", function (e) {
    var directive = String(e.effectiveDirective || e.violatedDirective || "");
    var blocked = String(e.blockedURI || "");
    if (!/^(media-src|worker-src|default-src)/.test(directive) || !/^blob/.test(blocked)) return;
    if (!mseBlocked) report("security policy blocks " + directive + " " + blocked.slice(0, 40) + " - using native HLS");
    mseBlocked = true;
    if (onPolicyBlock) onPolicyBlock("blocked by security policy (" + directive + ")");
  });
  var transportOk = null, demoted = {}, lastErrors = [];
  function transportsFor() {
    var list = [];
    var hasMse = !!(window.MediaSource || window.ManagedMediaSource);
    if (hasMse) list.push("ll", "native"); else list.push("native");
    list.sort(function (a, b) { return (demoted[a] || 0) - (demoted[b] || 0); }); // stable: keeps latency order within a tier
    if (transportOk && list.indexOf(transportOk) > 0 && !demoted[transportOk]) { list.splice(list.indexOf(transportOk), 1); list.unshift(transportOk); }
    return list;
  }
  function startTransport(name, login, mine) {
    if (name === "native") return startNativeHls(login, mine);
    return startHlsJs(login, mine, name);
  }

  var watchdog = null;
  function startWatchdog(name, mine) {
    clearInterval(watchdog);
    var video = $("video"), last = video.currentTime, still = 0;
    watchdog = setInterval(function () {
      if (mine !== session) { clearInterval(watchdog); return; }
      if (video.paused && !video.ended) { still = 0; last = video.currentTime; return; }
      if (video.currentTime > last + 0.1) { last = video.currentTime; still = 0; return; }
      still += 1;
      if (still >= 12) { clearInterval(watchdog); midStreamFailure(name, (TRANSPORT_LABELS[name] || name) + ": video stalled for 12 s"); }
    }, 1000);
  }

  function midStreamFailure(name, reason) {
    demoted[name] = (demoted[name] || 0) + 1;
    if (transportOk === name) transportOk = null;
    clearInterval(watchdog);
    reconnectSoon(reason);
  }

  function connect(login) {
    stopPlayback();
    clearInterval(watchdog);
    playingLogin = login;
    var mine = session;
    var queue = transportsFor();
    lastErrors = [];
    overlay("Connecting…");
    (function next() {
      if (mine !== session) return;
      var name = queue.shift();
      if (!name) {
        var detail = lastErrors.join(" | ");
        // Fetch the playlist ourselves to see WHO answered: the CastNexus
        // guard ("refused"), MediaMTX ("proxied"), or - header missing -
        // something in front of CastNexus (reverse proxy / CDN / Discord).
        return probe(streamUrl(login)).then(function (p) {
          if (mine !== session) return;
          report("all transports failed for " + login + ": probe: " + p + " | " + detail);
          detail = "probe: " + p + " | " + detail;
          overlay("Can't play the stream in Discord right now - retrying…", detail);
          reconnectSoon(null, 8000, detail);
        });
      }
      overlay("Connecting… (" + (TRANSPORT_LABELS[name] || name) + ")");
      startTransport(name, login, mine).then(function () {
        if (mine !== session) return;
        overlay("");
        if (transportOk !== name) report("playing " + login + " via " + name);
        transportOk = name;
        setTransportLabel(name);
        startWatchdog(name, mine);
      }, function (err) {
        if (mine !== session) return;
        var msg = (err && err.message) || String(err);
        if (msg !== "superseded") lastErrors.push(msg);
        if (transportOk === name) transportOk = null;
        stopMediaOnly();
        next();
      });
    })();
  }

  function probe(target) {
    return fetch(target, { cache:"no-store" }).then(function (r) {
      var who = r.headers.get("x-castnexus-activity") || "header missing - answered by something in front of CastNexus";
      return r.text().then(function (body) {
        return "GET " + target + " -> HTTP " + r.status + " (" + who + ")" + (r.ok ? "" : " body: " + body.replace(/\s+/g, " ").slice(0, 80));
      });
    }).catch(function (err) { return "GET " + target + " failed: " + (err && err.message); });
  }

  // Tear down the media of a failed attempt without bumping the session.
  function stopMediaOnly() {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    var video = $("video");
    video.onerror = null;
    video.srcObject = null;
    video.removeAttribute("src");
    try { video.load(); } catch (e) {}
  }

  function setTransportLabel(name) { $("now-meta").dataset.transport = TRANSPORT_LABELS[name] || ""; render(); }

  function reconnectSoon(reason, delay, detail) {
    if (reconnectTimer || !playingLogin) return;
    var login = playingLogin;
    if (reason) report("reconnecting " + login + ": " + reason);
    overlay("Reconnecting…", detail || reason || "");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (channel && channel.live && channel.login === login) connect(login);
    }, delay || 3000);
  }

  // Sends playback problems to the CastNexus server log
  // ([discord-activity] viewer: ...), rate limited on both sides.
  var reportsSent = 0;
  function report(message) {
    if (reportsSent++ > 30) return;
    try {
      fetch(url("api/log"), { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ message:String(message).slice(0, 400), ua:navigator.userAgent.slice(0, 160) }) }).catch(function () {});
    } catch (e) {}
  }
  // --- Channel state ----------------------------------------------------------
  function render() {
    var ch = channel;
    $("now-name").textContent = ch.displayName;
    var transport = $("now-meta").dataset.transport;
    $("now-meta").textContent = ch.live ? "LIVE · " + sourceLabel(ch.source) + (transport && playingLogin === ch.login ? " · " + transport : "") : "Offline";
    $("now-meta").className = ch.live ? "live" : "muted";
    [["now-avatar"], ["offline-avatar"]].forEach(function (pair) {
      var img = $(pair[0]);
      if (ch.profileImageUrl) { img.src = /^https?:/.test(ch.profileImageUrl) ? ch.profileImageUrl : url(ch.profileImageUrl); img.referrerPolicy = "no-referrer"; img.hidden = false; } else img.hidden = true;
    });
    $("offline-name").textContent = ch.displayName;
    $("offline").classList.toggle("hidden", ch.live);
    $("unmute").hidden = !ch.live;
    document.title = ch.displayName + " · " + config.title;
  }

  function applyChannel(next, note) {
    if (!next) {
      stopPlayback();
      channel = null;
      fail("No channel is set up for this Activity yet. The CastNexus host owner chooses it in Studio → Settings → Discord Activity.");
      return;
    }
    var changed = !channel || channel.login !== next.login;
    channel = next;
    $("offline-note").textContent = note || "";
    show("player");
    render();
    if (!next.live) { if (playingLogin) stopPlayback(); overlay(""); return; }
    if (changed || !playingLogin) connect(next.login);
  }

  // --- Voice-channel auto-detect ------------------------------------------------
  // The viewer authorizes once (identify + guilds). The Activity then reads who
  // is in this voice channel and asks CastNexus which of them have linked their
  // Discord account and are live. One live: play it. Several: switcher chips.
  // Nobody: the owner's fallback channel.
  var discord = null, accessToken = null, autoActive = false, picked = null, voiceLive = [];

  function startAutoDetect(sdk) {
    if (!sdk || !config.autoDetect || !config.clientId || !sdk.channelId) return Promise.resolve(false);
    $("loading-text").textContent = "Checking who is live in this voice channel…";
    return sdk.commands.authorize({ client_id:config.clientId, response_type:"code", state:"", prompt:"none", scope:["identify", "guilds"] })
      .then(function (auth) {
        return fetch(url("api/token"), { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ code:auth.code }) });
      })
      .then(function (r) { if (!r.ok) throw new Error("token " + r.status); return r.json(); })
      .then(function (token) { accessToken = token.access_token; return sdk.commands.authenticate({ access_token:accessToken }); })
      .then(function () { autoActive = true; return true; })
      .catch(function () { autoActive = false; return false; }); // declined or failed: fixed channel
  }

  function voiceMemberIds() {
    return discord.commands.getChannel({ channel_id:discord.channelId }).then(function (ch) {
      return (ch.voice_states || []).map(function (v) { return v.user && v.user.id; }).filter(Boolean);
    });
  }

  function fetchVoiceLive() {
    return voiceMemberIds().then(function (ids) {
      return fetch(url("api/voice-live"), { method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer " + accessToken }, body:JSON.stringify({ userIds:ids }) });
    }).then(function (r) { return r.ok ? r.json() : { channels:[] }; }).then(function (d) { return d.channels || []; });
  }

  function renderSwitcher() {
    var box = $("switcher");
    box.textContent = "";
    box.classList.toggle("hidden", voiceLive.length < 2);
    voiceLive.forEach(function (ch) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (channel && channel.login === ch.login ? " active" : "");
      b.textContent = ch.displayName;
      b.addEventListener("click", function () { picked = ch.login; applyChannel(ch); renderSwitcher(); });
      box.appendChild(b);
    });
  }

  function refresh() {
    var auto = autoActive ? fetchVoiceLive().catch(function () { return null; }) : Promise.resolve(null);
    return auto.then(function (live) {
      if (live && live.length) {
        voiceLive = live;
        var keep = live.filter(function (c) { return c.login === picked || (channel && c.login === channel.login); })[0];
        var next = keep || live[0];
        applyChannel(next, "");
        renderSwitcher();
        return;
      }
      voiceLive = [];
      renderSwitcher();
      return getJSON("api/channel").then(function (data) {
        applyChannel(data.channel || null, autoActive ? "Nobody in this voice channel is live on CastNexus right now - showing " + ((data.channel && data.channel.displayName) || "the host's channel") + "." : "");
      });
    }).catch(function () { /* keep the current state on a transient error */ });
  }

  $("unmute").addEventListener("click", function () {
    var video = $("video");
    userUnmuted = video.muted;
    video.muted = !userUnmuted;
    video.play().catch(function () {});
    updateUnmute();
  });

  // --- Boot -------------------------------------------------------------------
  var pollTimer = null;
  getJSON("api/config").then(function (cfg) {
    config = cfg;
    document.title = cfg.title;
    return connectDiscord();
  }).then(function (sdk) {
    discord = sdk;
    return startAutoDetect(sdk);
  }).then(function () {
    return refresh();
  }).then(function () {
    pollTimer = setInterval(refresh, autoActive ? 6000 : POLL_MS);
  }).catch(function (err) {
    fail(err && err.message ? err.message : String(err));
  });

  window.addEventListener("pagehide", function () { if (pollTimer) clearInterval(pollTimer); stopPlayback(); });
})();
