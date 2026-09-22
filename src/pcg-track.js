'use strict';

/**
 * PCG Grading certificate tracker + photo-API discovery.
 *
 * Drives https://www.pcggrading.in/authenticity-verification.aspx in a real
 * Chromium browser, looks up a grading number, records every network call the
 * page makes, and then hunts for the highest-resolution version of each photo
 * the certificate exposes.
 *
 * The site is an ASP.NET WebForms app and its markup is not documented, so
 * nothing here hardcodes field names or image paths: the form is located by
 * scoring the inputs on the page, and the photo endpoint is discovered by
 * watching real traffic. Every high-res guess is confirmed by downloading the
 * bytes and measuring the actual pixels.
 *
 * Usage:
 *   node src/pcg-track.js GRN16658IN
 *   node src/pcg-track.js GRN16658IN --headful --out ./results
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { imageSize } = require('./imagesize');
const { generateCandidates } = require('./highres');

const DEFAULT_URL = 'https://www.pcggrading.in/authenticity-verification.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Anything that looks like it could be a picture, including extension-less
// handler endpoints that return image bytes.
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?)(\?|#|$)/i;

function parseArgs(argv) {
  const opts = {
    grn: null,
    url: DEFAULT_URL,
    out: path.join(process.cwd(), 'results'),
    headful: false,
    timeout: 45000,
    concurrency: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headful') opts.headful = true;
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (!a.startsWith('-') && !opts.grn) opts.grn = a;
  }
  return opts;
}

const log = (...m) => console.log(...m);

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tiff': 'tif',
};

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

/** True when `target` should be reached through the egress proxy. */
function needsProxy(target) {
  let host;
  try { host = new URL(target).hostname.toLowerCase(); } catch { return true; }
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const entry of noProxy) {
    const e = entry.replace(/^\*?\.?/, '');
    if (host === e || host.endsWith('.' + e)) return false;
  }
  return true;
}

/** Run async tasks with a small concurrency cap, to stay polite to the server. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ *
 * Form discovery
 * ------------------------------------------------------------------ */

/**
 * Find the certificate-number textbox and its submit control without knowing
 * the site's field names. Runs in page context.
 */
const FIND_FORM = `(() => {
  const score = (el) => {
    const hay = [el.name, el.id, el.placeholder, el.className,
                 el.getAttribute('aria-label') || ''].join(' ').toLowerCase();
    let s = 0;
    for (const [kw, pts] of [['grn', 60], ['cert', 50], ['barcode', 45],
        ['serial', 40], ['verif', 30], ['number', 25], ['search', 20],
        ['txtno', 25], ['regno', 25], ['code', 15], ['slab', 20]]) {
      if (hay.includes(kw)) s += pts;
    }
    // A lone visible textbox on a verification page is almost certainly it.
    if (el.type === 'text' || el.type === 'search' || !el.type) s += 10;
    const r = el.getBoundingClientRect();
    if (r.width > 40 && r.height > 8) s += 15; else s -= 40;
    return s;
  };

  const inputs = [...document.querySelectorAll('input')].filter((el) => {
    const t = (el.type || 'text').toLowerCase();
    return ['text', 'search', 'tel', 'number', ''].includes(t);
  });
  if (!inputs.length) return null;

  const best = inputs.map((el) => ({ el, s: score(el) })).sort((a, b) => b.s - a.s)[0];
  const field = best.el;

  // Prefer a submit control inside the same form.
  const scope = field.form || document;
  const submits = [...scope.querySelectorAll(
    'input[type=submit],input[type=image],button,a[href*="javascript:__doPostBack"]')];
  const wanted = /verify|search|submit|check|go|find|track|view/i;
  const submit = submits.find((b) =>
    wanted.test((b.value || '') + ' ' + (b.textContent || '') + ' ' +
                (b.id || '') + ' ' + (b.name || ''))) || submits[0] || null;

  const sel = (el) => {
    if (!el) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    return null;
  };

  return {
    fieldSelector: sel(field),
    fieldName: field.name || field.id || null,
    submitSelector: sel(submit),
    submitName: submit ? (submit.name || submit.id || null) : null,
    submitText: submit ? (submit.value || submit.textContent || '').trim().slice(0, 60) : null,
    formAction: field.form ? field.form.getAttribute('action') : null,
    isWebForms: !!document.querySelector('#__VIEWSTATE, input[name="__VIEWSTATE"]'),
    candidates: inputs.slice(0, 8).map((el) => ({
      name: el.name || null, id: el.id || null,
      placeholder: el.placeholder || null, score: score(el),
    })).sort((a, b) => b.score - a.score),
  };
})()`;

/** Collect every image reference the rendered page holds. Runs in page context. */
const HARVEST_IMAGES = `(() => {
  const out = [];
  const add = (src, how, extra) => {
    if (!src) return;
    if (src.startsWith('data:')) return;
    try { out.push({ url: new URL(src, location.href).href, how, ...(extra || {}) }); }
    catch {}
  };

  for (const img of document.querySelectorAll('img')) {
    add(img.currentSrc || img.src, 'img', {
      natural: img.naturalWidth + 'x' + img.naturalHeight,
      alt: (img.alt || '').slice(0, 80),
    });
    // srcset often names a larger rendition than the one actually shown.
    for (const part of (img.getAttribute('srcset') || '').split(',')) {
      const u = part.trim().split(/\\s+/)[0];
      if (u) add(u, 'srcset');
    }
    // Lazy-loaders stash the real URL in a data-* attribute.
    for (const at of img.getAttributeNames()) {
      if (/^data-/.test(at) && /\\.(jpe?g|png|webp|gif)/i.test(img.getAttribute(at) || '')) {
        add(img.getAttribute(at), 'data-attr:' + at);
      }
    }
  }

  // Zoom/lightbox widgets put the full-size file on the anchor.
  for (const a of document.querySelectorAll('a[href]')) {
    if (/\\.(jpe?g|png|webp|gif|bmp|tiff?)($|\\?)/i.test(a.href)) add(a.href, 'anchor');
  }

  for (const el of document.querySelectorAll('*')) {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none') {
      const m = bg.match(/url\\((['"]?)(.*?)\\1\\)/);
      if (m && m[2]) add(m[2], 'css-background');
    }
  }
  return out;
})()`;

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.grn) {
    console.error('Usage: node src/pcg-track.js <GRADING_NUMBER> [--headful] [--out DIR]');
    process.exit(2);
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('playwright is not installed. Run:  npm install');
    process.exit(3);
  }

  const imgDir = path.join(opts.out, 'images');
  fs.mkdirSync(imgDir, { recursive: true });

  log(`\n=== PCG Grading tracker ===`);
  log(`grading number : ${opts.grn}`);
  log(`page           : ${opts.url}`);
  log(`output         : ${opts.out}\n`);

  // Honour the environment's egress proxy for real traffic, but never send
  // loopback or NO_PROXY hosts through it (Chromium's own bypass list does not
  // reliably exempt loopback once an explicit proxy is set).
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const useProxy = proxyServer && needsProxy(opts.url);
  const browser = await chromium.launch({
    headless: !opts.headful,
    ...(useProxy ? { proxy: { server: proxyServer } } : {}),
  });
  if (proxyServer && !useProxy) log('      (direct connection: host is loopback or in NO_PROXY)');
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: 2, // ask for retina assets where the site offers them
  });
  const page = await context.newPage();

  // ---- Record every single network call: this is the API discovery. ----
  const traffic = [];
  const byUrl = new Map();

  page.on('request', (req) => {
    const rec = {
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      postData: (req.postData() || '').slice(0, 4000) || null,
      status: null, contentType: null, contentLength: null, bodyPreview: null,
    };
    traffic.push(rec);
    byUrl.set(req.url() + '|' + req.method(), rec);
  });

  page.on('response', async (res) => {
    const rec = byUrl.get(res.url() + '|' + res.request().method());
    if (!rec) return;
    rec.status = res.status();
    const h = res.headers();
    rec.contentType = h['content-type'] || null;
    rec.contentLength = h['content-length'] ? Number(h['content-length']) : null;
    // Capture JSON/text bodies of API calls -- this is where a photo endpoint
    // usually announces itself.
    const ct = rec.contentType || '';
    if (/json|javascript|text\/plain|xml/i.test(ct) &&
        ['xhr', 'fetch', 'script'].includes(rec.resourceType)) {
      try { rec.bodyPreview = (await res.text()).slice(0, 20000); } catch {}
    }
  });

  const report = { grn: opts.grn, url: opts.url, startedAt: new Date().toISOString() };

  try {
    log('[1/6] loading verification page...');
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });

    log('[2/6] locating the certificate-number field...');
    const form = await page.evaluate(FIND_FORM);
    report.form = form;
    if (!form || !form.fieldSelector) {
      throw new Error('Could not find an input field on the page. ' +
        'Re-run with --headful to inspect it, or pass --url for the right page.');
    }
    log(`      field  : ${form.fieldName} (${form.fieldSelector})`);
    log(`      submit : ${form.submitText || '(none found)'} ${form.submitSelector || ''}`);
    log(`      ASP.NET WebForms: ${form.isWebForms}`);

    log(`[3/6] submitting ${opts.grn}...`);
    await page.fill(form.fieldSelector, opts.grn);

    // A WebForms postback replaces the document, so wait for navigation if it
    // happens, but do not fail when the site answers over AJAX instead.
    const navigated = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 })
      .then(() => true).catch(() => false);
    if (form.submitSelector) await page.click(form.submitSelector);
    else await page.press(form.fieldSelector, 'Enter');
    await navigated;
    await page.waitForLoadState('networkidle', { timeout: opts.timeout }).catch(() => {});

    report.resultUrl = page.url();
    report.resultTitle = await page.title();
    log(`      result : ${report.resultUrl}`);

    // Keep the rendered evidence.
    const html = await page.content();
    fs.writeFileSync(path.join(opts.out, 'result.html'), html);
    await page.screenshot({ path: path.join(opts.out, 'result.png'), fullPage: true })
      .catch(() => {});

    // Did the lookup actually find the certificate?
    const bodyText = await page.evaluate('document.body.innerText');
    report.grnFoundOnPage = bodyText.includes(opts.grn);
    report.looksNotFound = /not\s*found|no\s*record|invalid|does\s*not\s*exist/i.test(bodyText);
    fs.writeFileSync(path.join(opts.out, 'result.txt'), bodyText);
    log(`      grading number present in result: ${report.grnFoundOnPage}`);
    if (report.looksNotFound) log('      WARNING: page text suggests no record was found.');

    log('[4/6] harvesting image references...');
    const domImages = await page.evaluate(HARVEST_IMAGES);

    // Images the browser actually fetched (catches JS-injected sources).
    const netImages = traffic
      .filter((t) => t.resourceType === 'image' ||
        (t.contentType || '').startsWith('image/') || IMAGE_EXT_RE.test(t.url))
      .map((t) => ({ url: t.url, how: 'network', contentType: t.contentType }));

    // Image paths mentioned inside API/JSON responses.
    const apiImages = [];
    for (const t of traffic) {
      if (!t.bodyPreview) continue;
      const found = t.bodyPreview.match(/[\w./~%-]+\.(?:jpe?g|png|webp|gif)/gi) || [];
      for (const rel of new Set(found)) {
        try { apiImages.push({ url: new URL(rel, t.url).href, how: 'api-body:' + t.url }); }
        catch {}
      }
    }

    const seen = new Set();
    const discovered = [...domImages, ...netImages, ...apiImages].filter((i) => {
      if (seen.has(i.url)) return false;
      seen.add(i.url);
      return true;
    });

    // The certificate's own photos almost always carry the grading number or
    // sit on the same host; rank those first but keep everything for the log.
    const grnLower = opts.grn.toLowerCase();
    const isLikelyAsset = (u) => !/logo|icon|sprite|banner|header|footer|favicon|captcha|loader|spinner|arrow|btn_|button/i.test(u);
    const likely = discovered.filter((i) => isLikelyAsset(i.url));
    likely.sort((a, b) => {
      const s = (x) => (x.url.toLowerCase().includes(grnLower) ? 2 : 0) +
                       (x.how === 'anchor' || x.how === 'srcset' ? 1 : 0);
      return s(b) - s(a);
    });

    report.discoveredImages = discovered;
    log(`      ${discovered.length} image URL(s) found, ${likely.length} plausible certificate photos`);
    for (const i of likely.slice(0, 15)) log(`        [${i.how}] ${i.url}`);

    log('[5/6] probing for higher-resolution variants...');
    // Reuse the browser context so session cookies reach the image endpoint.
    const api = context.request;

    const probe = async (url) => {
      try {
        const res = await api.get(url, { timeout: 20000, headers: { referer: page.url() } });
        if (!res.ok()) return { url, ok: false, status: res.status() };
        const buf = Buffer.from(await res.body());
        const dim = imageSize(buf);
        const ct = res.headers()['content-type'] || '';
        if (!dim || !/image/i.test(ct)) return { url, ok: false, status: res.status(), contentType: ct };
        return {
          url, ok: true, status: res.status(), contentType: ct, bytes: buf.length,
          width: dim.width, height: dim.height, pixels: dim.width * dim.height, buf,
        };
      } catch (e) {
        return { url, ok: false, error: String(e.message || e).slice(0, 120) };
      }
    };

    const results = [];
    const savedByUrl = new Map();  // best URL      -> file already written
    const savedByHash = new Map(); // content digest -> file already written
    for (const [idx, img] of likely.entries()) {
      const candidates = generateCandidates(img.url);
      const probed = (await pool(candidates, opts.concurrency, probe)).filter((r) => r.ok);
      if (!probed.length) {
        results.push({ source: img.url, how: img.how, best: null, tried: candidates.length });
        continue;
      }
      // Highest pixel count wins; more bytes breaks a tie (less compression).
      probed.sort((a, b) => b.pixels - a.pixels || b.bytes - a.bytes);
      const best = probed[0];
      const baseline = probed.find((r) => r.url === img.url) || null;

      // Several thumbnails often resolve to the same original, and distinct
      // URLs (cache-busting params, mirrored paths) can return identical bytes.
      // Write each actual photo once, keyed by URL and by content digest.
      const digest = crypto.createHash('sha256').update(best.buf).digest('hex');
      let file = savedByUrl.get(best.url) || savedByHash.get(digest);
      const alreadySaved = !!file;
      if (!file) {
        file = path.join(imgDir, makeFilename(opts.grn, best.url, best.contentType, idx));
        fs.writeFileSync(file, best.buf);
      }
      savedByUrl.set(best.url, file);
      savedByHash.set(digest, file);

      results.push({
        source: img.url,
        how: img.how,
        tried: candidates.length,
        baseline: baseline ? { width: baseline.width, height: baseline.height, bytes: baseline.bytes } : null,
        best: {
          url: best.url, width: best.width, height: best.height,
          bytes: best.bytes, contentType: best.contentType,
          savedAs: path.relative(opts.out, file), duplicateOfEarlier: alreadySaved,
          sha256: digest,
        },
        upgraded: baseline ? best.pixels > baseline.pixels : null,
        alternatives: probed.slice(1, 6).map((r) => ({ url: r.url, width: r.width, height: r.height, bytes: r.bytes })),
      });

      const up = baseline && best.pixels > baseline.pixels
        ? `  (upgraded from ${baseline.width}x${baseline.height})` : '';
      const dup = alreadySaved ? '  [same file as an earlier thumbnail]' : '';
      log(`      ${best.width}x${best.height}  ${(best.bytes / 1024).toFixed(0)}KB  ${best.url}${up}${dup}`);
    }
    report.photos = results;

    log('[6/6] writing report...');
  } catch (err) {
    report.error = String(err.message || err);
    console.error('\nERROR: ' + report.error);
    await page.screenshot({ path: path.join(opts.out, 'error.png'), fullPage: true }).catch(() => {});
  } finally {
    report.finishedAt = new Date().toISOString();

    // The full traffic log is the answer to "which endpoint serves the photos".
    report.traffic = traffic;
    const apiCalls = traffic.filter((t) =>
      ['xhr', 'fetch'].includes(t.resourceType) ||
      /\.(ashx|asmx|ashx|json|svc)\b|\/api\//i.test(t.url));
    report.apiCalls = apiCalls;
    const imageEndpoints = [...new Set(traffic
      .filter((t) => (t.contentType || '').startsWith('image/'))
      .map((t) => t.url.split('?')[0]))];
    report.imageEndpoints = imageEndpoints;

    fs.writeFileSync(path.join(opts.out, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(opts.out, 'network-log.txt'),
      traffic.map((t) => `${String(t.status ?? '---').padEnd(4)} ${t.method.padEnd(5)} ` +
        `${(t.resourceType || '').padEnd(10)} ${t.contentType || '-'}  ${t.url}`).join('\n'));

    log(`\n--- summary -------------------------------------------`);
    log(`network requests : ${traffic.length}`);
    log(`API-ish calls    : ${apiCalls.length}`);
    log(`image endpoints  : ${imageEndpoints.length}`);
    for (const e of imageEndpoints.slice(0, 10)) log(`   ${e}`);
    if (report.photos) {
      const got = report.photos.filter((p) => p.best && !p.best.duplicateOfEarlier);
      log(`photos saved     : ${got.length} -> ${imgDir}`);
      for (const p of got) log(`   ${p.best.width}x${p.best.height}  ${p.best.savedAs}`);
    }
    log(`report           : ${path.join(opts.out, 'report.json')}`);
    log(`-------------------------------------------------------\n`);

    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
