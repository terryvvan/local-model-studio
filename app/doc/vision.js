'use strict';
/* ============================ 本地视觉模型识图 ============================
 * 「图片 / 扫描件 PDF / 文字层坏掉的 PDF」不再只丢一句「需要 OCR」，而是：
 *   1. 图片用 @napi-rs/canvas 解码，按最长边缩到 imageMaxEdge（默认 1280）；
 *   2. PDF 用 pdfjs-dist 把指定页渲染成 PNG（不依赖浏览器，也不用装 PDF 阅读器）；
 *   3. 把 PNG 以 data URL 塞进 llama.cpp 的 /v1/chat/completions（OpenAI 多模态格式），
 *      交给本机带视觉塔（mmproj）的模型逐页转写。
 *
 * 两个实测踩过的点，改代码时别动：
 *   · 请求必须带 chat_template_kwargs:{enable_thinking:false} —— 不带的话思考会把
 *     正文吃光，content 直接是空的（实测 gen=700 全是 reasoning）。
 *   · pdfjs 的 cMapUrl / standardFontDataUrl / wasmUrl 必须是**正斜杠且以 / 结尾**，
 *     否则报 `Invalid factory url: "…" must include trailing slash.`
 *
 * 依赖懒加载：node_modules 不存在时只抛错、不影响程序其它功能（有手写解析兜底）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROMPT_PAGE = '请把这一页的全部文字逐字转写出来：保留标题层级、段落顺序、编号与表格结构（表格用 Markdown 表格）。只输出内容本身，不要写任何解释、前言或客套话。如果这页主要是图，就用中文描述图里的关键信息。';
const PROMPT_IMAGE = '请把这张图片里的文字逐字转写出来：保留版面结构（标题、列表、表格用 Markdown 表格）。只输出内容本身，不要解释。如果图里几乎没有文字，就用中文描述画面内容。';

/* --------------------------------- 依赖 -------------------------------- */
function dep(name) {
  try { return require(name); }
  catch (e) {
    const err = new Error('缺少依赖 ' + name + '（在项目目录执行 npm install 即可）：' + (e && e.message));
    err.code = 'ENOLIB';
    throw err;
  }
}
function libsOk() {
  try { require.resolve('@napi-rs/canvas'); require.resolve('pdfjs-dist/package.json'); return true; }
  catch (_) { return false; }
}

let _pdfjs = null;
async function pdfjs() {
  if (_pdfjs) return _pdfjs;
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const fwd = p => p.replace(/\\/g, '/').replace(/\/*$/, '/');
  _pdfjs = {
    mod,
    assets: {
      cMapUrl: fwd(path.join(root, 'cmaps')),
      standardFontDataUrl: fwd(path.join(root, 'standard_fonts')),
      wasmUrl: fwd(path.join(root, 'wasm')),
    },
  };
  return _pdfjs;
}

/* ------------------------------- PDF 渲染 ------------------------------- */
function num(v, d, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; }

/** PDF 页数（不渲染，只开文档读 numPages）。 */
async function pdfPageCount(absPath) {
  const { mod, assets } = await pdfjs();
  const task = mod.getDocument(Object.assign({ data: new Uint8Array(fs.readFileSync(absPath)), isEvalSupported: false, useSystemFonts: true }, assets));
  const doc = await task.promise;
  try { return doc.numPages; } finally { try { await task.destroy(); } catch (_) {} }
}

/**
 * 把 PDF 的第 first..first+maxPages-1 页渲染成 PNG。
 * @returns {{pages:{page:number,total:number,png:Buffer,width:number,height:number}[], total:number}}
 */
async function renderPdfPages(absPath, opts) {
  opts = opts || {};
  const maxEdge = num(opts.maxEdge, 1280, 320, 2400);
  const first = Math.round(num(opts.first, 1, 1, 100000));
  const maxPages = Math.round(num(opts.maxPages, 3, 1, 20));
  const { mod, assets } = await pdfjs();
  const { createCanvas } = dep('@napi-rs/canvas');
  const task = mod.getDocument(Object.assign({ data: new Uint8Array(fs.readFileSync(absPath)), isEvalSupported: false, useSystemFonts: true }, assets));
  const doc = await task.promise;
  try {
    const total = doc.numPages;
    const last = Math.min(total, first + maxPages - 1);
    const out = [];
    for (let i = first; i <= last; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(0.3, Math.min(4, maxEdge / Math.max(base.width, base.height)));
      const vp = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      out.push({ page: i, total, png: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height });
      try { page.cleanup(); } catch (_) {}
    }
    return { pages: out, total };
  } finally { try { await task.destroy(); } catch (_) {} }
}

/** 图片文件 → 统一转成 PNG 并缩到最长边 maxEdge（mtmd 认 jpg/png，这里统一 PNG）。 */
async function loadImagePng(absPath, opts) {
  const maxEdge = num(opts && opts.maxEdge, 1280, 320, 2400);
  const { createCanvas, loadImage } = dep('@napi-rs/canvas');
  const img = await loadImage(fs.readFileSync(absPath));
  const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return { png: c.toBuffer('image/png'), width: w, height: h, from: { width: w0, height: h0 } };
}

/* ------------------------------ 引擎调用 -------------------------------- */
function postJson(port, p, body, timeoutMs) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 300) return reject(new Error('引擎返回 ' + res.statusCode + '：' + txt.slice(0, 300)));
        try { resolve(JSON.parse(txt)); } catch (e) { reject(new Error('引擎返回的不是 JSON：' + txt.slice(0, 200))); }
      });
    });
    req.setTimeout(timeoutMs || 180000, () => req.destroy(new Error('识图请求超时（' + Math.round((timeoutMs || 180000) / 1000) + ' 秒）')));
    req.on('error', reject);
    req.end(data);
  });
}

/** 一张或多张 PNG → 模型转写/描述。 */
async function vlmChat(cfg, opts) {
  cfg = cfg || {}; opts = opts || {};
  const port = Number(cfg.port) || 8110;
  const content = [{ type: 'text', text: String(opts.prompt || PROMPT_IMAGE) }];
  for (const png of (opts.images || [])) {
    if (!png || !png.length) continue;
    content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } });
  }
  const body = {
    messages: [{ role: 'user', content }],
    max_tokens: num(opts.maxTokens != null ? opts.maxTokens : cfg.maxTokens, 1600, 64, 8192),
    temperature: opts.temperature != null ? Number(opts.temperature) : 0.2,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },   // 不带的话正文会被思考吃光
  };
  const t0 = Date.now();
  const r = await postJson(port, '/v1/chat/completions', body, num(opts.timeoutMs != null ? opts.timeoutMs : cfg.timeoutMs, 180000, 5000, 900000));
  const ch = r && Array.isArray(r.choices) ? r.choices[0] : null;
  const text = String((ch && ch.message && ch.message.content) || '').trim();
  return { text, usage: (r && r.usage) || null, finish: (ch && ch.finish_reason) || '', ms: Date.now() - t0 };
}

/* ------------------------------- 对外识别 ------------------------------- */
const _cache = new Map();          // key → {text, pages, total, usage}
function cacheKey(absPath, opts) {
  let st = null; try { st = fs.statSync(absPath); } catch (_) {}
  return [absPath, st ? st.size : 0, st ? Math.round(st.mtimeMs) : 0, opts.first | 0, opts.maxPages | 0, opts.maxEdge | 0].join('|');
}
function clearCache() { _cache.clear(); }

/**
 * 识图入口：图片直接识别；PDF 逐页渲染后识别。
 * @param {object} cfg   {port, maxPages, maxEdge, maxTokens, timeoutMs}
 * @param {string} absPath
 * @param {object} opts  {kind:'image'|'pdf', first, maxPages, maxEdge, onProgress(info), noCache}
 * @returns {Promise<{text:string,pages:number,total:number,usage:object|null,ms:number,cached?:boolean,size?:{width:number,height:number},sent?:{width:number,height:number}}>}
 */
async function readDocument(cfg, absPath, opts) {
  cfg = cfg || {}; opts = opts || {};
  const kind = opts.kind === 'image' ? 'image' : 'pdf';
  const maxEdge = num(opts.maxEdge != null ? opts.maxEdge : cfg.maxEdge, 1280, 320, 2400);
  const first = Math.round(num(opts.first, 1, 1, 100000));
  const maxPages = Math.round(num(opts.maxPages != null ? opts.maxPages : cfg.maxPages, 4, 1, 20));
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const key = cacheKey(absPath, { first, maxPages, maxEdge });
  if (!opts.noCache && _cache.has(key)) return Object.assign({ cached: true }, _cache.get(key));
  const t0 = Date.now();
  const cfg2 = Object.assign({}, cfg, { maxEdge });

  if (kind === 'image') {
    const im = await loadImagePng(absPath, { maxEdge });
    if (onProgress) onProgress({ page: 1, total: 1, width: im.width, height: im.height });
    const r = await vlmChat(cfg2, { images: [im.png], prompt: opts.prompt || PROMPT_IMAGE });
    const out = {
      text: r.text, pages: 1, total: 1, usage: r.usage, ms: Date.now() - t0,
      size: { width: im.from.width, height: im.from.height },      // 原图真实像素尺寸
      sent: { width: im.width, height: im.height },                 // 实际喂给模型的（缩过）
    };
    if (_cache.size > 16) _cache.clear();
    _cache.set(key, out);
    return out;
  }

  const rp = await renderPdfPages(absPath, { first, maxPages, maxEdge });
  const parts = [];
  let usage = null;
  let n = 0;
  for (const p of rp.pages) {
    n++;
    if (onProgress) onProgress({ page: p.page, total: rp.total, index: n, count: rp.pages.length });
    const r = await vlmChat(cfg2, { images: [p.png], prompt: opts.prompt || PROMPT_PAGE, timeoutMs: cfg.timeoutMs });
    usage = r.usage || usage;
    parts.push('--- 第 ' + p.page + ' 页 ---\n' + (r.text || '（这一页没识别出内容）'));
  }
  const out = { text: parts.join('\n\n'), pages: rp.pages.length, total: rp.total, usage, ms: Date.now() - t0 };
  if (_cache.size > 16) _cache.clear();
  _cache.set(key, out);
  return out;
}

module.exports = {
  PROMPT_PAGE, PROMPT_IMAGE,
  libsOk, loadImagePng, renderPdfPages, pdfPageCount, vlmChat, readDocument, clearCache,
};
