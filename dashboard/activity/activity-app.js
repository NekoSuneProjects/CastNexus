// CastNexus Discord Activity: plays the ONE CastNexus channel the host owner
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
  var pc = null;
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
    return { console:"Console", pc:"PC", music:"24/7 Music", rerun:"Rerun" }[source] || "Live";
  }
  function overlay(text) {
    $("player-overlay").classList.toggle("hidden", !text);
    if (text) $("overlay-text").textContent = text;
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
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    var video = $("video");
    video.pause();
    video.srcObject = null;
    video.removeAttribute("src");
    try { video.load(); } catch (e) {}
  }

  function streamPath(login) { return "public/" + encodeURIComponent(login); }

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

  function startWebRtc(login, mine) {
    return new Promise(function (resolve, reject) {
      if (!config.webrtc || typeof RTCPeerConnection !== "function") return reject(new Error("webrtc unavailable"));
      var conn = new RTCPeerConnection();
      pc = conn;
      var settled = false;
      var timer = setTimeout(function () { done(new Error("webrtc timeout")); }, 9000);
      function done(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { try { conn.close(); } catch (e) {} if (pc === conn) pc = null; reject(err); } else resolve();
      }
      conn.addTransceiver("video", { direction:"recvonly" });
      conn.addTransceiver("audio", { direction:"recvonly" });
      conn.ontrack = function (ev) {
        if (mine !== session) return;
        var video = $("video");
        if (video.srcObject !== ev.streams[0]) { video.srcObject = ev.streams[0]; playVideo(); }
      };
      conn.oniceconnectionstatechange = function () {
        var s = conn.iceConnectionState;
        if (s === "connected" || s === "completed") { done(); if (mine === session) overlay(""); }
        else if (s === "failed" || s === "disconnected") {
          if (!settled) done(new Error("ice " + s));
          else if (mine === session) reconnectSoon();
        }
      };
      conn.createOffer().then(function (offer) { return conn.setLocalDescription(offer); }).then(function () {
        return new Promise(function (res) {
          if (conn.iceGatheringState === "complete") return res();
          conn.addEventListener("icegatheringstatechange", function f() { if (conn.iceGatheringState === "complete") { conn.removeEventListener("icegatheringstatechange", f); res(); } });
          setTimeout(res, 2500);
        });
      }).then(function () {
        return fetch(url("webrtc/" + streamPath(login) + "/whep"), { method:"POST", headers:{ "Content-Type":"application/sdp" }, body:conn.localDescription.sdp });
      }).then(function (r) {
        if (!r.ok) throw new Error("WHEP " + r.status);
        return r.text();
      }).then(function (sdp) {
        return conn.setRemoteDescription({ type:"answer", sdp:sdp });
      }).catch(done);
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

  function startHls(login, mine) {
    var video = $("video");
    var src = url("hls/" + streamPath(login) + "/index.m3u8");
    video.srcObject = null;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.onplaying = function () { if (mine === session) overlay(""); };
      video.onerror = function () { if (mine === session) reconnectSoon(); };
      playVideo();
      return Promise.resolve();
    }
    return loadHlsLib().then(function (Hls) {
      if (mine !== session) return;
      if (!Hls.isSupported()) throw new Error("This Discord client cannot play HLS video.");
      hls = new Hls({ lowLatencyMode:true, liveSyncDurationCount:2, backBufferLength:10 });
      hls.on(Hls.Events.MANIFEST_PARSED, function () { playVideo(); });
      hls.on(Hls.Events.FRAG_BUFFERED, function () { if (mine === session) overlay(""); });
      hls.on(Hls.Events.ERROR, function (_e, data) {
        if (!data || !data.fatal || mine !== session) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        reconnectSoon();
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    });
  }

  function connect(login) {
    stopPlayback();
    playingLogin = login;
    var mine = session;
    overlay("Connecting…");
    startWebRtc(login, mine).catch(function () {
      if (mine !== session) return;
      return startHls(login, mine);
    }).catch(function (err) {
      if (mine !== session) return;
      overlay((err && err.message) || "Playback failed - retrying…");
      reconnectSoon();
    });
  }

  function reconnectSoon() {
    if (reconnectTimer || !playingLogin) return;
    var login = playingLogin;
    overlay("Reconnecting…");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (channel && channel.live && channel.login === login) connect(login);
    }, 3000);
  }

  // --- Channel state ----------------------------------------------------------
  function render() {
    var ch = channel;
    $("now-name").textContent = ch.displayName;
    $("now-meta").textContent = ch.live ? "LIVE · " + sourceLabel(ch.source) : "Offline";
    $("now-meta").className = ch.live ? "live" : "muted";
    [["now-avatar"], ["offline-avatar"]].forEach(function (pair) {
      var img = $(pair[0]);
      if (ch.profileImageUrl) { img.src = ch.profileImageUrl; img.referrerPolicy = "no-referrer"; img.hidden = false; } else img.hidden = true;
    });
    $("offline-name").textContent = ch.displayName;
    $("offline").classList.toggle("hidden", ch.live);
    $("unmute").hidden = !ch.live;
    document.title = ch.displayName + " · " + config.title;
  }

  function applyChannel(next) {
    if (!next) {
      stopPlayback();
      channel = null;
      fail("No channel is set up for this Activity yet. The CastNexus host owner chooses it in Studio → Settings → Discord Activity.");
      return;
    }
    var changed = !channel || channel.login !== next.login;
    channel = next;
    show("player");
    render();
    if (!next.live) { if (playingLogin) stopPlayback(); overlay(""); return; }
    if (changed || !playingLogin) connect(next.login);
  }

  function refresh() {
    return getJSON("api/channel").then(function (data) { applyChannel(data.channel || null); })
      .catch(function () { /* keep the current state on a transient error */ });
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
  }).then(function () {
    return getJSON("api/channel");
  }).then(function (data) {
    applyChannel(data.channel || null);
    pollTimer = setInterval(refresh, POLL_MS);
  }).catch(function (err) {
    fail(err && err.message ? err.message : String(err));
  });

  window.addEventListener("pagehide", function () { if (pollTimer) clearInterval(pollTimer); stopPlayback(); });
})();
