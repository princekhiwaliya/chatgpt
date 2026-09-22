'use strict';

/**
 * Engine-agnostic "find the best version of this photo" stage.
 *
 * Takes the image URLs a page exposed plus a `fetchImage(url)` function, and
 * works out which variant is genuinely the largest by downloading candidates
 * and measuring their real pixel dimensions. Shared by the plain-HTTP engine
 * and the browser engine so both behave identically.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { imageSize } = require('./imagesize');
const { generateCandidates } = require('./highres');

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tiff': 'tif',
};

// Site furniture that is never the certificate photo.
const CHROME_RE = /logo|icon|sprite|banner|header|footer|favicon|captcha|loader|spinner|arrow|btn[_-]|button|bullet|divider|placeholder|blank|pixel|social|facebook|twitter|whatsapp|instagram/i;

function isLikelyPhoto(url) { return !CHROME_RE.test(url); }

/**
 * Build a filename from the grading number and whatever identifies the shot,
 * taking the extension from the served content type -- an image handler ends
 * in ".ashx" but returns PNG/JPEG bytes, so the URL's extension cannot be used.
 */
function makeFilename(grn, rawUrl, contentType, index) {
  const u = new URL(rawUrl);
  const ext = EXT_BY_TYPE[(contentType || '').split(';')[0].trim().toLowerCase()] || 'jpg';
  let stem = path.basename(u.pathname).replace(/\.[^.]*$/, '');

  // Dynamic endpoints carry the identity in the query string instead.
  if (/^(get|show|view|load)?(image|img|photo|pic|thumb|file)s?$/i.test(stem) || !stem) {
    const hints = [];
    for (const [k, v] of u.searchParams) {
      if (/^(side|face|view|type|pos|position|n|idx|index|seq)$/i.test(k)) hints.push(v);
    }
    stem = hints.join('_') || 'photo';
  }

  stem = stem.replace(new RegExp(grn, 'ig'), '').replace(/[^\w-]+/g, '_')
             .replace(/^[_-]+|[_-]+$/g, '');
  const parts = [grn, String(index + 1).padStart(2, '0')];
  if (stem) parts.push(stem);
  return parts.join('_').slice(0, 120) + '.' + ext;
}

/** Run async tasks with a small concurrency cap, to stay polite to the server. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

/**
 * Rank and download the best version of every photo.
 *
 * @param {Array<{url:string,how:string}>} images  candidates found on the page
 * @param {(url:string)=>Promise<{ok:boolean,status?:number,contentType?:string,buf?:Buffer}>} fetchImage
 * @param {{grn:string,imgDir:string,outDir:string,concurrency?:number,log?:Function}} opts
 */
async function resolveBestPhotos(images, fetchImage, opts) {
  const { grn, imgDir, outDir, concurrency = 4, log = () => {} } = opts;
  fs.mkdirSync(imgDir, { recursive: true });

  const results = [];
  const savedByUrl = new Map();  // best URL      -> file already written
  const savedByHash = new Map(); // content digest -> file already written

  const probe = async (url) => {
    try {
      const res = await fetchImage(url);
      if (!res || !res.ok || !res.buf) return { url, ok: false, status: res && res.status };
      const dim = imageSize(res.buf);
      if (!dim || !/image/i.test(res.contentType || '')) {
        return { url, ok: false, status: res.status, contentType: res.contentType };
      }
      return {
        url, ok: true, status: res.status, contentType: res.contentType,
        bytes: res.buf.length, width: dim.width, height: dim.height,
        pixels: dim.width * dim.height, buf: res.buf,
      };
    } catch (e) {
      return { url, ok: false, error: String(e.message || e).slice(0, 140) };
    }
  };

  for (const [idx, img] of images.entries()) {
    const candidates = generateCandidates(img.url);
    const probed = (await pool(candidates, concurrency, probe)).filter((r) => r.ok);
    if (!probed.length) {
      results.push({ source: img.url, how: img.how, best: null, tried: candidates.length });
      log(`      (no readable image at ${img.url})`);
      continue;
    }

    // Highest pixel count wins; more bytes breaks a tie (less compression).
    probed.sort((a, b) => b.pixels - a.pixels || b.bytes - a.bytes);
    const best = probed[0];
    const baseline = probed.find((r) => r.url === img.url) || null;

    // Several thumbnails often resolve to the same original, and distinct URLs
    // (cache-busting params, mirrored paths) can return identical bytes.
    // Write each actual photo once, keyed by URL and by content digest.
    const digest = crypto.createHash('sha256').update(best.buf).digest('hex');
    let file = savedByUrl.get(best.url) || savedByHash.get(digest);
    const alreadySaved = !!file;
    if (!file) {
      file = path.join(imgDir, makeFilename(grn, best.url, best.contentType, idx));
      fs.writeFileSync(file, best.buf);
    }
    savedByUrl.set(best.url, file);
    savedByHash.set(digest, file);

    results.push({
      source: img.url,
      how: img.how,
      tried: candidates.length,
      baseline: baseline
        ? { width: baseline.width, height: baseline.height, bytes: baseline.bytes } : null,
      best: {
        url: best.url, width: best.width, height: best.height, bytes: best.bytes,
        contentType: best.contentType, savedAs: path.relative(outDir, file),
        duplicateOfEarlier: alreadySaved, sha256: digest,
      },
      upgraded: baseline ? best.pixels > baseline.pixels : null,
      alternatives: probed.slice(1, 6)
        .map((r) => ({ url: r.url, width: r.width, height: r.height, bytes: r.bytes })),
    });

    const up = baseline && best.pixels > baseline.pixels
      ? `  (upgraded from ${baseline.width}x${baseline.height})` : '';
    const dup = alreadySaved ? '  [same file as an earlier thumbnail]' : '';
    log(`      ${best.width}x${best.height}  ${(best.bytes / 1024).toFixed(0)}KB  ${best.url}${up}${dup}`);
  }

  return results;
}

module.exports = { resolveBestPhotos, makeFilename, isLikelyPhoto, pool, EXT_BY_TYPE };
