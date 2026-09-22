'use strict';

/**
 * Browser engine: drives the verification page in real Chromium via Playwright.
 *
 * Slower and needs a browser installed, but it runs the site's JavaScript, so
 * it sees photos injected at runtime and records the actual network calls the
 * page makes -- which is how an undocumented photo API gets found.
 */

const { isLikelyPhoto } = require('./probe');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?)(\?|#|$)/i;

/** True when `target` should be reached through an egress proxy. */
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

/** Locate the certificate box by scoring the page's inputs. Runs in-page. */
const FIND_FORM = `(() => {
  const score = (el) => {
    const hay = [el.name, el.id, el.placeholder, el.className,
                 el.getAttribute('aria-label') || ''].join(' ').toLowerCase();
    let s = 0;
    for (const [kw, pts] of [['grn', 60], ['cert', 50], ['barcode', 45],
        ['serial', 40], ['verif', 30], ['number', 25], ['search', 20],
        ['regno', 25], ['slab', 20], ['code', 15]]) {
      if (hay.includes(kw)) s += pts;
    }
    if (el.type === 'text' || el.type === 'search' || !el.type) s += 10;
    const r = el.getBoundingClientRect();
    if (r.width > 40 && r.height > 8) s += 15; else s -= 40;
    return s;
  };
  const inputs = [...document.querySelectorAll('input')].filter((el) =>
    ['text', 'search', 'tel', 'number', ''].includes((el.type || 'text').toLowerCase()));
  if (!inputs.length) return null;
  const field = inputs.map((el) => ({ el, s: score(el) })).sort((a, b) => b.s - a.s)[0].el;

  const scope = field.form || document;
  const submits = [...scope.querySelectorAll(
    'input[type=submit],input[type=image],button,a[href*="javascript:__doPostBack"]')];
  const wanted = /verify|search|submit|check|go|find|track|view/i;
  const submit = submits.find((b) => wanted.test((b.value || '') + ' ' +
    (b.textContent || '') + ' ' + (b.id || '') + ' ' + (b.name || ''))) || submits[0] || null;

  const sel = (el) => !el ? null
    : el.id ? '#' + CSS.escape(el.id)
    : el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' : null;

  return {
    fieldSelector: sel(field), fieldName: field.name || field.id || null,
    submitSelector: sel(submit), submitName: submit ? (submit.name || submit.id || null) : null,
    submitText: submit ? (submit.value || submit.textContent || '').trim().slice(0, 60) : null,
    isWebForms: !!document.querySelector('#__VIEWSTATE, input[name="__VIEWSTATE"]'),
    candidates: inputs.slice(0, 8).map((el) => ({
      name: el.name || null, id: el.id || null, score: score(el),
    })).sort((a, b) => b.score - a.score),
  };
})()`;

/** Every image reference in the rendered DOM. Runs in-page. */
const HARVEST_IMAGES = `(() => {
  const out = [];
  const add = (src, how) => {
    if (!src || src.startsWith('data:')) return;
    try { out.push({ url: new URL(src, location.href).href, how }); } catch {}
  };
  for (const img of document.querySelectorAll('img')) {
    add(img.currentSrc || img.src, 'img');
    for (const p of (img.getAttribute('srcset') || '').split(',')) {
      const u = p.trim().split(/\\s+/)[0]; if (u) add(u, 'srcset');
    }
    for (const at of img.getAttributeNames()) {
      if (/^data-/.test(at) && /\\.(jpe?g|png|webp|gif)/i.test(img.getAttribute(at) || '')) {
        add(img.getAttribute(at), 'data-attr:' + at);
      }
    }
  }
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

/**
 * Look the grading number up in a real browser.
 * Returns the same shape as the HTTP engine, plus a live network log and an
 * open `fetchImage` bound to the browser session (close it with `dispose`).
 */
async function lookup(grn, pageUrl, opts = {}) {
  const { timeout = 45000, headful = false, log = () => {}, screenshotPath = null } = opts;

  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { throw new Error('Playwright is not installed. Run: npm install && npx playwright install chromium'); }

  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const useProxy = proxyServer && needsProxy(pageUrl);
  const browser = await chromium.launch({
    headless: !headful,
    ...(useProxy ? { proxy: { server: proxyServer } } : {}),
  });
  const context = await browser.newContext({
    userAgent: UA, viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Record every network call: this is what exposes an undocumented photo API.
  const traffic = [];
  const byKey = new Map();
  page.on('request', (req) => {
    const rec = {
      url: req.url(), method: req.method(), resourceType: req.resourceType(),
      postData: (req.postData() || '').slice(0, 4000) || null,
      status: null, contentType: null, bodyPreview: null,
    };
    traffic.push(rec);
    byKey.set(req.url() + '|' + req.method(), rec);
  });
  page.on('response', async (res) => {
    const rec = byKey.get(res.url() + '|' + res.request().method());
    if (!rec) return;
    rec.status = res.status();
    rec.contentType = res.headers()['content-type'] || null;
    if (/json|javascript|text\/plain|xml/i.test(rec.contentType || '') &&
        ['xhr', 'fetch', 'script'].includes(rec.resourceType)) {
      try { rec.bodyPreview = (await res.text()).slice(0, 20000); } catch {}
    }
  });

  const info = { engine: 'browser', pageUrl };
  try {
    log('[1/5] loading verification page...');
    if (proxyServer && !useProxy) log('      (direct connection: loopback or NO_PROXY host)');
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout });

    log('[2/5] locating the certificate field...');
    const form = await page.evaluate(FIND_FORM);
    info.form = form;
    if (!form || !form.fieldSelector) {
      throw new Error('Could not find an input field. Re-run with --headful to look at the page.');
    }
    log(`      field  : ${form.fieldName}`);
    log(`      submit : ${form.submitText || '(none)'}`);
    log(`      ASP.NET WebForms: ${form.isWebForms}`);

    log(`[3/5] submitting ${grn}...`);
    await page.fill(form.fieldSelector, grn);
    const navigated = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 })
      .then(() => true).catch(() => false);
    if (form.submitSelector) await page.click(form.submitSelector);
    else await page.press(form.fieldSelector, 'Enter');
    await navigated;
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});

    info.resultUrl = page.url();
    info.resultTitle = await page.title();
    const resultHtml = await page.content();
    const resultText = await page.evaluate('document.body.innerText');
    info.grnFoundOnPage = resultText.toUpperCase().includes(grn.toUpperCase());
    info.looksNotFound = /not\s*found|no\s*record|invalid|does\s*not\s*exist|no\s*data/i.test(resultText);
    log(`      grading number present in result: ${info.grnFoundOnPage}`);
    if (info.looksNotFound) log('      WARNING: page text suggests no record was found.');

    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    log('[4/5] collecting image references...');
    const domImages = await page.evaluate(HARVEST_IMAGES);
    const netImages = traffic
      .filter((t) => t.resourceType === 'image' || (t.contentType || '').startsWith('image/') ||
        IMAGE_EXT_RE.test(t.url))
      .map((t) => ({ url: t.url, how: 'network' }));
    const apiImages = [];
    for (const t of traffic) {
      if (!t.bodyPreview) continue;
      for (const rel of new Set(t.bodyPreview.match(/[\w./~%-]+\.(?:jpe?g|png|webp|gif)/gi) || [])) {
        try { apiImages.push({ url: new URL(rel, t.url).href, how: 'api-body' }); } catch {}
      }
    }

    info.traffic = traffic;
    info.apiCalls = traffic.filter((t) => ['xhr', 'fetch'].includes(t.resourceType) ||
      /\.(ashx|asmx|json|svc)\b|\/api\//i.test(t.url));
    info.imageEndpoints = [...new Set(traffic
      .filter((t) => (t.contentType || '').startsWith('image/'))
      .map((t) => t.url.split('?')[0]))];

    // Image fetches reuse the browser session, so cookie-gated handlers work.
    const fetchImage = async (url) => {
      const r = await context.request.get(url, { timeout: 20000, headers: { referer: page.url() } });
      if (!r.ok()) return { ok: false, status: r.status() };
      return {
        ok: true, status: r.status(),
        contentType: r.headers()['content-type'] || '',
        buf: Buffer.from(await r.body()),
      };
    };

    return {
      info, resultHtml, resultText,
      images: [...domImages, ...netImages, ...apiImages],
      fetchImage,
      dispose: () => browser.close().catch(() => {}),
    };
  } catch (err) {
    info.traffic = traffic;
    await browser.close().catch(() => {});
    throw err;
  }
}

module.exports = { lookup, needsProxy };
