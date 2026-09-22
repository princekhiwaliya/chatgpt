'use strict';

/**
 * Dependency-free image dimension reader.
 *
 * We need real pixel dimensions to decide which of several candidate URLs is
 * actually the highest-quality photo. Byte size alone lies: a re-encoded JPEG
 * at quality 95 can be larger than a bigger image at quality 70.
 *
 * Supports the formats PCG-style grading sites realistically serve:
 * JPEG, PNG, GIF, WebP, BMP.
 */

function readJpeg(buf) {
  // JPEG is a chain of segments; dimensions live in a Start-Of-Frame marker.
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off < buf.length - 9) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    // SOF0..SOF15, excluding DHT(c4), JPG(c8) and DAC(cc) which share the range.
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7), type: 'jpeg' };
    }
    off += 2 + len;
  }
  return null;
}

function readPng(buf) {
  if (buf.toString('ascii', 1, 4) !== 'PNG') return null;
  // An fdAT-less APNG or plain PNG both put IHDR first: width/height at 16/20.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
}

function readGif(buf) {
  if (buf.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), type: 'gif' };
}

function readWebp(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8 ') {
    // Lossy: 14-bit dimensions after the 3-byte start code.
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
  }
  if (fourcc === 'VP8L') {
    // Lossless: 14 bits each, packed little-endian after the 0x2f signature.
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'webp' };
  }
  if (fourcc === 'VP8X') {
    // Extended: 24-bit minus-one dimensions.
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1, type: 'webp' };
  }
  return null;
}

function readBmp(buf) {
  if (buf.toString('ascii', 0, 2) !== 'BM') return null;
  return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), type: 'bmp' };
}

/**
 * @param {Buffer} buf raw image bytes (the first ~64KB is enough for every format here)
 * @returns {{width:number,height:number,type:string}|null}
 */
function imageSize(buf) {
  if (!buf || buf.length < 32) return null;
  for (const reader of [readPng, readGif, readWebp, readBmp, readJpeg]) {
    try {
      const out = reader(buf);
      if (out && out.width > 0 && out.height > 0) return out;
    } catch {
      // Truncated or malformed for this reader; try the next one.
    }
  }
  return null;
}

module.exports = { imageSize };
