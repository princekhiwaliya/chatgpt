'use strict';

/**
 * Plain-HTTP engine: performs the certificate lookup by replaying the ASP.NET
 * WebForms postback directly, with no browser involved.
 *
 * This is the default because it needs nothing installed. It cannot run the
 * site's JavaScript, so anything drawn purely client-side is invisible to it --
 * it compensates by scanning inline scripts for endpoints and calling the
 * JSON-ish ones itself. When a site turns out to need real rendering, the
 * browser engine takes over.
 */

const { request, CookieJar, findTags, decodeEntities, textOf } = require('./http');

const IMAGE_PATH_RE = /(?:https?:\/\/[^\s"'<>()]+|\/[^\s"'<>()]*|[\w.~-]+(?:\/[\w.~-]+)*)\.(?:jpe?g|png|webp|gif|bmp|tiff?)(?:\?[^\s"'<>()]*)?/gi;

/** Score a text input on how much it looks like the certificate-number box. */
function scoreInput(a) {
  const hay = [a.name, a.id, a.placeholder, a.class, a['aria-label']]
    .filter(Boolean).join(' ').toLowerCase();
  let s = 0;
  for (const [kw, pts] of [['grn', 60], ['cert', 50], ['barcode', 45], ['serial', 40],
    ['verif', 30], ['number', 25], ['search', 20], ['regno', 25], ['slab', 20],
    ['code', 15], ['no', 8]]) {
    if (hay.includes(kw)) s += pts;
  }
  const type = (a.type || 'text').toLowerCase();
  if (['text', 'search', 'tel', ''].includes(type)) s += 10;
  return s;
}

/** Pull every image reference out of raw HTML. */
function extractImages(html, baseUrl, label) {
  const out = [];
  const seen = new Set();
  const add = (raw, how) => {
    if (!raw || raw.startsWith('data:')) return;
    let abs;
    try { abs = new URL(decodeEntities(raw.trim()), baseUrl).href; } catch { return; }
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ url: abs, how: label ? `${how}@${label}` : how });
  };

  for (const a of findTags(html, 'img')) {
    add(a.src, 'img');
    for (const part of (a.srcset || '').split(',')) add(part.trim().split(/\s+/)[0], 'srcset');
    // Lazy-loaders stash the real URL in a data-* attribute.
    for (const [k, v] of Object.entries(a)) {
      if (k.startsWith('data-') && /\.(jpe?g|png|webp|gif)/i.test(v || '')) add(v, 'data-attr:' + k);
    }
  }

  // Zoom/lightbox widgets point at the full-size file.
  for (const a of findTags(html, 'a')) {
    if (a.href && /\.(jpe?g|png|webp|gif|bmp|tiff?)($|\?)/i.test(a.href)) add(a.href, 'anchor');
  }

  // Inline styles and <style> blocks.
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*url\((['"]?)(.*?)\1\)/gi)) {
    add(m[2], 'css-background');
  }

  // Anything left in the markup or inline scripts that looks like an image path.
  for (const m of html.matchAll(IMAGE_PATH_RE)) add(m[0], 'html-scan');

  return out;
}

/** Endpoints referenced from inline scripts that might return photo metadata. */
function findApiCandidates(html, baseUrl) {
  const out = new Set();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const re = /['"]((?:https?:\/\/|\/)[^'"\s]*?(?:\.(?:ashx|asmx|svc|json)|\/api\/|handler|getimage|photo|image)[^'"\s]*)['"]/gi;
  for (const body of scripts) {
    for (const m of body.matchAll(re)) {
      try { out.add(new URL(decodeEntities(m[1]), baseUrl).href); } catch {}
    }
  }
  return [...out].slice(0, 12);
}

/**
 * Look the grading number up over plain HTTP.
 * @returns {Promise<object>} what the lookup found, for the caller to report on
 */
async function lookup(grn, pageUrl, opts = {}) {
  const { timeout = 30000, log = () => {} } = opts;
  const jar = new CookieJar();
  const info = { engine: 'http', pageUrl };

  log('[1/5] loading verification page...');
  const first = await request(pageUrl, { jar, timeout });
  info.pageStatus = first.status;
  if (first.status >= 400) throw new Error(`Verification page returned HTTP ${first.status}`);
  const pageHtml = first.body.toString('utf8');
  info.finalPageUrl = first.url;

  log('[2/5] reading the form...');
  const inputs = findTags(pageHtml, 'input');
  const hidden = {};
  for (const a of inputs) {
    if ((a.type || '').toLowerCase() === 'hidden' && a.name) hidden[a.name] = a.value || '';
  }
  info.isWebForms = '__VIEWSTATE' in hidden;
  info.hiddenFields = Object.keys(hidden);

  const textInputs = inputs.filter((a) => {
    const t = (a.type || 'text').toLowerCase();
    return a.name && ['text', 'search', 'tel', 'number', ''].includes(t);
  });
  if (!textInputs.length) throw new Error('No text input found on the verification page.');

  const ranked = textInputs.map((a) => ({ a, s: scoreInput(a) })).sort((x, y) => y.s - x.s);
  const field = ranked[0].a;
  info.field = { name: field.name, id: field.id || null, score: ranked[0].s };
  info.fieldCandidates = ranked.slice(0, 6)
    .map((r) => ({ name: r.a.name, id: r.a.id || null, score: r.s }));

  // The submit control must be posted too: WebForms uses it to route the event.
  const submits = inputs.filter((a) =>
    ['submit', 'image'].includes((a.type || '').toLowerCase()) && a.name);
  const wanted = /verify|search|submit|check|go|find|track|view/i;
  const submit = submits.find((a) => wanted.test((a.value || '') + ' ' + (a.name || '') + ' ' + (a.id || '')))
    || submits[0] || null;
  info.submit = submit ? { name: submit.name, value: submit.value || '' } : null;

  // Where the form posts.
  const formTag = findTags(pageHtml, 'form')[0] || {};
  const action = formTag.action ? new URL(decodeEntities(formTag.action), first.url).href : first.url;
  info.action = action;
  log(`      field  : ${field.name}`);
  log(`      submit : ${submit ? (submit.value || submit.name) : '(none)'}`);
  log(`      ASP.NET WebForms: ${info.isWebForms}`);

  log(`[3/5] submitting ${grn}...`);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(hidden)) form.set(k, v);
  form.set(field.name, grn);
  if (submit) form.set(submit.name, submit.value || 'Submit');

  const res = await request(action, {
    method: 'POST', body: form.toString(), jar, timeout,
    headers: { referer: first.url, origin: new URL(first.url).origin },
  });
  info.resultStatus = res.status;
  info.resultUrl = res.url;
  const resultHtml = res.body.toString('utf8');
  const resultText = textOf(resultHtml);
  info.grnFoundOnPage = resultText.toUpperCase().includes(grn.toUpperCase());
  info.looksNotFound = /not\s*found|no\s*record|invalid|does\s*not\s*exist|no\s*data/i.test(resultText);
  log(`      HTTP ${res.status}, grading number present in result: ${info.grnFoundOnPage}`);
  if (info.looksNotFound) log('      WARNING: page text suggests no record was found.');

  log('[4/5] collecting image references...');
  let images = extractImages(resultHtml, res.url);

  // Call the JSON-ish endpoints the page's scripts mention, and mine those too.
  const apiCandidates = findApiCandidates(resultHtml, res.url)
    .map((u) => u.replace(/\{\{?\s*cert\w*\s*\}?\}/gi, grn));
  info.apiCandidates = apiCandidates;
  info.apiResponses = [];
  for (const api of apiCandidates) {
    try {
      const r = await request(api, { jar, timeout: 15000, headers: { referer: res.url } });
      const ct = r.headers['content-type'] || '';
      if (r.status >= 400) continue;
      if (/image\//i.test(ct)) { images.push({ url: api, how: 'api-image' }); continue; }
      const body = r.body.toString('utf8').slice(0, 20000);
      info.apiResponses.push({ url: api, status: r.status, contentType: ct, bodyPreview: body });
      images = images.concat(extractImages(body, api, 'api'));
    } catch {
      // An endpoint guessed from a script may simply not exist; that's fine.
    }
  }

  return { info, resultHtml, resultText, images, pageHtml };
}

module.exports = { lookup, extractImages, findApiCandidates, scoreInput };
