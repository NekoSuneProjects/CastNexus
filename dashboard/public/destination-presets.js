(function () {
  "use strict";

  const presets = [
    { id:"youtube", name:"YouTube", mark:"▶", colour:"#ff0033", autoUrl:"rtmps://a.rtmps.youtube.com/live2", help:"Paste the stream key from YouTube Live Control Room." },
    { id:"twitch", name:"Twitch", mark:"◩", colour:"#9146ff", autoUrl:"rtmps://ingest.global-contribute.live-video.net/app", help:"Paste your Twitch primary stream key. CastNexus uses Twitch's secure global ingest." },
    { id:"facebook", name:"Facebook", mark:"f", colour:"#1877f2", help:"Facebook supplies a Server URL and stream key for each Live Producer setup." },
    { id:"linkedin", name:"LinkedIn", mark:"in", colour:"#0a66c2", help:"Copy the Stream URL and key from the scheduled LinkedIn Live event." },
    { id:"kick", name:"Kick", mark:"K", colour:"#53fc18", help:"Copy both values from the Kick creator dashboard; ingest URLs can vary." },
    { id:"instagram", name:"Instagram", mark:"◎", colour:"#e1306c", help:"Use the URL and key shown by Instagram Live Producer." },
    { id:"x", name:"X", mark:"𝕏", colour:"#e7e9ea", help:"Use the RTMP URL and key supplied by X Media Studio or Live Producer." },
    { id:"tiktok", name:"TikTok LIVE", mark:"♪", colour:"#25f4ee", help:"Use the server URL and key from TikTok LIVE Center when stream-key access is enabled." },
    { id:"rumble", name:"Rumble", mark:"▶", colour:"#85c742", help:"Copy the RTMP URL and stream key from your Rumble live-stream settings." },
    { id:"mixcloud", name:"Mixcloud", mark:"≋", colour:"#52aad8", help:"Copy the server URL and key shown when creating a Mixcloud Live broadcast." },
    { id:"amazon-live", name:"Amazon Live", mark:"a", colour:"#ff9900", help:"Use the encoder URL and key assigned to your Amazon Live event." },
    { id:"telegram", name:"Telegram", mark:"➤", colour:"#2aabee", help:"Copy the server URL and stream key from the Telegram live-stream dialog." },
    { id:"steam", name:"Steam", mark:"●", colour:"#66c0f4", help:"Steam broadcast ingest details are account and region specific." },
    { id:"dailymotion", name:"Dailymotion", mark:"dM", colour:"#00aaff", help:"Copy the RTMP ingest URL and key from Dailymotion Studio." },
    { id:"nimo", name:"Nimo TV", mark:"N", colour:"#5b45f5", help:"Use the RTMP server and key issued by the platform." },
    { id:"picarto", name:"Picarto.TV", mark:"P", colour:"#27ae60", help:"Use the server and stream key from your Picarto broadcast settings." },
    { id:"bilibili", name:"Bilibili", mark:"b", colour:"#00aeec", help:"Use the current server URL and code supplied in the Bilibili live dashboard." },
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
