'use strict';

/**
 * One lookup, start to finish: pick an engine, find the photos, save the best
 * version of each, write the report.
 *
 * Both front-ends call this -- the command line and the local web app -- so
 * they cannot drift apart in how they choose engines or rank results.
 */

const fs = require('fs');
const path = require('path');
const { resolveBestPhotos, isLikelyPhoto } = require('./probe');
const { request } = require('./http');

const DEFAULT_URL = 'https://www.pcggrading.in/authenticity-verification.aspx';

/**
 * @param {object} o
 * @param {string} o.grn            grading number to look up
 * @param {string} [o.url]          verification page
 * @param {string} [o.engine]       'auto' | 'http' | 'browser'
 * @param {string} [o.outDir]       where to save
 * @param {Function} [o.onLog]      progress callback, one line at a time
 * @returns {Promise<{report:object,photos:Array,outDir:string,imgDir:string}>}
 */
async function runLookup(o) {
  const grn = String(o.grn || '').trim().toUpperCase();
  if (!grn) throw new Error('No grading number given.');

  const url = o.url || DEFAULT_URL;
  const engine = o.engine || 'auto';
  const outDir = o.outDir || path.join(process.cwd(), 'results', grn);
  const imgDir = path.join(outDir, 'images');
  const log = o.onLog || (() => {});
  const timeout = o.timeout || 30000;
  const concurrency = o.concurrency || 4;

  fs.mkdirSync(imgDir, { recursive: true });

  const report = { grn, url, startedAt: new Date().toISOString() };
  let photos = [];
  let lastAttempt = null;

  const runEngine = async (name) => {
    const mod = name === 'browser' ? require('./engine-browser') : require('./engine-http');
    const res = await mod.lookup(grn, url, {
      timeout, headful: !!o.headful, log,
      screenshotPath: name === 'browser' ? path.join(outDir, 'result.png') : null,
    });

    // Plain HTTP has no session-bound fetcher of its own; make a simple one.
    const fetchImage = res.fetchImage || (async (u) => {
      const r = await request(u, { timeout, headers: { referer: res.info.resultUrl || url } });
      if (r.status >= 400) return { ok: false, status: r.status };
      return { ok: true, status: r.status, contentType: r.headers['content-type'] || '', buf: r.body };
    });

    const seen = new Set();
    let images = res.images.filter((i) => !seen.has(i.url) && seen.add(i.url));
    const total = images.length;
    if (!o.keepAll) images = images.filter((i) => isLikelyPhoto(i.url));
    const lower = grn.toLowerCase();
    images.sort((a, b) => {
      const s = (x) => (x.url.toLowerCase().includes(lower) ? 2 : 0) +
                       (/anchor|srcset|api/.test(x.how) ? 1 : 0);
      return s(b) - s(a);
    });
    log(`      ${total} image URL(s) seen, ${images.length} plausible certificate photo(s)`);

    log('[5/5] finding the highest-resolution version of each...');
    const found = await resolveBestPhotos(images, fetchImage, {
      grn, imgDir, outDir, concurrency, log,
    });

    if (res.resultHtml) fs.writeFileSync(path.join(outDir, `result-${name}.html`), res.resultHtml);
    if (res.resultText) fs.writeFileSync(path.join(outDir, `result-${name}.txt`), res.resultText);
    if (res.dispose) await res.dispose();
    return { info: res.info, photos: found };
  };

  const order = engine === 'browser' ? ['browser']
    : engine === 'http' ? ['http'] : ['http', 'browser'];

  for (const name of order) {
    try {
      log(`--- engine: ${name} ---`);
      lastAttempt = await runEngine(name);
      report[name] = lastAttempt.info;
      photos = lastAttempt.photos.filter((p) => p.best);
      if (photos.length) break;
      if (name === 'http' && order.length > 1) {
        log('No photos over plain HTTP - the page may build them with JavaScript.');
        log('Trying the browser engine...');
      }
    } catch (err) {
      const msg = String(err.message || err);
      report[name + 'Error'] = msg;
      log(`  ${name} engine failed: ${msg}`);
      if (name === 'http' && order.length > 1) log('  Trying the browser engine...');
    }
  }

  report.photos = lastAttempt ? lastAttempt.photos : [];
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  return { report, photos, outDir, imgDir, grn };
}

module.exports = { runLookup, DEFAULT_URL };
