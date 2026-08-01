// Sender: turn a file into an endless fountain-coded QR stream.
//
// Tuning notes from the experiments this PoC is distilled from:
// - Frame payload sets the QR version; denser wins on goodput as long as the
//   receiver can still decode it. 1465 bytes ≈ V27 is a safe middle ground
//   for arbitrary monitors; 2953 (V40) is the ceiling and works phone-to-
//   phone at close range.
// - The mask pattern is pinned (any declared mask is valid to a decoder);
//   this skips the spec's 8-way mask evaluation and speeds generation ~4×.
// - Displays need each frame shown for ≥2 refresh cycles or captures catch
//   the transition; 24 fps on a 60 Hz screen is comfortable.
// - Error correction stays at L by default: the fountain layer already
//   handles erasures, and a frame is either decoded whole or discarded.
//
// PHP edition changes:
// - QR generation uses the vendored Nayuki qrcodegen.js (global `qrcodegen`)
//   instead of node-qrcode; the mask is still pinned to 4.
// - Payloads are fetched from api.php; gzip copies are decompressed with the
//   DecompressionStream API before LT encoding.
// - Optional 2×2 grid: one animation frame shows four different fountain
//   frames (seq, seq+1, seq+K, seq+K+1) so a receiver capture yields up to
//   4× the goodput.

import { LTEncoder } from "../shared/fountain.js";
import { fnv1a, headerLen, packFrame } from "../shared/protocol.js";

const MARGIN = 4; // quiet-zone modules
const LOOKAHEAD = 3;
const OVERHEAD_EST = 1.18; // robust-soliton ε: expected frames ≈ K × this

const ECC = {
  L: qrcodegen.QrCode.Ecc.LOW,
  M: qrcodegen.QrCode.Ecc.MEDIUM,
  Q: qrcodegen.QrCode.Ecc.QUARTILE,
  H: qrcodegen.QrCode.Ecc.HIGH,
};

const canvas = document.getElementById("qr");
const specs = document.getElementById("specs");
const live = document.getElementById("live");
const cfgPayload = document.getElementById("cfg-payload");
const cfgFps = document.getElementById("cfg-fps");
const cfgBytes = document.getElementById("cfg-bytes");
const cfgEcc = document.getElementById("cfg-ecc");
const cfgSize = document.getElementById("cfg-size");
const cfgGrid = document.getElementById("cfg-grid");
const cfgUpload = document.getElementById("cfg-upload");
const cfgZoom = document.getElementById("cfg-zoom");
const cfgZoomVal = document.getElementById("cfg-zoom-val");

const payloadCache = new Map();
let generation = 0; // bumped on every restart; stale loops see it and die
let liveTimer = null;

let currentResize = null; // set per stream, invoked on fullscreen change

// Auto mode: pick safe defaults from the payload size. The QR version is then
// derived by the encoder (largest version that fits a frame stays readable on
// a camera), so the user never has to touch any of this.
function autoBytes(len) {
  return len < 512 * 1024 ? 1000 : 1465;
}
function autoGrid() {
  // 1×1 is the reliable default: one big QR per frame, easy for any camera.
  // 2×2 (~4× goodput) remains selectable manually.
  return 1;
}
function autoEta(k, blockLen, fps, payloadLen, grid) {
  const frames = k * 1.18;
  const seconds = frames / (fps * grid * grid);
  return seconds >= 90
    ? `${Math.round(seconds / 60)} min`
    : `${Math.round(seconds)} s`;
}

async function fetchPayloadBytes(meta) {
  const canGz = typeof DecompressionStream !== "undefined";
  const useGz = meta.gz && canGz;
  const key = `${meta.id}|${useGz ? 1 : 0}`;
  const hit = payloadCache.get(key);
  if (hit) return hit;
  const res = await fetch(
    `api.php?action=stream&id=${encodeURIComponent(meta.id)}&gz=${useGz ? 1 : 0}`,
  );
  if (!res.ok) return null;
  if (useGz) {
    const stream = new Blob([await res.arrayBuffer()])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    payloadCache.set(key, bytes);
    return bytes;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  payloadCache.set(key, bytes);
  return bytes;
}

async function populatePayloads(keepSelection) {
  const current = keepSelection ? cfgPayload.value : "";
  try {
    const res = await fetch("api.php?action=list");
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.files)) return;
    cfgPayload.innerHTML = "";
    for (const f of data.files) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.dataset.name = f.name;
      opt.dataset.gz = f.gz ? "1" : "0";
      opt.textContent = `${f.name} (${Math.round(f.size / 1024)} KB${f.gz ? ", gz" : ""}${f.demo ? ", demo" : ""})`;
      cfgPayload.appendChild(opt);
    }
    if (current) {
      for (const opt of cfgPayload.options) {
        if (opt.value === current) {
          cfgPayload.value = current;
          break;
        }
      }
    }
  } catch {
    // server-rendered options remain
  }
}

async function main() {
  await populatePayloads(false);
  for (const el of [cfgPayload, cfgFps, cfgBytes, cfgEcc, cfgSize, cfgGrid]) {
    el.addEventListener("change", () => void startStream());
  }
  cfgUpload?.addEventListener("change", async () => {
    const file = cfgUpload.files && cfgUpload.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("api.php?action=upload", { method: "POST", body: fd });
    const json = await res.json().catch(() => null);
    await populatePayloads(false);
    if (json && json.id) {
      for (const opt of cfgPayload.options) {
        if (opt.value === json.id) {
          cfgPayload.value = json.id;
          break;
        }
      }
    }
    cfgUpload.value = "";
    await startStream();
  });
  await startStream();
  try {
    await navigator.wakeLock?.request("screen");
  } catch {
    /* fine without it */
  }
}

async function startStream() {
  const gen = ++generation;
  const opt = cfgPayload.selectedOptions[0];
  if (!opt) {
    specs.textContent = "✗ no payload available";
    return;
  }
  const meta = {
    id: opt.value,
    name: opt.dataset.name || opt.value,
    gz: opt.dataset.gz === "1",
  };
  const payload = await fetchPayloadBytes(meta);
  if (!payload) {
    specs.textContent = `✗ couldn't load ${meta.name}`;
    return;
  }
  if (gen !== generation) return; // superseded while fetching
  const txFps = cfgFps.value === "auto" ? 24 : Number(cfgFps.value);
  const bytesAuto = cfgBytes.value === "auto";
  const frameBytes = bytesAuto ? autoBytes(payload.length) : Number(cfgBytes.value);
  const eccAuto = cfgEcc.value === "auto";
  const ecc = eccAuto ? "L" : cfgEcc.value;
  const gridAuto = cfgGrid.value === "auto";
  const grid = gridAuto ? autoGrid(payload.length) : Number(cfgGrid.value) || 1;
  const displayPx = cfgSize.value === "auto" ? Infinity : Number(cfgSize.value);
  const autoOn = bytesAuto || eccAuto || gridAuto || cfgFps.value === "auto" || cfgSize.value === "auto";

  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const blockLen = frameBytes - headerLen(meta.name);
  if (blockLen <= 0) {
    specs.textContent = `✗ bytes/frame too small for the ${meta.name} header`;
    return;
  }
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  const header = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
    grid,
    flags: 0, // payload is decompressed before encoding, so never gzip here
    name: meta.name,
  };

  let version; // locked after the first frame
  let modules = 0;
  let scale = 1;
  let lastFrame = null; // the most recent rendered QR ImageData (for resize redraws)
  const staging = document.createElement("canvas");
  const stagingCtx = staging.getContext("2d");
  const canvasCtx = canvas.getContext("2d");
  const queue = [];
  // Non-sequential frame order: seqs are handed out from a shuffled window so
  // the receiver never gets a long sequential streak. The fountain decoder
  // accepts frames in ANY order (LT peeling back-loads); shuffling mixes
  // low/high-degree frames evenly. The window is sized to ~K×1.3 — the
  // tightest distinct set that still completes the ~K×1.18 solve — and cycles
  // (reshuffles) when exhausted, so any missed seq reappears quickly and the
  // one-way optical channel "auto-recovers" dropped frames. The decoder dedups
  // repeats by seq, so cycling is free. Window stays ≪ 2^32.
  const seqPool = new Uint32Array(
    Math.max(64, Math.min(0xffffff00, Math.round(encoder.k * 1.3) + 16)),
  );
  let seqPtr = 0;
  const reshufflePool = () => {
    for (let i = 0; i < seqPool.length; i++) seqPool[i] = i;
    for (let i = seqPool.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = seqPool[i];
      seqPool[i] = seqPool[j];
      seqPool[j] = t;
    }
    seqPtr = 0;
  };
  reshufflePool();
  const nextSeq = () => {
    if (seqPtr >= seqPool.length) reshufflePool();
    return seqPool[seqPtr++];
  };
  let sent = 0;
  let lastT = 0;
  let fpsAcc = 0;
  let fpsN = 0;
  clearInterval(liveTimer);

  const tileTotal = () => modules + 2 * MARGIN;
  const gridTiles = () => (grid === 2 ? 2 : 1);

  const sizeCanvas = () => {
    if (gen !== generation) return; // a restart superseded this stream
    const dpr = window.devicePixelRatio || 1;
    const side = tileTotal() * gridTiles();
    const zoom = cfgZoom ? Math.max(10, Number(cfgZoom.value) || 100) / 100 : 1;
    const cssBudget = Math.min(0.98 * Math.min(window.innerWidth, window.innerHeight) * zoom, displayPx);
    scale = Math.max(1, Math.floor((cssBudget * dpr) / side));
    canvas.width = side * scale;
    canvas.height = side * scale;
    canvas.style.width = `${(side * scale) / dpr}px`;
    canvas.style.height = `${(side * scale) / dpr}px`;
    // Redraw the last rendered frame at the new scale immediately — staging is
    // NEVER reset here (that would blank the display on every resize). On the
    // very first call there is no frame yet, which is fine; the tick paints it.
    canvasCtx.imageSmoothingEnabled = false;
    if (lastFrame) canvasCtx.drawImage(staging, 0, 0, canvas.width, canvas.height);
  };
  currentResize = sizeCanvas;

  // Encode one fountain frame as a QR ImageData (quiet zone included).
  const makeQRImage = (seq) => {
    const bytes = packFrame({ ...header, seq }, encoder.encode(seq));
    const qr = qrcodegen.QrCode.encodeSegments(
      [qrcodegen.QrSegment.makeBytes(bytes)],
      ECC[ecc],
      version ?? 1,
      version ?? 40,
      4, // pinned mask (matches the original's maskPattern: 4)
      false, // no ECC boost: keep the version/ECC chosen by the user
    );
    if (version === undefined) {
      version = qr.version; // the QR version number, not qr.size (size = version*4+17)
      modules = qr.size;
      // Size staging EXACTLY to the module grid (tile × grid tiles) and never
      // touch it again. Leaving it at the 300×150 canvas default clipped big
      // tiles (V40, 2×2 grids) and stretched/distorted the QR on the canvas.
      staging.width = tileTotal() * gridTiles();
      staging.height = tileTotal() * gridTiles();
      sizeCanvas();
      const eta = autoEta(encoder.k, blockLen, txFps, payload.length, grid);
      specs.textContent =
        `${autoOn ? "AUTO " : ""}${txFps} FPS · ${frameBytes} bytes/frame · V${version} · ` +
        `ECC ${ecc} · ${Math.round(payload.length / 1024)} KB · K=${encoder.k} · ` +
        `grid ${grid}×${grid} · ~${eta}${meta.gz ? " · gz" : ""}`;
    }
    const size = qr.size;
    const total = size + 2 * MARGIN;
    const img = new ImageData(total, total);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xffffffff);
    for (let y = 0; y < size; y++) {
      const row = (y + MARGIN) * total + MARGIN;
      for (let x = 0; x < size; x++) {
        if (qr.getModule(x, y)) px[row + x] = 0xff000000;
      }
    }
    return img;
  };

  // One animation frame: either a single QR, or a 2×2 grid of four distinct
  // fountain frames (seq, seq+1, seq+K, seq+K+1 — stride by K to spread the
  // coverage across the block space).
  const makeFrame = () => {
    if (grid === 1) return makeQRImage(nextSeq());
    const imgs = [
      makeQRImage(nextSeq()),
      makeQRImage(nextSeq()),
      makeQRImage(nextSeq()),
      makeQRImage(nextSeq()),
    ];
    const t = tileTotal();
    const big = new ImageData(t * 2, t * 2);
    const bigPx = new Uint32Array(big.data.buffer);
    for (let i = 0; i < 4; i++) {
      const srcPx = new Uint32Array(imgs[i].data.buffer);
      const ox = (i % 2) * t;
      const oy = (i >> 1) * t;
      for (let y = 0; y < t; y++) {
        bigPx.set(srcPx.subarray(y * t, y * t + t), (oy + y) * (t * 2) + ox);
      }
    }
    return big;
  };

  const pump = () => {
    if (gen !== generation) return; // superseded by a settings change
    try {
      while (queue.length < LOOKAHEAD) queue.push(makeFrame());
    } catch (err) {
      // e.g. frame bytes over capacity for the chosen ECC level
      specs.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    setTimeout(pump, 0);
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now) => {
    if (gen !== generation) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    if (!img) {
      nextAt = now + interval;
      return;
    }
    lastFrame = img;
    stagingCtx.putImageData(img, 0, 0);
    canvasCtx.imageSmoothingEnabled = false;
    canvasCtx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    nextAt += interval;
    sent++;
    if (lastT) {
      fpsAcc += 1000 / (now - lastT);
      fpsN++;
    }
    lastT = now;
    if (now - nextAt > 3 * interval) nextAt = now + interval; // fell behind — don't burst
  };
  const t0 = performance.now();
  requestAnimationFrame(tick);
  currentResize = sizeCanvas;
  if (live) {
    live.style.display = "block";
    clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      if (gen !== generation) return;
      const avg = fpsN ? (fpsAcc / fpsN).toFixed(1) : "—";
      const frames = grid === 1 ? sent : sent * 4;
      // Payload KB/s, not fountain KB/s: frames carry ~1.18x overhead, so the
      // raw frames×blockLen figure overstates the file's real speed. This now
      // matches what the receiver reports as goodput.
      const payloadKBps =
        (frames * blockLen) / OVERHEAD_EST / 1024 / Math.max(0.001, (performance.now() - t0) / 1000);
      const css = Math.round(Number(canvas.style.width.replace("px", "")) || 0);
      const pct = cfgZoom ? cfgZoom.value : "100";
      live.textContent =
        `live ${avg} FPS · ${frames} fountain frames sent · ~${payloadKBps.toFixed(0)} KB/s payload · ` +
        `QR ${css}×${css} px on screen (${pct}%)`;
    }, 1000);
  }
}

const fullscreenBtn = document.getElementById("fullscreen");
if (fullscreenBtn) {
  fullscreenBtn.onclick = () => {
    const stage = document.querySelector(".stage");
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage?.requestFullscreen?.();
  };
}
document.addEventListener("fullscreenchange", () => currentResize?.());

// Window/browser resize (including phone rotation): re-scale the QR to fit
// automatically. rAF-throttled so dragging a window edge doesn't thrash, and
// it only re-scales — it never restarts the stream or changes the session.
let resizeTick = false;
const resizeSoon = () => {
  if (resizeTick) return;
  resizeTick = true;
  requestAnimationFrame(() => {
    resizeTick = false;
    currentResize?.();
  });
};
window.addEventListener("resize", resizeSoon);
if (cfgZoom && cfgZoomVal) {
  cfgZoom.addEventListener("input", () => {
    cfgZoomVal.textContent = `${cfgZoom.value}%`;
    resizeSoon(); // live QR sizer: re-scale instantly, never restarts the stream
  });
}

void main();
