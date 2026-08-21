"use strict";

const music24 = require("./music24");

let closing = false;
let startTimer = null;

async function stop(signal) {
  if (closing) return;
  closing = true;
  if (startTimer) clearTimeout(startTimer);
  try { await music24.shutdown(signal, { exit:false }); } catch {}
  process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("unhandledRejection", err => console.error("[castnexus] unhandled rejection", err));

// Bring the HTTP/overlay server up first, then start the embedded radio worker.
// This avoids a cold-start race where Music 24/7 tries to open its own overlay
// before the dashboard is listening.
require("./server");
startTimer = setTimeout(() => {
  startTimer = null;
  music24.startMusic24();
}, Number(process.env.MUSIC24_EMBED_START_DELAY_MS || 500));
