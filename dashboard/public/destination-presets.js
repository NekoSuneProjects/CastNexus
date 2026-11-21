(function () {
  "use strict";

  const presets = [
    { id:"youtube", name:"YouTube", mark:"▶", colour:"#ff0033", autoUrl:"rtmps://a.rtmps.youtube.com/live2", help:"Paste the stream key from YouTube Live Control Room." },
    { id:"twitch", name:"Twitch", mark:"◩", colour:"#9146ff", autoUrl:"rtmps://ingest.global-contribute.live-video.net/app", help:"Paste your Twitch primary stream key. CastNexus uses Twitch's secure global ingest." },
    { id:"facebook", name:"Facebook", mark:"f", colour:"#1877f2", suggestUrl:"rtmps://rtmp-api.facebook.com:443/rtmp", help:"Facebook supplies a Server URL and stream key for each Live Producer setup." },
    { id:"linkedin", name:"LinkedIn", mark:"in", colour:"#0a66c2", help:"Copy the Stream URL and key from the scheduled LinkedIn Live event." },
    { id:"kick", name:"Kick", mark:"K", colour:"#53fc18", help:"Copy both values from the Kick creator dashboard; ingest URLs can vary." },
    { id:"instagram", name:"Instagram", mark:"◎", colour:"#e1306c", help:"Use the URL and key shown by Instagram Live Producer." },
    { id:"x", name:"X", mark:"𝕏", colour:"#e7e9ea", suggestUrl:"rtmp://de.pscp.tv:80/x", help:"Use the RTMP URL and key supplied by X Media Studio or Live Producer." },
    { id:"tiktok", name:"TikTok LIVE", mark:"♪", colour:"#25f4ee", help:"Use the server URL and key from TikTok LIVE Center when stream-key access is enabled." },
    { id:"rumble", name:"Rumble", mark:"▶", colour:"#85c742", help:"Copy the RTMP URL and stream key from your Rumble live-stream settings." },
    { id:"mixcloud", name:"Mixcloud", mark:"≋", colour:"#52aad8", suggestUrl:"rtmp://rtmp.mixcloud.com/broadcast", help:"Copy the server URL and key shown when creating a Mixcloud Live broadcast." },
    { id:"amazon-live", name:"Amazon Live", mark:"a", colour:"#ff9900", help:"Use the encoder URL and key assigned to your Amazon Live event." },
    { id:"telegram", name:"Telegram", mark:"➤", colour:"#2aabee", help:"Copy the server URL and stream key from the Telegram live-stream dialog." },
    { id:"patreon", name:"Patreon", mark:"P", colour:"#ff424d", help:"Paste the RTMP server URL and stream key supplied for your Patreon live event or connected streaming provider." },
    { id:"steam", name:"Steam", mark:"●", colour:"#66c0f4", suggestUrl:"rtmp://ingest-rtmp.broadcast.steamcontent.com/app", help:"Steam broadcast ingest details are account and region specific." },
    { id:"dailymotion", name:"Dailymotion", mark:"dM", colour:"#00aaff", help:"Copy the RTMP ingest URL and key from Dailymotion Studio." },
    { id:"nimo", name:"Nimo TV", mark:"N", colour:"#5b45f5", suggestUrl:"rtmp://txpush.rtmp.nimo.tv/live", help:"Use the RTMP server and key issued by the platform." },
    { id:"picarto", name:"Picarto.TV", mark:"P", colour:"#27ae60", suggestUrl:"rtmp://live.eu-west1.picarto.tv/golive", help:"Pre-filled with Picarto's European ingest; change it for your region if Picarto shows a different server." },
    { id:"bilibili", name:"Bilibili", mark:"b", colour:"#00aeec", suggestUrl:"rtmp://live-push.bilivideo.com/live-bvc", help:"Use the current server URL and code supplied in the Bilibili live dashboard." },
    { id:"vpzone", name:"VPZone", mark:"VP", colour:"#22d3ee", autoUrl:"rtmps://rtmp-hd.vpzone.tv:443/live", help:"Paste your VPZone stream key. CastNexus uses VPZone's secure RTMPS ingest." },
    { id:"hyperiontv", name:"HyperionTV", mark:"H", colour:"#a78bfa", autoUrl:"rtmp://hyperiontv.net/stream", help:"Paste the stream key from your HyperionTV streaming dashboard." },
    { id:"beamstream", name:"BeamStream", mark:"B", colour:"#60a5fa", autoUrl:"rtmps://live.beamstream.gg:443/live", help:"Paste your BeamStream stream key (secure RTMPS ingest)." },
    { id:"velora", name:"Velora", mark:"V", colour:"#8b5cf6", autoUrl:"rtmp://publish.velora.tv/live", help:"Paste your Velora stream key." },
    { id:"uscreen", name:"Uscreen", mark:"U", colour:"#38bdf8", autoUrl:"rtmp://global-live.uscreen.app:5222/app", help:"Paste the stream key from your Uscreen live event." },
    { id:"shareplay", name:"SharePlay.tv", mark:"S", colour:"#10b981", autoUrl:"rtmp://stream.shareplay.tv", help:"Paste your SharePlay.tv stream key." },
    { id:"vrcdn", name:"VRCDN Live", mark:"V", colour:"#c084fc", autoUrl:"rtmp://ingest.vrcdn.live/live", help:"Paste your VRCDN stream key - handy for streaming into VRChat worlds." },
    { id:"custom-rtmp", name:"Custom RTMP", mark:"RTMP", colour:"#8d73ff", help:"Enter any RTMP or RTMPS server and optional stream key." },
    { id:"custom-srt", name:"Custom SRT", mark:"SRT", colour:"#38e8ff", fullUrl:true, help:"Enter the complete SRT URL, including any required query parameters." },
  ];

  function byId(id) { return presets.find(p => p.id === id) || null; }
  function destinationUrl(preset, serverUrl, streamKey) {
    const base = String(preset?.autoUrl || serverUrl || "").trim().replace(/\/$/, "");
    const key = String(streamKey || "").trim().replace(/^\/+/, "");
    return key ? `${base}/${key}` : base;
  }

  window.CastNexusDestinationPresets = { presets, byId, destinationUrl };
})();
