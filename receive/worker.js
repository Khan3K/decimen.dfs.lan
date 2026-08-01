// QR decode worker: zxing-cpp compiled to WASM (IIFE build, primary) with
// jsQR as a pure-JS fallback. (Safari has never shipped BarcodeDetector —
// WebKit bug 281848 — so WASM is the only portable primary.)
//
// This is a CLASSIC worker: importScripts loads both vendored script-global
// bundles (they cannot be ES imports). One frame in flight per worker; the
// main thread drops frames when all workers are busy. Frames are disposable —
// the fountain doesn't care.
//
// Grid mode: when the main thread has learned the sender's grid size from a
// parsed frame header, each captured image is split into grid×grid cells and
// each cell is decoded independently, yielding up to grid² frames per video
// frame.

importScripts("../shared/vendor/zxing-reader.js");
importScripts("../shared/vendor/jsQR.js");

const vendorBase = new URL("../shared/vendor/", self.location.href).href;

if (self.ZXingWASM && self.ZXingWASM.prepareZXingModule) {
  self.ZXingWASM.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) =>
        path.endsWith(".wasm") ? new URL("zxing_reader.wasm", vendorBase).href : prefix + path,
    },
  });
}

function cropImage(img, gx, gy, grid) {
  const cw = Math.floor(img.width / grid);
  const ch = Math.floor(img.height / grid);
  const x = gx * cw;
  const y = gy * ch;
  const out = new ImageData(cw, ch);
  const src = img.data;
  const dst = out.data;
  for (let row = 0; row < ch; row++) {
    const s = ((y + row) * img.width + x) * 4;
    dst.set(src.subarray(s, s + cw * 4), row * cw * 4);
  }
  return out;
}

async function zxingDecode(img, maxSymbols, tryHarder) {
  if (!self.ZXingWASM || !self.ZXingWASM.readBarcodes) return [];
  try {
    const results = await self.ZXingWASM.readBarcodes(img, {
      formats: ["QRCode"],
      maxNumberOfSymbols: maxSymbols,
      // tryHarder is only for fallback rungs — it costs 3-5x and was on
      // unconditionally, which alone tanked decode fps on 1280px frames.
      tryHarder: !!tryHarder,
    });
    const out = [];
    for (const r of results) {
      if (r && r.isValid && r.bytes && r.bytes.length > 0) out.push(r.bytes);
    }
    return out;
  } catch {
    return [];
  }
}

function jsQRDecode(img) {
  if (!self.jsQR) return null;
  try {
    const res = self.jsQR(img.data, img.width, img.height);
    if (res && res.binaryData && res.binaryData.length > 0) {
      const b = res.binaryData;
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Nearest-neighbour upscale — lets the decoder "zoom in" on QRs that render
// small on screen (sender display size set low, or the camera is far away).
// Pure pixel math so it works in any worker, no OffscreenCanvas needed.
function upscale(img, factor) {
  const w = img.width * factor;
  const h = img.height * factor;
  const out = new ImageData(w, h);
  const src = img.data;
  const dst = out.data;
  for (let y = 0; y < h; y++) {
    const sy = (y / factor) | 0;
    const srow = sy * img.width;
    const drow = y * w;
    for (let x = 0; x < w; x++) {
      const s = (srow + ((x / factor) | 0)) * 4;
      const d = (drow + x) * 4;
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = src[s + 3];
    }
  }
  return out;
}

// Nearest-neighbour downscale to a target long side. The sender's auto-fit
// display fills the screen, so a 1280px capture still has each grid code at
// ~200px+ after halving — and zxing decodes the smaller buffer ~4x faster and
// tolerates camera noise better. This is the fast probe every frame starts with.
function downscale(img, target) {
  const mw = Math.max(img.width, img.height);
  const f = Math.max(2, Math.ceil(mw / target));
  const w = Math.max(1, Math.floor(img.width / f));
  const h = Math.max(1, Math.floor(img.height / f));
  const out = new ImageData(w, h);
  const src = img.data;
  const dst = out.data;
  for (let y = 0; y < h; y++) {
    const srow = y * f * img.width;
    const drow = y * w;
    for (let x = 0; x < w; x++) {
      const s = (srow + x * f) * 4;
      const d = (drow + x) * 4;
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = src[s + 3];
    }
  }
  return out;
}

async function decodeAll(img, grid) {
  // Fast probe: whole-image at ~720px long side, NO tryHarder. With the
  // sender's auto-fit display the grid fills the camera frame, so this one
  // cheap pass finds every visible QR regardless of grid alignment (off-center
  // grids, bezel, dark surround all covered). ~5-15ms -> tens of fps.
  let probe = img;
  if (Math.max(img.width, img.height) > 720) probe = downscale(img, 720);
  let found = await zxingDecode(probe, 4, false);
  if (found.length > 0) return found;

  // Full-res, still cheap (no tryHarder): catches codes the downscale blurred.
  found = await zxingDecode(img, 4, false);
  if (found.length > 0) return found;

  // tryHarder at full res for genuinely small/blurry QRs (sender display size
  // set low, or the camera far away).
  found = await zxingDecode(img, 4, true);
  if (found.length > 0) return found;

  // Auto-zoom: ONE upscale, capped at ~1600px long side so zxing never gets a
  // multi-megapixel buffer (the old 2x/3x ladder hit 2560x1440 and 3840x2160 —
  // that's what dropped real throughput to 2.6-5 fps). Only enlarges when the
  // frame is small enough that the cap still allows a real upscale.
  const dim = Math.max(img.width, img.height);
  const factor = Math.max(2, Math.min(3, Math.floor(1600 / dim)));
  if (dim * factor <= 1920) {
    found = await zxingDecode(upscale(img, factor), 4, true);
    if (found.length > 0) return found;
  }

  // Cell-split fallback: camera close-up so only part of the grid is visible.
  // zxing per cell only — jsQR per cell is ~50-100ms each and rarely beats it.
  const g = grid >= 2 ? grid : 2;
  const out = [];
  for (let gy = 0; gy < g; gy++) {
    for (let gx = 0; gx < g; gx++) {
      const z = await zxingDecode(cropImage(img, gx, gy, g), 1, true);
      out.push(z.length > 0 ? z[0] : null);
    }
  }
  if (out.some(Boolean)) return out;

  // Absolute last resort: jsQR over the whole frame.
  const fallback = jsQRDecode(img);
  return fallback ? [fallback] : [];
}

self.onmessage = async (e) => {
  const { id, buf, w, h, grid } = e.data;
  try {
    const img = new ImageData(new Uint8ClampedArray(buf), w, h);
    const frames = await decodeAll(img, grid || 0);
    self.postMessage({ id, frames });
  } catch {
    self.postMessage({ id, frames: null });
  }
};

// warm the WASM so the first real frame doesn't pay instantiation
if (self.ZXingWASM && self.ZXingWASM.readBarcodes) {
  self.ZXingWASM.readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
    .catch(() => undefined)
    .then(() => self.postMessage({ id: -1, frames: null }));
} else {
  self.postMessage({ id: -1, frames: null });
}
