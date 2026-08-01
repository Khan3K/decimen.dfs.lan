// Frame protocol: every QR frame is fully self-describing, so there is NO
// handshake — the receiver locks onto a stream mid-flight, and a new session
// id on any frame simply starts a fresh transfer.
//
// Layout (little-endian), 23 + nameLen bytes, followed by `blockLen` payload:
//   0  u8   magic 0xD1
//   1  u8   magic 0x0D   (PHP edition: bumped from 0x0C, header grew a grid,
//                         flags and filename field)
//   2  u16  sessionId    random per sender start
//   4  u32  seq          drives the fountain PRNG (see fountain.js)
//   8  u16  k            source block count
//  10  u16  blockLen     payload bytes per frame
//  12  u32  totalLen     file length in bytes
//  16  u32  payloadFnv   FNV-1a of the whole file — verified on completion
//  20  u8   grid         1 = single QR, 2 = 2×2 grid (4 codes per frame)
//  21  u8   flags        bit0: 1 = payload is gzip-compressed
//  22  u8   nameLen      length of the UTF-8 filename (0-255)
//  23  u8[nameLen] name  UTF-8 filename bytes
//
// The fixed part is 23 bytes (offsets 0-22); the header length is therefore
// 23 + nameLen. (The plan text says "24 + nameLen", but its own field list
// puts the filename at byte 23 — the layout here is the authoritative one.)

export const HEADER_FIXED = 23;
const MAGIC0 = 0xd1;
const MAGIC1 = 0x0d;

const te = new TextEncoder();
const td = new TextDecoder();

/** Length of the header (fixed part + encoded filename), in bytes. */
export function headerLen(name) {
  const nb = te.encode(name || "");
  return HEADER_FIXED + Math.min(255, nb.length);
}

export function packFrame(h, block) {
  let nameBytes = te.encode(h.name || "");
  if (nameBytes.length > 255) nameBytes = nameBytes.subarray(0, 255);
  const headerLen = HEADER_FIXED + nameBytes.length;
  const out = new Uint8Array(headerLen + block.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MAGIC0);
  dv.setUint8(1, MAGIC1);
  dv.setUint16(2, h.sessionId, true);
  dv.setUint32(4, h.seq, true);
  dv.setUint16(8, h.k, true);
  dv.setUint16(10, h.blockLen, true);
  dv.setUint32(12, h.totalLen, true);
  dv.setUint32(16, h.payloadFnv, true);
  dv.setUint8(20, h.grid);
  dv.setUint8(21, h.flags);
  dv.setUint8(22, nameBytes.length);
  out.set(nameBytes, 23);
  out.set(block, headerLen);
  return out;
}

export function parseFrame(bytes) {
  if (bytes.length <= HEADER_FIXED) return null;
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLen = dv.getUint8(22);
  const headerLen = HEADER_FIXED + nameLen;
  if (bytes.length <= headerLen) return null;
  const header = {
    sessionId: dv.getUint16(2, true),
    seq: dv.getUint32(4, true),
    k: dv.getUint16(8, true),
    blockLen: dv.getUint16(10, true),
    totalLen: dv.getUint32(12, true),
    payloadFnv: dv.getUint32(16, true),
    grid: dv.getUint8(20),
    flags: dv.getUint8(21),
    name: td.decode(bytes.subarray(23, 23 + nameLen)),
  };
  if (header.k === 0 || header.blockLen === 0 || header.totalLen === 0) return null;
  if (bytes.length !== headerLen + header.blockLen) return null;
  return { header, block: bytes.subarray(headerLen) };
}

export function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32 — deterministic across JS engines (integer ops only). */
export function splitmix32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}
