"use strict";

// Closed-caption architecture for destinations.
//
// Caption Mode per destination:
//   off          nothing is added (default)
//   passthrough  keep CEA-608/708 captions that OBS embedded in the H.264
//                stream (SEI user data). Stream copy keeps them untouched;
//                transcodes ask the encoder to re-embed decoded A/53 CC.
//   server       server-generated captions from a registered provider
//                (e.g. Whisper / whisper.cpp) - provider interface below
//   burnin       render subtitles into the picture (opt-in only; never the
//                default, because burned-in text cannot be switched off)
//
// Nothing here generates speech-to-text yet. Providers register themselves
// with registerCaptionProvider() so a future Whisper sidecar can be added
// without touching destination routing:
//
//   registerCaptionProvider({
//     id:"whisper", label:"Whisper (local)",
//     available:() => true,
//     // Return extra FFmpeg input/filter/map arguments for a destination.
//     ffmpegPlan:({ destination, sourceUrl }) => ({ inputs:[...], videoFilter:null, maps:[], outputArgs:[] }),
//   })

const CAPTION_MODES = Object.freeze(["off", "passthrough", "server", "burnin"]);
const CAPTION_LABELS = Object.freeze({
  off:"Off",
  passthrough:"OBS caption passthrough",
  server:"Server-generated captions",
  burnin:"Burn-in subtitles",
});
// Encoders that can re-embed A/53 closed captions from decoded frames.
const A53_ENCODERS = new Set(["libx264", "h264_nvenc", "h264_qsv", "h264_amf"]);

const providers = new Map();

function normaliseCaptionMode(value) {
  const v = String(value || "off").toLowerCase();
  return CAPTION_MODES.includes(v) ? v : "off";
}

function registerCaptionProvider(provider) {
  if (!provider?.id || typeof provider.ffmpegPlan !== "function") throw new TypeError("caption provider needs id and ffmpegPlan()");
  providers.set(String(provider.id), provider);
  return () => providers.delete(String(provider.id));
}

function captionProviders() {
  return [...providers.values()].map(p => ({ id:p.id, label:p.label || p.id, available:p.available ? !!p.available() : true }));
}

function activeProvider() {
  const wanted = process.env.CASTNEXUS_CAPTION_PROVIDER;
  const list = [...providers.values()].filter(p => (p.available ? p.available() : true));
  return (wanted && list.find(p => p.id === wanted)) || list[0] || null;
}

// Status shown in the destination editor.
function captionCapabilities() {
  const provider = activeProvider();
  return {
    modes:CAPTION_MODES.map(mode => ({
      id:mode,
      label:CAPTION_LABELS[mode],
      available:mode === "off" || mode === "passthrough" || (mode === "server" && !!provider),
      note:mode === "server" && !provider ? "No caption provider is installed yet (planned: Whisper / whisper.cpp)." : mode === "burnin" ? "Requires a server caption provider; burned-in text cannot be turned off by viewers." : mode === "passthrough" ? "Keeps captions OBS embeds in the stream. The browser compositor re-renders video, so passthrough only survives Source/Passthrough and direct transcodes." : null,
    })),
    provider:provider ? { id:provider.id, label:provider.label || provider.id } : null,
    providers:captionProviders(),
  };
}

// FFmpeg additions for one destination. Never throws: an unavailable mode
// degrades to "off" and reports why, so a caption problem cannot take a
// destination off air.
function captionPlan(mode, { copy = false, encoderId = "libx264", destination = null, sourceUrl = null, compositorSource = false } = {}) {
  const m = normaliseCaptionMode(mode);
  const empty = { mode:m, effective:"off", inputs:[], videoFilter:null, maps:[], outputArgs:[], warning:null };
  if (m === "off") return empty;
  if (m === "passthrough") {
    if (compositorSource) return { ...empty, warning:"captions are not preserved through the browser compositor" };
    if (copy) return { ...empty, effective:"passthrough" };
    if (!A53_ENCODERS.has(encoderId)) return { ...empty, warning:`${encoderId} cannot re-embed A/53 captions` };
    return { ...empty, effective:"passthrough", outputArgs:["-a53cc", "1"] };
  }
  const provider = activeProvider();
  if (!provider) return { ...empty, warning:"no server caption provider is installed" };
  try {
    const plan = provider.ffmpegPlan({ mode:m, destination, sourceUrl, copy, encoderId }) || {};
    if (m === "burnin" && copy) return { ...empty, warning:"burn-in needs a video transcode; disable source copy for this destination" };
    return {
      mode:m,
      effective:m,
      inputs:Array.isArray(plan.inputs) ? plan.inputs : [],
      videoFilter:m === "burnin" ? plan.videoFilter || null : null,
      maps:Array.isArray(plan.maps) ? plan.maps : [],
      outputArgs:Array.isArray(plan.outputArgs) ? plan.outputArgs : [],
      warning:null,
    };
  } catch (error) {
    return { ...empty, warning:`caption provider failed: ${error.message}` };
  }
}

module.exports = {
  CAPTION_MODES,
  CAPTION_LABELS,
  normaliseCaptionMode,
  registerCaptionProvider,
  captionProviders,
  captionCapabilities,
  captionPlan,
  _providers:providers,
};
