'use strict';

/**
 * Small HTTP client built only on Node's standard library, so the tool runs
 * with nothing installed: no npm packages, no browser download.
 *
 * Covers what an ASP.NET WebForms lookup actually needs -- a cookie jar (the
 * session cookie is what ties the postback to the image handler), redirect
 * following, and gzip/deflate/brotli decoding.
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Cookies, kept per host so the session survives across the lookup. */
class CookieJar {
  constructor() { this.jar = new Map(); }

  store(urlStr, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const host = new URL(urlStr).hostname;
    if (!this.jar.has(host)) this.jar.set(host, new Map());
    const bag = this.jar.get(host);
    for (const line of [].concat(setCookieHeaders)) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      bag.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(urlStr) {
    const host = new URL(urlStr).hostname;
    const bag = this.jar.get(host);
    if (!bag || !bag.size) return null;
    return [...bag].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function decode(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  } catch {
    // A truncated or mislabelled body is better returned raw than thrown away.
  }
  return buf;
}

/**
 * Perform one request and return { status, headers, body:Buffer, url }.
 * Redirects are followed (up to `maxRedirects`), carrying cookies along.
 */
function request(urlStr, opts = {}) {
  const {
    method = 'GET', body = null, headers = {}, jar = null,
    timeout = 30000, maxRedirects = 6, _redirect = 0,
  } = opts;

  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('Bad URL: ' + urlStr)); }
    const mod = u.protocol === 'https:' ? https : http;

    const h = {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      ...headers,
    };
    const cookie = jar && jar.header(urlStr);
    if (cookie) h.cookie = cookie;
    if (body) {
      h['content-type'] = h['content-type'] || 'application/x-www-form-urlencoded';
      h['content-length'] = Buffer.byteLength(body);
    }

    const req = mod.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (jar) jar.store(urlStr, res.headers['set-cookie']);

          const loc = res.headers.location;
          if (loc && res.statusCode >= 300 && res.statusCode < 400 && _redirect < maxRedirects) {
            const next = new URL(loc, urlStr).href;
            // 303, and 301/302 by universal convention, become GET.
            const nextMethod = [301, 302, 303].includes(res.statusCode) ? 'GET' : method;
            return resolve(request(next, {
              ...opts,
              method: nextMethod,
              body: nextMethod === 'GET' ? null : body,
              _redirect: _redirect + 1,
            }));
          }

          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: decode(Buffer.concat(chunks), res.headers['content-encoding']),
            url: urlStr,
          });
        });
      });

    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('Timed out after ' + timeout + 'ms')); });
    if (body) req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * Tiny HTML helpers -- enough to drive a WebForms page without a parser
 * ------------------------------------------------------------------ */

/** Pull an attribute map out of the inside of a tag. */
function parseAttrs(inner) {
  const attrs = {};
  const re = /([\w:.-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+)))?/g;
  let m;
  while ((m = re.exec(inner))) {
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    attrs[m[1].toLowerCase()] = val === undefined ? '' : decodeEntities(val);
  }
  return attrs;
}

/** Every occurrence of `<tag ...>` as an attribute map. */
function findTags(html, tag) {
  const out = [];
  const re = new RegExp('<' + tag + '(\\s[^>]*)?/?>', 'gi');
  let m;
  while ((m = re.exec(html))) out.push(parseAttrs(m[1] || ''));
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** Visible text, roughly -- enough to tell "found" from "no record". */
function textOf(html) {
  return decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

module.exports = { request, CookieJar, findTags, parseAttrs, decodeEntities, textOf, UA };
