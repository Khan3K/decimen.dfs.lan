// Receiver: camera → QR decode in workers (zxing-wasm + jsQR fallback) →
// fountain decoder → file. PHP edition adds: grid-mode capture, filename from
// the frame header, and a save-to-server button.

import { LTDecoder } from "../shared/fountain.js";
import { fnv1a, parseFrame } from "../shared/protocol.js";

const OVERHEAD_EST = 1.18; // expected frames ≈ K × this (robust-soliton ε)

const startBtn = document.getElementById("start");
const video = document.getElementById("video");
const preview = document.getElementById("preview");
const stats = document.getElementById("stats");
const progressEl = document.getElementById("progress");
const bar = document.getElementById("bar");
const barpct = document.getElementById("barpct");
const result = document.getElementById("result");
const settings = document.getElementById("settings");
const metricsEl = document.getElementById("metrics");
const metric = (id) => document.getElementById(id);

let stream = null;
let decoder = null;
let sessionId = 0;
let startTs = 0;
let captureGen = 0;
let done = false;
let currentGrid = 0; // learned from the frame header; 0 = unknown → full-image decode
let fileName = "received.bin";

const workers = [];
const busy = [];
const captureTimes = [];
const decodeTimes = [];
let statsTimer = null;

function teardown() {
  done = true;
  captureGen++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  while (workers.length) {
    workers.pop().terminate();
    busy.pop();
  }
  captureTimes.length = 0;
  decodeTimes.length = 0;
}

startBtn.onclick = () => void start();

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    // On insecure origins the API doesn't exist AT ALL — this is the plain-
    // http-over-LAN case. localhost is exempt; other hosts need https.
    stats.textContent =
      "✗ camera needs a secure context — this page must be served over " +
      "https to use the camera from another device (see the README).";
    return;
  }
  teardown(); // drop any previous camera, workers, timers before starting fresh
  const widthSel = document.getElementById("cfg-width").value;
  const capfpsSel = document.getElementById("cfg-capfps").value;
  const workerSel = document.getElementById("cfg-workers").value;
  const captureWidth = widthSel === "auto" ? 960 : Number(widthSel);
  const captureFps = capfpsSel === "auto" ? 60 : Number(capfpsSel);
  const workerCount = workerSel === "auto" ? 2 : Number(workerSel);
  const fpsIsAuto = capfpsSel === "auto";
  settings.style.display = "none";
  startBtn.style.display = "none";
  preview.style.display = "block";
  metricsEl.style.display = "grid";
  result.innerHTML = "";
  done = false;
  currentGrid = 0;
  fileName = "received.bin";
  const base = {
    facingMode: "environment",
    width: { ideal: captureWidth },
    height: { ideal: Math.round((captureWidth * 3) / 4) },
  };
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: fpsIsAuto
          ? { ...base, frameRate: { ideal: captureFps } }
          : { ...base, frameRate: { exact: captureFps } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: captureFps } },
      });
    }
  } catch (err) {
    stats.textContent = `✗ camera: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  const track = stream.getVideoTracks()[0];
  const ts = track ? track.getSettings() : {};
  stats.textContent =
    `camera ${ts.width}×${ts.height}@${ts.frameRate} — ` +
    `waiting for the sender's stream (auto-syncs on the first decoded frame)…`;

  // Classic worker: it loads zxing-wasm (IIFE) and jsQR (UMD) via importScripts.
  for (let i = 0; i < workerCount; i++) {
    const w = new Worker("./receive/worker.js");
    const slot = i;
    w.onmessage = (e) => {
      const { id, frames } = e.data;
      if (id === -1) return; // warm-up
      busy[slot] = false;
      // decode fps = processed camera frames per second (one worker result per
      // captured frame), NOT per decoded QR — otherwise 2×2 grids would show a
      // 4× inflated number. The QR count lives in the frames new/dup metric.
      decodeTimes.push(performance.now());
      if (frames) {
        for (const f of frames) {
          if (f) onDecoded(f);
        }
      }
    };
    workers.push(w);
    busy.push(false);
  }

  captureGen++;
  scheduleFrame(captureGen);
  statsTimer = setInterval(updateStats, 500);
  try {
    await navigator.wakeLock?.request("screen");
  } catch {
    /* fine */
  }
}

function scheduleFrame(gen) {
  if (done || gen !== captureGen) return;
  const v = video;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
const grabCtx = grab.getContext("2d", { willReadFrequently: true });
let frameId = 0;

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  const slot = busy.indexOf(false);
  if (slot === -1) return; // all workers busy — drop the frame, no harm done
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  grabCtx.drawImage(video, 0, 0);
  const img = grabCtx.getImageData(0, 0, vw, vh);
  busy[slot] = true;
  workers[slot].postMessage(
    { id: frameId++, buf: img.data.buffer, w: vw, h: vh, grid: currentGrid },
    [img.data.buffer],
  );
}

function onDecoded(bytes) {
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;
  if (header.grid > 1) currentGrid = header.grid;
  if (header.name) fileName = header.name;
  if (!decoder || sessionId !== header.sessionId) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    sessionId = header.sessionId;
    startTs = performance.now();
    progressEl.style.display = "block";
    barpct.style.display = "block";
    stats.textContent =
      `auto-detect ✓ session #${header.sessionId} · grid ${header.grid}×${header.grid} · ` +
      `${header.blockLen} B/f · ${(header.totalLen / 1024).toFixed(0)} KB · K=${header.k} · ` +
      `${header.name} — receiving…`;
  }
  decoder.addFrame(header.seq, block);
  // Payload-progress estimate. Fountain frames carry ~1.18x overhead, so
  // framesNew * blockLen can legitimately exceed the file size (users saw
  // "117 / 93 KB"). Report actual payload bytes instead: totalLen scaled by
  // frame-collection progress, always <= the file size, and show the raw
  // frame count next to it so the fountain overhead is visible, not confusing.
  const targetFrames = Math.max(1, Math.round(decoder.k * OVERHEAD_EST));
  const progress = Math.min(0.99, decoder.framesNew / targetFrames);
  bar.style.width = `${(progress * 100).toFixed(1)}%`;
  const totalKB = header.totalLen / 1024;
  const recvKB = totalKB * progress;
  barpct.textContent = `${Math.round(progress * 100)}% · ` +
    `${recvKB.toFixed(0)} KB of ${totalKB.toFixed(0)} KB · ` +
    `${decoder.framesNew}/${targetFrames} frames`;

  if (decoder.isComplete) {
    const payload = decoder.assemble();
    const seconds = (performance.now() - startTs) / 1000;
    void complete(payload, header, seconds);
  }
}

async function complete(payload, header, seconds) {
  let bytes = payload;
  if (header.flags & 1 && typeof DecompressionStream !== "undefined") {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* keep compressed bytes if decompression fails */
    }
  }
  const ok = fnv1a(bytes) === header.payloadFnv;
  finish(bytes, ok, seconds, header);
}

function sniffMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "image/webp";
  return "application/octet-stream";
}

function finish(payload, hashOk, seconds, header) {
  done = true;
  captureGen++;
  stream?.getTracks().forEach((t) => t.stop());
  preview.style.display = "none";
  bar.style.width = "100%";
  barpct.textContent = `100% · ${(header.totalLen / 1024).toFixed(0)} KB`;
  const kb = Math.round(header.totalLen / 1024);
  const rate = (header.totalLen / 1024 / seconds).toFixed(1);
  stats.textContent = `${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · hash ${hashOk ? "verified ✓" : "MISMATCH ✗"}`;

  const again = document.createElement("button");
  again.textContent = "Start again";
  again.style.cssText = "margin-top:12px;";
  again.onclick = () => {
    result.innerHTML = "";
    done = false;
    start();
  };
  result.append(again);

  const mime = sniffMime(payload);
  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = hashOk ? "Transfer Complete!" : "Transfer Complete (hash mismatch)";
  result.append(heading);

  if (mime.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "received";
    img.src = URL.createObjectURL(new Blob([payload], { type: mime }));
    result.append(img);
  }

  const blob = new Blob([payload], { type: mime });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName || "received.bin";
  link.textContent = "Download file";
  link.style.cssText = "display:block; margin-top:12px;";
  result.append(link);

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save to server";
  saveBtn.style.cssText = "margin-top:12px;";
  saveBtn.onclick = () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "saving…";
    void (async () => {
      try {
        const dataUrl = await blobToBase64(payload);
        const res = await fetch("api.php?action=save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: fileName || "received.bin",
            data: dataUrl,
            mime,
            size: payload.length,
            fnv: header.payloadFnv,
          }),
        });
        const json = await res.json();
        saveBtn.textContent = json.stored ? `Saved ✓ (${json.id.slice(0, 8)}…)` : `✗ ${json.error || "failed"}`;
      } catch (err) {
        saveBtn.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  };
  result.append(saveBtn);
}

async function blobToBase64(bytes) {
  const chunk = 0x8000;
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a) => {
    while (a.length > 0 && a[0] < now - 2000) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  metric("m-cap").textContent = (captureTimes.length / 2).toFixed(0);
  metric("m-dec").textContent = (decodeTimes.length / 2).toFixed(1);
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  const kbs = (decoder.framesNew * decoder.blockLen) / OVERHEAD_EST / 1024 / Math.max(0.1, elapsed);
  metric("m-rate").textContent = `${kbs.toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-k").textContent = String(decoder.k);
  metric("m-block").textContent = `${decoder.blockLen} B`;
  metric("m-payload").textContent =
    `${((decoder.totalLen / 1024) * Math.min(1, decoder.framesNew / Math.max(1, Math.round(decoder.k * OVERHEAD_EST)))).toFixed(0)} / ` +
    `${(decoder.totalLen / 1024).toFixed(0)} KB`;
}
