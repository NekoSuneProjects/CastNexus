// CastNexus Discord Activity: watch a CastNexus program inside a Discord voice
// channel. Plays the same public/<login> output as the other playback links,
// so console, PC/OBS, Music 24/7 and rerun sources all work without anyone
// screen-sharing.
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var inDiscord = params.has("frame_id");
  // Inside Discord the page is the mapped root ("/"). Opened directly it lives
  // at /activity/ - or /activity without a slash, where "." would mean "/".
  var BASE = /^\/activity\/?$/.test(location.pathname) ? "/activity/" : new URL(".", location.href).pathname;

  var $ = function (id) { return document.getElementById(id); };
  var config = null;
  var discord = null;
  var channels = [];
  var current = null;      // login being watched
  var session = 0;         // bumps on every (re)connect so stale callbacks bail out
  var pc = null;
  var hls = null;
  var userUnmuted = false;
  var pollTimer = null;

  function url(rel) { return BASE + rel; }
  function show(id) {
    ["loading", "picker", "player", "error"].forEach(function (name) { $(name).classList.toggle("hidden", name !== id); });
  }
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

  // --- Channel list -----------------------------------------------------------
  function refreshChannels() {
    return getJSON("api/channels").then(function (data) {
      channels = Array.isArray(data.channels) ? data.channels : [];
      renderPicker();
      if (current) syncCurrent();
    }).catch(function () { /* keep the last list on a transient error */ });
  }

  function renderPicker() {
    var list = $("channel-list");
    list.textContent = "";
    channels.forEach(function (ch) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "channel" + (ch.live ? " live" : "");
      button.disabled = !ch.live;
      var avatar = document.createElement(ch.profileImageUrl ? "img" : "div");
      avatar.className = "avatar";
      if (ch.profileImageUrl) { avatar.src = ch.profileImageUrl; avatar.alt = ""; avatar.referrerPolicy = "no-referrer"; }
      else avatar.textContent = (ch.displayName || "?").slice(0, 1).toUpperCase();
      var text = document.createElement("div");
      text.className = "channel-text";
      var name = document.createElement("strong");
      name.textContent = ch.displayName;
      var meta = document.createElement("span");
      meta.textContent = ch.live ? "LIVE · " + sourceLabel(ch.source) : "Offline";
      text.appendChild(name); text.appendChild(meta);
      button.appendChild(avatar); button.appendChild(text);
      button.addEventListener("click", function () { watch(ch.login); });
      list.appendChild(button);
    });
    $("empty").classList.toggle("hidden", channels.some(function (ch) { return ch.live; }));
  }

  function chooseInitial() {
    var wanted = (params.get("channel") || location.hash.replace(/^#/, "") || config.defaultChannel || "").toLowerCase();
    var live = channels.filter(function (ch) { return ch.live; });
    if (wanted && channels.some(function (ch) { return ch.login === wanted; })) return wanted;
    return live.length === 1 && channels.length === 1 ? live[0].login : null;
  }

  // --- Player -----------------------------------------------------------------
  function overlay(text) {
    $("player-overlay").classList.toggle("hidden", !text);
    if (text) $("overlay-text").textContent = text;
  }

  function stopPlayback() {
    session++;
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    var video = $("video");
    video.pause();
    video.srcObject = null;
    video.removeAttribute("src");
    try { video.load(); } catch (e) {}
  }

  function streamPath(login) { return "public/" + encodeURIComponent(login); }

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
      var done = function (err) {
        if (settled) return; settled = true;
        clearTimeout(timer);
        if (err) { try { conn.close(); } catch (e) {} if (pc === conn) pc = null; reject(err); } else resolve();
      };
      var timer = setTimeout(function () { done(new Error("webrtc timeout")); }, 9000);
      conn.addTransceiver("video", { direction:"recvonly" });
      conn.addTransceiver("audio", { direction:"recvonly" });
      conn.ontrack = function (ev) {
        if (mine !== session) return;
        var video = $("video");
        if (video.srcObject !== ev.streams[0]) { video.srcObject = ev.streams[0]; playVideo(); }
      };
      conn.oniceconnectionstatechange = function () {
        var s = conn.iceConnectionState;
        if (s === "connected" || s === "completed") { done(); overlay(""); }
        else if (s === "failed") { done(new Error("ice failed")); if (mine === session && settled) reconnectSoon(); }
        else if (s === "disconnected" && settled && mine === session) reconnectSoon();
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

  var reconnectTimer = null;
  function reconnectSoon() {
    if (reconnectTimer || !current) return;
    overlay("Reconnecting…");
    reconnectTimer = setTimeout(function () { reconnectTimer = null; if (current) connect(current); }, 3000);
  }

  function connect(login) {
    stopPlayback();
    var mine = session;
    var ch = channels.find(function (c) { return c.login === login; });
    if (!ch || !ch.live) { overlay("Offline - waiting for the stream to start…"); return; }
    overlay("Connecting…");
    startWebRtc(login, mine).catch(function () {
      if (mine !== session) return;
      return startHls(login, mine);
    }).catch(function (err) {
      if (mine !== session) return;
      overlay(err.message || "Playback failed - retrying…");
      reconnectSoon();
    });
  }

  function renderNow(ch) {
    $("now-name").textContent = ch ? ch.displayName : current;
    $("now-meta").textContent = ch && ch.live ? " · LIVE · " + sourceLabel(ch.source) : " · Offline";
    var img = $("now-avatar");
    if (ch && ch.profileImageUrl) { img.src = ch.profileImageUrl; img.referrerPolicy = "no-referrer"; img.hidden = false; } else img.hidden = true;
    $("back").hidden = channels.length <= 1;
  }

  var wasLive = false;
  function syncCurrent() {
    var ch = channels.find(function (c) { return c.login === current; });
    renderNow(ch);
    var live = !!(ch && ch.live);
    if (live && !wasLive) connect(current);
    if (!live && wasLive) { stopPlayback(); overlay("Offline - waiting for the stream to start…"); }
    wasLive = live;
  }

  function watch(login) {
    current = login;
    wasLive = false;
    show("player");
    syncCurrent();
    if (!channels.some(function (c) { return c.login === login && c.live; })) overlay("Offline - waiting for the stream to start…");
  }

  function backToList() {
    stopPlayback();
    current = null;
    wasLive = false;
    show("picker");
  }

  function updateUnmute() {
    var video = $("video");
    $("unmute").textContent = video.muted ? "🔊 Tap to unmute" : "🔇 Mute";
    $("unmute").classList.toggle("primary", video.muted);
  }

  $("unmute").addEventListener("click", function () {
    var video = $("video");
    userUnmuted = video.muted;
    video.muted = !userUnmuted;
    video.play().catch(function () {});
    updateUnmute();
  });
  $("back").addEventListener("click", backToList);

  // --- Boot -------------------------------------------------------------------
  getJSON("api/config").then(function (cfg) {
    config = cfg;
    document.title = cfg.title;
    $("title").textContent = cfg.title;
    return connectDiscord();
  }).then(function (sdk) {
    discord = sdk;
    return refreshChannels();
  }).then(function () {
    var initial = chooseInitial();
    if (initial) watch(initial); else show("picker");
    pollTimer = setInterval(refreshChannels, 8000);
  }).catch(function (err) {
    fail(err && err.message ? err.message : String(err));
  });

  window.addEventListener("pagehide", function () { if (pollTimer) clearInterval(pollTimer); stopPlayback(); });
})();
