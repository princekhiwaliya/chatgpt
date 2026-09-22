'use strict';

/**
 * Turn an image URL the site actually served into a list of plausible
 * higher-resolution variants, best-guess first.
 *
 * Grading sites almost always show a downscaled derivative on the results page
 * and keep the real scan somewhere adjacent. The winning candidate is decided
 * empirically by the prober (it downloads each and measures pixels) -- this
 * module only proposes, it never assumes.
 */

// Directory segments that signal a derivative, and what to try instead.
const DIR_SMALL = ['thumb', 'thumbs', 'thumbnail', 'thumbnails', 'small', 'sm',
  'medium', 'med', 'preview', 'previews', 'tn', 'cache', 'resized', 'resize',
  'compressed', 'web', 'display'];
const DIR_LARGE = ['original', 'originals', 'full', 'large', 'orig', 'big',
  'hires', 'hi-res', 'highres', 'source', 'raw', 'master', 'images', 'img'];

// Filename markers that signal a derivative.
const SUFFIX_SMALL = ['_thumb', '-thumb', '_thumbnail', '-thumbnail', '_small',
  '-small', '_sm', '-sm', '_s', '-s', '_t', '-t', '_m', '-m', '_med', '-med',
  '_medium', '-medium', '_preview', '-preview', '_low', '-low', '_min', '-min'];
const SUFFIX_LARGE = ['', '_large', '_full', '_orig', '_original', '_big',
  '_hd', '_xl', '_hires', '_o', '_l'];

// Query keys that control output size / quality.
const DIM_KEYS = ['w', 'width', 'h', 'height', 'size', 'sz', 'maxwidth',
  'maxheight', 'max_w', 'max_h', 'resize', 'fit', 'scale', 'dim'];
const QUALITY_KEYS = ['q', 'quality', 'compression', 'dpr'];

// Big enough that a server-side resizer clamps to the true original.
const BIG = '4000';

// Dynamic endpoints: the filename is code, not an asset name, so renaming it
// ("GetImage_large.ashx") only produces 404s. Only their query string matters.
const HANDLER_EXT = ['.ashx', '.aspx', '.axd', '.asmx', '.php', '.do', '.jsp', '.cgi'];

function splitPath(pathname) {
  const parts = pathname.split('/');
  const file = parts.pop() || '';
  const dot = file.lastIndexOf('.');
  return {
    dirs: parts,
    stem: dot > 0 ? file.slice(0, dot) : file,
    ext: dot > 0 ? file.slice(dot) : '',
  };
}

function rebuild(u, dirs, stem, ext) {
  const copy = new URL(u.toString());
  copy.pathname = [...dirs, stem + ext].join('/');
  return copy;
}

/**
 * @param {string} rawUrl an image URL observed on the page or in network traffic
 * @param {number} [limit] hard cap on candidates, to stay polite to the server
 * @returns {string[]} unique URLs, original first, then best guesses
 */
function generateCandidates(rawUrl, limit = 40) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return [rawUrl];
  }

  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = typeof v === 'string' ? v : v.toString();
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  };

  // Always keep the original so the prober has a baseline to beat.
  push(u);

  const { dirs, stem, ext } = splitPath(u.pathname);
  const isHandler = HANDLER_EXT.includes(ext.toLowerCase());

  // --- 1. Strip WordPress/CMS style "-800x600" before the extension. ---
  const dimMatch = isHandler ? null : stem.match(/^(.*?)[-_](\d{2,5})x(\d{2,5})$/);
  if (dimMatch) push(rebuild(u, dirs, dimMatch[1], ext));

  // --- 2. Filename suffix: drop it, or swap it for a "large" marker. ---
  const base = dimMatch ? dimMatch[1] : stem;
  for (const small of isHandler ? [] : SUFFIX_SMALL) {
    if (base.toLowerCase().endsWith(small) && base.length > small.length) {
      const trunk = base.slice(0, base.length - small.length);
      for (const large of SUFFIX_LARGE) push(rebuild(u, dirs, trunk + large, ext));
      break;
    }
  }

  // --- 3. Additively try "large" markers even with no small marker present. ---
  for (const large of isHandler ? [] : ['_large', '_original', '_full', '_hd']) {
    push(rebuild(u, dirs, base + large, ext));
  }

  // --- 4. Directory swap: .../thumb/x.jpg -> .../original/x.jpg ---
  for (let i = 0; i < dirs.length; i++) {
    if (!DIR_SMALL.includes(dirs[i].toLowerCase())) continue;
    for (const large of DIR_LARGE) {
      const swapped = [...dirs];
      swapped[i] = large;
      push(rebuild(u, swapped, base, ext));
    }
    // Some layouts drop the derivative directory entirely.
    const removed = dirs.filter((_, idx) => idx !== i);
    push(rebuild(u, removed, base, ext));
    break;
  }

  // --- 5. Query strings: bare URL, then inflated size/quality params. ---
  if ([...u.searchParams.keys()].length) {
    const bare = new URL(u.toString());
    bare.search = '';
    push(bare);

    // Keep identity params (id, cert, grn) but drop sizing ones.
    const trimmed = new URL(u.toString());
    for (const k of [...trimmed.searchParams.keys()]) {
      const lk = k.toLowerCase();
      if (DIM_KEYS.includes(lk) || QUALITY_KEYS.includes(lk)) trimmed.searchParams.delete(k);
    }
    push(trimmed);

    // Ask for something huge; well-behaved resizers clamp to the original.
    const inflated = new URL(u.toString());
    let touched = false;
    for (const k of [...inflated.searchParams.keys()]) {
      const lk = k.toLowerCase();
      if (DIM_KEYS.includes(lk)) { inflated.searchParams.set(k, BIG); touched = true; }
      if (QUALITY_KEYS.includes(lk)) { inflated.searchParams.set(k, '100'); touched = true; }
    }
    if (touched) push(inflated);

    // Named size tiers used by ASP.NET image handlers.
    for (const k of [...u.searchParams.keys()]) {
      if (!DIM_KEYS.includes(k.toLowerCase())) continue;
      for (const tier of ['large', 'full', 'original', 'max', 'hi']) {
        const named = new URL(u.toString());
        named.searchParams.set(k, tier);
        push(named);
      }
    }
  } else {
    // No params at all: some handlers still honour an explicit width.
    for (const k of ['w', 'width', 'size']) {
      const probe = new URL(u.toString());
      probe.searchParams.set(k, BIG);
      push(probe);
    }
  }

  // --- 6. Alternate extensions: originals are sometimes kept lossless. ---
  if (ext && !isHandler) {
    for (const alt of ['.jpg', '.jpeg', '.png', '.webp']) {
      if (alt !== ext.toLowerCase()) push(rebuild(u, dirs, base, alt));
    }
  }

  return out.slice(0, limit);
}

module.exports = { generateCandidates };
