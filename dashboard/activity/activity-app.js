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
          else if (mine === session) reconnectSoon("webrtc " + s);
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

  // HLS playback. Resolves only once video is actually playing, so a broken
  // feed falls through to the next transport instead of looping.
  //   variant "ll" = MediaMTX Low-Latency HLS (fMP4)          -> /activity/hls/...
  //   variant "ts" = classic MPEG-TS HLS (the VRChat remuxer) -> /activity/tshls/...
  function startHls(login, mine, variant) {
    var video = $("video");
    var src = url((variant === "ts" ? "tshls/" : "hls/") + streamPath(login) + "/index.m3u8");
    video.srcObject = null;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () { finish(new Error(variant + "-hls: no video after 15 s")); }, 15000);
      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener("playing", onPlaying);
        if (err) {
          if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
          reject(err);
        } else resolve();
      }
      function onPlaying() { if (mine === session) { overlay(""); finish(); } }
      video.addEventListener("playing", onPlaying);

      // Prefer hls.js whenever Media Source Extensions exist. Recent Chromium
      // (and so Discord desktop) also claims native HLS support, but its
      // native player can't play MediaMTX's low-latency fMP4 feed. Native HLS
      // is only for browsers without MSE (iOS).
      var hasMse = !!(window.MediaSource || window.ManagedMediaSource);
      if (!hasMse && video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        video.onerror = function () {
          if (mine !== session) return;
          if (!settled) finish(new Error(variant + "-hls native: media error " + (video.error && video.error.code)));
          else reconnectSoon(variant + "-hls native playback stopped");
        };
        playVideo();
        return;
      }
      loadHlsLib().then(function (Hls) {
        if (mine !== session) return finish(new Error("superseded"));
        if (!Hls.isSupported()) return finish(new Error("this Discord client cannot play HLS video"));
        hls = new Hls(variant === "ll"
          ? { lowLatencyMode:true, liveSyncDurationCount:2, backBufferLength:10, manifestLoadingMaxRetry:4, levelLoadingMaxRetry:4, fragLoadingMaxRetry:4 }
          : { lowLatencyMode:false, liveSyncDurationCount:3, backBufferLength:10, manifestLoadingMaxRetry:4, levelLoadingMaxRetry:4, fragLoadingMaxRetry:4 });
        var mediaRecoveries = 0;
        hls.on(Hls.Events.MANIFEST_PARSED, function () { playVideo(); });
        hls.on(Hls.Events.ERROR, function (_e, data) {
          if (!data || !data.fatal || mine !== session) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) { hls.recoverMediaError(); return; }
          var why = variant + "-hls: " + data.type + "/" + data.details + (data.response && data.response.code ? " (HTTP " + data.response.code + ")" : "");
          if (!settled) finish(new Error(why));
          else reconnectSoon(why);
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      }).catch(function (err) { finish(err); });
    });
  }

  // Transports in order of latency. The one that worked is remembered so a
  // reconnect starts there; WebRTC is skipped for the rest of the session once
  // it fails (Discord / a CDN proxy in front of the server often blocks UDP).
  var transportOk = null, webrtcBroken = false, lastErrors = [];
  function transportsFor() {
    var all = [];
    if (config.webrtc && !webrtcBroken && typeof RTCPeerConnection === "function") all.push("webrtc");
    all.push("ll", "ts");
    if (transportOk && all.indexOf(transportOk) > 0) { all.splice(all.indexOf(transportOk), 1); all.unshift(transportOk); }
    return all;
  }
  function startTransport(name, login, mine) {
    return name === "webrtc" ? startWebRtc(login, mine) : startHls(login, mine, name);
  }

  function connect(login) {
    stopPlayback();
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
        report("all transports failed for " + login + ": " + detail);
        overlay("Can't play the stream right now - retrying…", detail);
        return reconnectSoon(null, 6000);
      }
      startTransport(name, login, mine).then(function () {
        if (mine !== session) return;
        if (transportOk !== name) report("playing " + login + " via " + name);
        transportOk = name;
      }, function (err) {
        if (mine !== session) return;
        var msg = (err && err.message) || String(err);
        lastErrors.push(name + ": " + msg);
        if (name === "webrtc") webrtcBroken = true;
        if (transportOk === name) transportOk = null;
        next();
      });
    })();
  }

  function reconnectSoon(reason, delay) {
    if (reconnectTimer || !playingLogin) return;
    var login = playingLogin;
    if (reason) report("reconnecting " + login + ": " + reason);
    overlay("Reconnecting…");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (channel && channel.live && channel.login === login) connect(login);
    }, delay || 3000);
  }

  // Sends playback problems to the CastNexus server log
  // ([discord-activity] viewer: ...), rate limited on both sides.
  var reportsSent = 0;
  function report(message) {
    if (reportsSent++ > 20) return;
    try {
      fetch(url("api/log"), { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ message:String(message).slice(0, 400), ua:navigator.userAgent.slice(0, 160) }) }).catch(function () {});
    } catch (e) {}
  }
  // --- Channel state ----------------------------------------------------------
  function render() {
    var ch = channel;
    $("now-name").textContent = ch.displayName;
    $("now-meta").textContent = ch.live ? "LIVE · " + sourceLabel(ch.source) : "Offline";
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
