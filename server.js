#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════
   ARCHIVE_OS // PROXY SERVER   (no dependencies, Node 18+)

   Run:   node server.js
   Open:  http://localhost:3000      (use Chrome / Edge / Firefox)

   What it does
   ─ Serves archive_os_browser.html
   ─ Gives every website its OWN origin via wildcard subdomains:
        https://en.wikipedia.org  ->  http://en.wikipedia.org.s.px.localhost:3000
     (*.localhost resolves to your machine automatically in Chrome/Edge/Firefox)
     so sites keep real paths, cookies, localStorage, POST forms, etc.
   ─ Strips X-Frame-Options / CSP so pages can render inside your tabs
   ─ Rewrites links/forms/CSS and injects a small runtime that patches
     fetch / XHR / window.open / navigation
   ─ Keeps a cookie jar so logins work
   ─ Streams video/audio/downloads with Range support
   ─ Powers ARCHIVE_SEARCH:  web, images, videos, news
   ════════════════════════════════════════════════════════════════ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PROXY_DOMAIN = (process.env.PROXY_DOMAIN || 'px.localhost').toLowerCase();
const PUBLIC_SCHEME = process.env.PUBLIC_SCHEME || 'http';
const HTML_FILE = path.join(__dirname, 'archive_os_browser.html');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ───────────── helpers ───────────── */
const ENT = { amp: '&', quot: '"', lt: '<', gt: '>', apos: "'", nbsp: ' ' };
function decEnt(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } })
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch (e) { return m; } })
    .replace(/&(amp|quot|lt|gt|apos|nbsp);/g, (m, k) => ENT[k]);
}
function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
function strip(s) { return decEnt(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function cdata(s) { return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); }

/* ───────────── host <-> url mapping ─────────────
   label format:  <host>[.p<port>].<s|h>.<PROXY_DOMAIN>[:serverPort]
*/
function decodeHost(hostHeader) {
  const h = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  if (!h.endsWith('.' + PROXY_DOMAIN)) return null;
  const parts = h.slice(0, -(PROXY_DOMAIN.length + 1)).split('.');
  const sc = parts.pop();
  if (sc !== 's' && sc !== 'h') return null;
  let port = '';
  if (parts.length > 1 && /^p\d+$/.test(parts[parts.length - 1])) port = ':' + parts.pop().slice(1);
  if (!parts.length) return null;
  return { scheme: sc === 's' ? 'https' : 'http', host: parts.join('.'), port };
}
function suffixOf(hostHeader) {
  const m = String(hostHeader || '').match(/:\d+$/);
  return PROXY_DOMAIN + (m ? m[0] : '');
}
function toProxy(abs, suffix) {
  let u;
  try { u = new URL(abs); } catch (e) { return abs; }
  if (!/^https?:$/.test(u.protocol)) return abs;
  if (u.hostname.includes(':') || u.hostname.includes('[')) return abs;
  const sc = u.protocol === 'https:' ? 's' : 'h';
  const label = u.hostname + (u.port ? '.p' + u.port : '') + '.' + sc;
  return PUBLIC_SCHEME + '://' + label + '.' + suffix + u.pathname + u.search + u.hash;
}
function unproxy(urlStr) {
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr);
    const t = decodeHost(u.host);
    if (!t) return null;
    return t.scheme + '://' + t.host + t.port + u.pathname + u.search;
  } catch (e) { return null; }
}

/* ───────────── cookie jar (single user) ───────────── */
const jar = new Map(); // domain -> Map(name -> value)
function storeCookies(host, list) {
  for (const sc of list) {
    const parts = sc.split(';');
    const eq = parts[0].indexOf('=');
    if (eq < 1) continue;
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    let dom = host, kill = false;
    for (const p of parts.slice(1)) {
      const t = p.trim();
      const lt = t.toLowerCase();
      if (lt.startsWith('domain=')) dom = lt.slice(7).replace(/^\./, '');
      else if (lt.startsWith('max-age=')) { if (parseInt(lt.slice(8), 10) <= 0) kill = true; }
      else if (lt.startsWith('expires=')) { const d = Date.parse(t.slice(8)); if (!isNaN(d) && d < Date.now()) kill = true; }
    }
    if (!jar.has(dom)) jar.set(dom, new Map());
    if (kill) jar.get(dom).delete(name); else jar.get(dom).set(name, value);
  }
}
function cookieFor(host) {
  const out = [];
  for (const [d, m] of jar) {
    if (host === d || host.endsWith('.' + d)) for (const [n, v] of m) out.push(n + '=' + v);
  }
  return out.join('; ');
}

/* ───────────── rewriting ───────────── */
// returns a proxied URL, or null when the value should be left alone
function rw(val, base, suffix, all) {
  let v = decEnt(String(val).trim());
  if (v.startsWith('//')) v = base.protocol + v;
  if (!/^https?:\/\//i.test(v)) return null;
  let u;
  try { u = new URL(v); } catch (e) { return null; }
  if (!all && u.hostname !== base.hostname) return null;
  return toProxy(u.href, suffix);
}

function rewriteCss(css, base, suffix) {
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => {
      const font = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(u);
      const r = rw(u, base, suffix, font);
      return r ? 'url(' + q + r + q + ')' : m;
    })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, u) => {
      const r = rw(u, base, suffix, true);
      return r ? '@import ' + q + r + q : m;
    });
}

function rewriteHtml(html, base, suffix) {
  // kill CSP meta tags
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '');

  // tag-level attribute rewriting
  html = html.replace(/<(a|area|form|base|img|script|link|source|video|audio|iframe|embed|object|input|track|meta)(\s[^>]*)?>/gi, (full, tag, attrs) => {
    if (!attrs) return full;
    const t = tag.toLowerCase();
    const force = t === 'a' || t === 'area' || t === 'form' || t === 'base' ||
      /\scrossorigin\b/i.test(attrs) || (t === 'script' && /\stype\s*=\s*["']?module/i.test(attrs));
    const all = force && t !== 'iframe';

    attrs = attrs.replace(/\sintegrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

    attrs = attrs.replace(/(\s)(src|href|action|poster|data-src|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (m, sp, name, d, s) => {
      const r = rw(d !== undefined ? d : s, base, suffix, all);
      return r ? sp + name + '="' + escAttr(r) + '"' : m;
    });

    attrs = attrs.replace(/(\s)(srcset|data-srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (m, sp, name, d, s) => {
      const val = decEnt(d !== undefined ? d : s);
      const out = val.split(',').map(c => {
        const bits = c.trim().split(/\s+/);
        const r = rw(bits[0] || '', base, suffix, all);
        if (r) bits[0] = r;
        return bits.join(' ');
      }).join(', ');
      return sp + name + '="' + escAttr(out) + '"';
    });

    if (t === 'meta' && /http-equiv\s*=\s*["']?refresh/i.test(attrs)) {
      attrs = attrs.replace(/(content\s*=\s*["'][^"']*?url\s*=\s*)([^"']+)/i, (m, a, u) => {
        const r = rw(u, base, suffix, true);
        return r ? a + r : m;
      });
    }
    return '<' + tag + attrs + '>';
  });

  // <style> blocks
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, c) => a + rewriteCss(css, base, suffix) + c);

  // inject runtime
  const tagSrc = '<script>(' + agent.toString() + ')(' + JSON.stringify({ domain: PROXY_DOMAIN }) + ');</script>';
  if (/<head(\s[^>]*)?>/i.test(html)) html = html.replace(/<head(\s[^>]*)?>/i, m => m + tagSrc);
  else if (/<html(\s[^>]*)?>/i.test(html)) html = html.replace(/<html(\s[^>]*)?>/i, m => m + tagSrc);
  else if (/^\s*<!doctype[^>]*>/i.test(html)) html = html.replace(/^\s*<!doctype[^>]*>/i, m => m + tagSrc);
  else html = tagSrc + html;
  return html;
}

/* ───────────── runtime injected into every proxied page ─────────────
   (this function is serialised with .toString() and runs in the browser) */
function agent(cfg) {
  if (window.__archiveAgent) return;
  window.__archiveAgent = true;
  var D = cfg.domain;
  function P(m) { try { parent.postMessage(m, '*'); } catch (e) {} }
  function dec(h) {
    h = String(h).toLowerCase();
    if (h.slice(-(D.length + 1)) !== '.' + D) return null;
    var parts = h.slice(0, -(D.length + 1)).split('.');
    var sc = parts.pop();
    if (sc !== 's' && sc !== 'h') return null;
    var port = '';
    if (parts.length > 1 && /^p\d+$/.test(parts[parts.length - 1])) port = ':' + parts.pop().slice(1);
    return (sc === 's' ? 'https' : 'http') + '://' + parts.join('.') + port;
  }
  function real(href) {
    try { var u = new URL(href, location.href); var o = dec(u.hostname); return o ? o + u.pathname + u.search + u.hash : u.href; }
    catch (e) { return href; }
  }
  function toP(href) {
    try {
      var u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return href;
      if (dec(u.hostname) !== null) return u.href;
      if (u.hostname.indexOf(':') > -1) return u.href;
      var label = u.hostname + (u.port ? '.p' + u.port : '') + '.' + (u.protocol === 'https:' ? 's' : 'h');
      return location.protocol + '//' + label + '.' + D + (location.port ? ':' + location.port : '') + u.pathname + u.search + u.hash;
    } catch (e) { return href; }
  }
  function fix(u) {
    try { var a = new URL(u, location.href); if (/^https?:$/.test(a.protocol) && dec(a.hostname) === null) return toP(a.href); }
    catch (e) {}
    return u;
  }

  // network patches
  var F = window.fetch;
  if (F) window.fetch = function (i, init) {
    try {
      if (typeof i === 'string' || (window.URL && i instanceof URL)) i = fix(String(i));
      else if (i && i.url) { var n = fix(i.url); if (n !== i.url) i = new Request(n, i); }
    } catch (e) {}
    return F.call(this, i, init);
  };
  var XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    var a = [].slice.call(arguments);
    try { a[1] = fix(String(u)); } catch (e) {}
    return XO.apply(this, a);
  };
  if (navigator.sendBeacon) {
    var SB = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, d) { return SB(fix(String(u)), d); };
  }
  if (window.EventSource) {
    var ES = window.EventSource;
    window.EventSource = function (u, o) { return new ES(fix(String(u)), o); };
    window.EventSource.prototype = ES.prototype;
  }
  if (navigator.serviceWorker) {
    try { navigator.serviceWorker.register = function () { return Promise.reject(new Error('service workers disabled')); }; } catch (e) {}
  }

  // links
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var raw = a.getAttribute('href') || '';
    if (/^\s*(javascript:|#|mailto:|tel:|data:|blob:)/i.test(raw)) return;
    if (a.hasAttribute('download')) return;
    var href;
    try { href = new URL(raw, location.href).href; } catch (x) { return; }
    if (!/^https?:/i.test(href)) return;
    var blank = a.target === '_blank' || e.ctrlKey || e.metaKey || e.button === 1;
    if (blank) { e.preventDefault(); P({ type: 'ARCHIVE_NAV', url: real(href), newTab: true }); return; }
    if (a.target === '_top' || a.target === '_parent' || dec(new URL(href).hostname) === null) {
      e.preventDefault();
      location.href = toP(href);
    }
  }, false);

  // forms with absolute/off-proxy actions
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || f.tagName !== 'FORM' || e.defaultPrevented) return;
    try {
      var u = new URL(f.getAttribute('action') || location.href, location.href);
      if (/^https?:$/.test(u.protocol) && dec(u.hostname) === null) f.action = toP(u.href);
    } catch (x) {}
  }, true);

  // popups -> new tab in the browser shell
  window.open = function (u) {
    try { if (u) P({ type: 'ARCHIVE_NAV', url: real(u), newTab: true }); } catch (e) {}
    return null;
  };

  // scripted navigations (location.href = ...)
  try {
    if (window.navigation && navigation.addEventListener) {
      navigation.addEventListener('navigate', function (e) {
        try {
          if (!e.cancelable || e.hashChange || e.downloadRequest) return;
          var d = e.destination;
          if (!d || d.sameDocument) return;
          var u = new URL(d.url);
          if (!/^https?:$/.test(u.protocol) || dec(u.hostname) !== null) return;
          e.preventDefault();
          location.href = toP(u.href);
        } catch (x) {}
      });
    }
  } catch (e) {}

  // tell the shell where we are
  function rep() { P({ type: 'ARCHIVE_LOC', url: real(location.href), title: document.title || '' }); }
  ['pushState', 'replaceState'].forEach(function (k) {
    var o = history[k];
    history[k] = function () { var r = o.apply(this, arguments); setTimeout(rep, 0); return r; };
  });
  window.addEventListener('popstate', rep);
  window.addEventListener('hashchange', rep);
  window.addEventListener('load', rep);
  document.addEventListener('DOMContentLoaded', rep);
  var lastTitle = document.title;
  setInterval(function () { if (document.title !== lastTitle) { lastTitle = document.title; rep(); } }, 1000);
  rep();
}

/* ───────────── proxying ───────────── */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeBuf(buf, ct) {
  let cs = (ct.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!cs) {
    const head = buf.slice(0, 2048).toString('latin1');
    cs = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  try { return new TextDecoder((cs || 'utf-8').toLowerCase()).decode(buf); }
  catch (e) { return buf.toString('utf8'); }
}

const DROP = new Set(['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'set-cookie',
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'strict-transport-security',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'report-to', 'nel',
  'public-key-pins', 'alt-svc', 'permissions-policy', 'origin-agent-cluster']);

function cors(req, h) {
  const o = req.headers.origin;
  h['access-control-allow-origin'] = o || '*';
  if (o) h['access-control-allow-credentials'] = 'true';
  h['access-control-expose-headers'] = '*';
  h['access-control-allow-private-network'] = 'true';
  h['vary'] = 'Origin';
  return h;
}

function sendErr(res, code, msg, extra) {
  const body = '<!DOCTYPE html><html><body style="background:#0a0a0a;color:#ffcc00;font-family:Courier New,monospace;padding:40px">' +
    '<div style="letter-spacing:4px;font-size:11px;opacity:.6">ARCHIVE_OS // PROXY_ERROR</div>' +
    '<h2 style="letter-spacing:4px;margin:14px 0">' + escAttr(msg) + '</h2>' +
    '<div style="font-size:12px;opacity:.7;line-height:1.8">' + escAttr(extra || '') + '</div></body></html>';
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

async function handleProxy(req, res, target) {
  const hostHeader = req.headers.host || '';
  const suffix = suffixOf(hostHeader);
  let upstream;
  try { upstream = new URL(target.scheme + '://' + target.host + target.port + req.url); }
  catch (e) { return sendErr(res, 400, 'BAD_URL'); }

  if (req.method === 'OPTIONS') {
    const h = cors(req, {});
    h['access-control-allow-methods'] = 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS';
    h['access-control-allow-headers'] = req.headers['access-control-request-headers'] || '*';
    h['access-control-max-age'] = '86400';
    res.writeHead(204, h);
    return res.end();
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (['host', 'connection', 'content-length', 'accept-encoding', 'cookie', 'referer', 'origin',
      'upgrade-insecure-requests', 'transfer-encoding', 'te', 'keep-alive'].includes(lk) || lk.startsWith('sec-fetch')) continue;
    headers[k] = v;
  }
  headers['user-agent'] = headers['user-agent'] || UA;
  const cookie = [cookieFor(upstream.hostname), req.headers.cookie].filter(Boolean).join('; ');
  if (cookie) headers.cookie = cookie;
  headers.referer = unproxy(req.headers.referer) || (upstream.origin + '/');
  if (req.headers.origin) headers.origin = unproxy(req.headers.origin) || upstream.origin;

  let body;
  if (!['GET', 'HEAD'].includes(req.method)) body = await readBody(req);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let r;
  try {
    r = await fetch(upstream.href, { method: req.method, headers, body, redirect: 'manual', signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    return sendErr(res, 502, 'UPSTREAM_UNREACHABLE', upstream.href + '  //  ' + (e.cause && e.cause.code || e.name || e.message));
  }
  clearTimeout(timer);

  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (sc.length) storeCookies(upstream.hostname, sc);

  const out = {};
  r.headers.forEach((v, k) => { if (!DROP.has(k.toLowerCase())) out[k] = v; });
  cors(req, out);

  if (out.location) {
    try { out.location = toProxy(new URL(out.location, upstream).href, suffix); } catch (e) {}
  }
  if (out.refresh) {
    out.refresh = out.refresh.replace(/(url\s*=\s*)(\S+)/i, (m, a, u) => { try { return a + toProxy(new URL(u, upstream).href, suffix); } catch (e) { return m; } });
  }

  const status = r.status;
  const ct = (r.headers.get('content-type') || '').toLowerCase();

  if (req.method === 'HEAD' || status === 204 || status === 304 || (status >= 300 && status < 400)) {
    if (r.body) r.body.cancel().catch(() => {});
    res.writeHead(status, out);
    return res.end();
  }

  try {
    if (ct.includes('text/html') || ct.includes('application/xhtml')) {
      const buf = Buffer.from(await r.arrayBuffer());
      const html = rewriteHtml(decodeBuf(buf, ct), upstream, suffix);
      out['content-type'] = 'text/html; charset=utf-8';
      out['content-length'] = Buffer.byteLength(html);
      out['cache-control'] = 'no-store';
      delete out.etag; delete out['last-modified'];
      res.writeHead(status, out);
      return res.end(html);
    }
    if (ct.includes('text/css')) {
      const buf = Buffer.from(await r.arrayBuffer());
      const css = rewriteCss(decodeBuf(buf, ct), upstream, suffix);
      out['content-type'] = 'text/css; charset=utf-8';
      out['content-length'] = Buffer.byteLength(css);
      res.writeHead(status, out);
      return res.end(css);
    }
    // everything else streams straight through
    if (!r.headers.get('content-encoding') && r.headers.get('content-length')) out['content-length'] = r.headers.get('content-length');
    res.writeHead(status, out);
    if (!r.body) return res.end();
    const stream = Readable.fromWeb(r.body);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) sendErr(res, 502, 'PROXY_STREAM_ERROR', String(e.message || e));
    else res.destroy();
  }
}

/* ───────────── search backends ───────────── */
async function get(url, extra, timeout) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout || 10000);
  try {
    const r = await fetch(url, {
      headers: Object.assign({
        'user-agent': UA, 'accept-language': 'en-US,en;q=0.9',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }, extra || {}),
      signal: ctl.signal, redirect: 'follow'
    });
    return await r.text();
  } finally { clearTimeout(t); }
}

function bingUrl(h) {
  h = decEnt(h);
  try {
    const u = new URL(h);
    if (/bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/')) {
      let p = u.searchParams.get('u') || '';
      if (p.startsWith('a1')) {
        p = p.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        return Buffer.from(p, 'base64').toString('utf8');
      }
    }
  } catch (e) {}
  return h;
}

async function webDDG(q) {
  const html = await get('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q));
  const out = [];
  for (const chunk of html.split(/class="result results_links/).slice(1)) {
    if (chunk.slice(0, 160).includes('result--ad')) continue;
    const tag = chunk.match(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>/);
    if (!tag) continue;
    let href = (tag[0].match(/href="([^"]*)"/) || [])[1] || '';
    href = decEnt(href);
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) { try { href = decodeURIComponent(m[1]); } catch (e) {} }
    else if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//.test(href) || href.includes('duckduckgo.com/y.js')) continue;
    const rest = chunk.slice(chunk.indexOf(tag[0]) + tag[0].length);
    const title = strip(rest.slice(0, rest.indexOf('</a>')));
    const sn = chunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title, url: href, snippet: sn ? strip(sn[1]) : '' });
  }
  return out;
}

async function webBing(q) {
  const html = await get('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=en-US');
  const out = [];
  for (const chunk of html.split(/<li class="b_algo/).slice(1)) {
    const h = chunk.match(/<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!h) continue;
    const p = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const url = bingUrl(h[1]);
    if (!/^https?:\/\//.test(url)) continue;
    out.push({ title: strip(h[2]), url, snippet: p ? strip(p[1]) : '' });
  }
  return out;
}

async function imagesBing(q) {
  const html = await get('https://www.bing.com/images/search?q=' + encodeURIComponent(q) + '&form=HDRSC3&first=1&count=60',
    { cookie: 'SRCHHPGUSR=ADLT=MODERATE' });
  const out = [];
  const re = /<a[^>]*class="iusc"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 60) {
    const mm = m[0].match(/\sm="([^"]*)"/);
    if (!mm) continue;
    try {
      const j = JSON.parse(decEnt(mm[1]));
      if (j.turl && j.murl) out.push({ thumb: j.turl, full: j.murl, title: strip(j.t || ''), url: j.purl || j.murl });
    } catch (e) {}
  }
  return out;
}

async function videosYT(q) {
  const html = await get('https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&hl=en&gl=US',
    { cookie: 'CONSENT=YES+cb; SOCS=CAI' });
  const m = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return []; }
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object' || out.length >= 30) return;
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const v = o.videoRenderer;
      out.push({
        id: v.videoId,
        title: (v.title && v.title.runs && v.title.runs.map(r => r.text).join('')) || '',
        thumb: 'https://i.ytimg.com/vi/' + v.videoId + '/hqdefault.jpg',
        duration: (v.lengthText && v.lengthText.simpleText) || '',
        channel: (v.ownerText && v.ownerText.runs && v.ownerText.runs[0].text) || '',
        views: (v.viewCountText && v.viewCountText.simpleText) || '',
        published: (v.publishedTimeText && v.publishedTimeText.simpleText) || '',
        url: 'https://www.youtube.com/watch?v=' + v.videoId
      });
      return;
    }
    for (const k in o) walk(o[k]);
  })(data);
  return out;
}

async function newsBing(q) {
  const xml = await get('https://www.bing.com/news/search?q=' + encodeURIComponent(q) + '&format=rss');
  const out = [];
  for (const it of xml.split('<item>').slice(1)) {
    const g = tag => {
      const m = it.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
      return m ? strip(cdata(m[1])) : '';
    };
    let link = g('link');
    try { const u = new URL(decEnt(link)); const real = u.searchParams.get('url'); if (real) link = real; } catch (e) {}
    if (!/^https?:/.test(link)) continue;
    let img = g('News:Image');
    if (img.startsWith('//')) img = 'https:' + img;
    out.push({ title: g('title'), url: link, snippet: g('description'), source: g('News:Source'), time: g('pubDate'), image: img });
  }
  return out;
}

async function newsGoogle(q) {
  const xml = await get('https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en');
  const out = [];
  for (const it of xml.split('<item>').slice(1)) {
    const g = tag => { const m = it.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>')); return m ? strip(cdata(m[1])) : ''; };
    const link = g('link');
    if (!/^https?:/.test(link)) continue;
    out.push({ title: g('title'), url: link, snippet: '', source: g('source'), time: g('pubDate'), image: '' });
  }
  return out;
}

const cache = new Map();
async function runSearch(type, q) {
  const key = type + '|' + q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.data;
  const chains = {
    web: [['ddg', webDDG], ['bing', webBing]],
    images: [['bing', imagesBing]],
    videos: [['youtube', videosYT]],
    news: [['bing', newsBing], ['google', newsGoogle]]
  }[type];
  if (!chains) return { ok: false, error: 'UNKNOWN_TYPE', results: [] };
  let last = '';
  for (const [name, fn] of chains) {
    try {
      const results = await fn(q);
      if (results && results.length) {
        const data = { ok: true, source: name, results };
        cache.set(key, { t: Date.now(), data });
        return data;
      }
      last = name + ': no results';
    } catch (e) { last = name + ': ' + (e.name === 'AbortError' ? 'timeout' : e.message); }
  }
  return { ok: true, results: [], error: last };
}

/* ───────────── server ───────────── */
const server = http.createServer(async (req, res) => {
  try {
    const target = decodeHost(req.headers.host);
    if (target) return await handleProxy(req, res, target);

    // ── shell mode ──
    const u = new URL(req.url, 'http://localhost');
    const baseHeaders = { 'access-control-allow-origin': '*', 'access-control-allow-private-network': 'true' };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({
        'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': '*', 'access-control-max-age': '86400'
      }, baseHeaders));
      return res.end();
    }

    if (u.pathname === '/__archive/ping') {
      const m = String(req.headers.host || '').match(/:(\d+)$/);
      const port = m ? parseInt(m[1], 10) : (PUBLIC_SCHEME === 'https' ? 443 : 80);
      res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, baseHeaders));
      return res.end(JSON.stringify({ ok: true, name: 'ARCHIVE_OS_PROXY', domain: PROXY_DOMAIN, port, scheme: PUBLIC_SCHEME }));
    }

    if (u.pathname === '/__archive/search') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 300);
      const type = u.searchParams.get('type') || 'web';
      const data = q ? await runSearch(type, q) : { ok: true, results: [] };
      res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, baseHeaders));
      return res.end(JSON.stringify(data));
    }

    if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/archive_os_browser.html') {
      fs.readFile(HTML_FILE, (err, buf) => {
        if (err) return sendErr(res, 500, 'MISSING_FILE', 'Put archive_os_browser.html next to server.js');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(buf);
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('NOT_FOUND');
  } catch (e) {
    if (!res.headersSent) sendErr(res, 500, 'SERVER_ERROR', String(e && e.message || e));
    else res.destroy();
  }
});

server.on('clientError', (e, sock) => { try { sock.destroy(); } catch (x) {} });
process.on('unhandledRejection', e => console.error('[unhandled]', e && e.message || e));

server.listen(PORT, () => {
  console.log('');
  console.log('  ARCHIVE_OS // PROXY SERVER ONLINE');
  console.log('  ─────────────────────────────────');
  console.log('  Open  ->  http://localhost:' + PORT);
  console.log('  Sites ->  http://<site>.s.' + PROXY_DOMAIN + ':' + PORT);
  console.log('');
});
