/* app/doc/index.js —— 文档读写总入口
 *
 * 对上层（server.js）只暴露四件事：
 *   kindOf / isDocName / isImageName   —— 这文件是什么、能不能当文档收
 *   extractPath(filePath, opts)        —— 抽出可喂给模型的纯文本（带缓存）
 *   writeDocument(filePath, content, opts) —— 把模型产出的内容落成 md/txt/csv/json/html/docx/xlsx/pdf
 *   formatNote(result)                 —— 生成给模型看的一行「文档说明」
 *
 * 支持的读：pdf / docx / xlsx / pptx / rtf / html / csv / tsv / json / 各类纯文本与代码；
 *           旧版 doc/xls（OLE 二进制）走 Office COM 转一次再读。
 * 支持的写：md / txt / csv / tsv / json / html / docx / xlsx / pdf（PDF 由 Edge 无头打印）。
 */
const fs = require('fs');
const path = require('path');
const text = require('./text');
const md = require('./markdown');

/* 本模块只在「旧版 .doc/.xls 走 Office COM 转一次」时用到 PowerShell：
 * 优先 PowerShell 7（pwsh.exe，2026-10-09 装的 7.6.6）、找不到才回落 Windows PowerShell 5.1。
 * COM（Word/Excel.Application）在两者上都可用；7 只是启动更快、编码更省心。 */
function pwshExe() {
  const cands = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')];
  for (const d of String(process.env.PATH || '').split(';')) {
    const t = d.trim().replace(/^"|"$/g, '');
    if (t) cands.push(path.join(t, 'pwsh.exe'));
  }
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch (_) { /* 下一个 */ } }
  return 'powershell.exe';
}

/* ------------------------------------------------------------ 类型判定 */
const EXT = {
  pdf: 'pdf',
  docx: 'docx', docm: 'docx', dotx: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx',
  pptx: 'pptx', pptm: 'pptx',
  rtf: 'rtf',
  html: 'html', htm: 'html', xhtml: 'html',
  csv: 'csv', tsv: 'csv', tab: 'csv',
  json: 'json', jsonl: 'json', ndjson: 'json',
  txt: 'text', md: 'text', markdown: 'text', log: 'text', ini: 'text', cfg: 'text', conf: 'text',
  yaml: 'text', yml: 'text', toml: 'text', srt: 'text', vtt: 'text', tex: 'text',
  xml: 'text', svg: 'text', sql: 'text', sh: 'text', ps1: 'text', bat: 'text', cmd: 'text',
  js: 'text', mjs: 'text', cjs: 'text', ts: 'text', jsx: 'text', tsx: 'text', vue: 'text',
  py: 'text', java: 'text', c: 'text', h: 'text', cpp: 'text', hpp: 'text', cs: 'text',
  go: 'text', rs: 'text', rb: 'text', php: 'text', css: 'text', scss: 'text', less: 'text',
  doc: 'ole', xls: 'ole', ppt: 'ole',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
};
const WRITABLE = new Set(['md', 'markdown', 'txt', 'text', 'log', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml', 'docx', 'xlsx', 'pdf']);

function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
}
function kindOf(name, buf) {
  const e = extOf(name);
  if (e && EXT[e]) return EXT[e];
  if (buf) {
    const s = text.sniff(name, buf);
    if (s === 'pdf') return 'pdf';
    if (s === 'rtf') return 'rtf';
    if (s === 'image') return 'image';
    if (s === 'zip-docx') return 'docx';
    if (s === 'zip-xlsx') return 'xlsx';
    if (s === 'zip-pptx') return 'pptx';
    if (s === 'zip') return 'zip';
    if (s.startsWith('ole')) return 'ole';
    return 'text';
  }
  return 'unknown';
}
/** 能不能当「文档」收（图片另走识图通道）。 */
function isDocName(name) {
  const e = extOf(name);
  if (!e) return true;                                  // 没扩展名：当文本试一把
  if (EXT[e]) return EXT[e] !== 'image';
  return true;                                          // 未知扩展名也收，读的时候再判
}
function isImageName(name) {
  const e = extOf(name);
  if (EXT[e] === 'image') return true;
  return /^(png|jpe?g|gif|webp|bmp|tiff?|ico|heic)$/.test(e);
}

/* ------------------------------------------------------------ 读 */
const MAX_TEXT = 2000000;                              // 单份文档抽出来的文本上限（字符）

function readJson(t) {
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch (_) { return t; }
}
function looksLikeHtml(s) { return /^\s*(<!doctype|<html|<body|<div|<p[ >]|<table|<h[1-6][ >])/i.test(String(s || '')); }

function extractBuffer(buf, name, opts) {
  return _extractBuffer(buf, name, opts);
}
async function _extractBuffer(buf, name, opts) {
  opts = opts || {};
  const kind = kindOf(name, buf);
  const bytes = buf ? buf.length : 0;
  const base = { kind, bytes, text: '', meta: {}, note: '' };
  try {
    if (kind === 'pdf') {
      const r = require('./pdf').extractPdfText(buf, opts);
      base.text = r.text || '';
      base.meta = r.meta || {};
      base.pages = r.pages || null;
      if (r.meta && r.meta.encrypted) base.note = '这份 PDF 有加密（/Encrypt），无法读取正文。';
      else if (r.meta && r.meta.scanned) base.note = '这份 PDF 里几乎没有文字层，很可能是扫描件（图片）；让本机视觉模型读它（不是 OCR）。';
      else if (r.meta && r.meta.warn) base.note = r.meta.warn;
      return base;
    }
    if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
      const oo = require('./ooxml');
      /* 先试成熟库（mammoth / exceljs），装了就用它；没装或它自己报错就退回手写解析。
       * 两份结果都留着，好对比 —— 出问题时 byLib 字段会说明用的是哪条路。 */
      if (kind === 'docx') {
        try {
          const lib = require('./libdoc');
          const h = await lib.docxToHtml(buf);
          const t = text.htmlToText(h.html);
          if (String(t || '').trim()) {
            base.text = t;
            base.meta = { byLib: 'mammoth', html: h.html.length, messages: h.messages.length };
            base.paragraphs = null;
            return base;
          }
        } catch (e) { if (e && e.code !== 'ENOLIB') base.meta.libError = String((e && e.message) || e); }
      }
      if (kind === 'xlsx') {
        try {
          const lib = require('./libdoc');
          const sheets = await lib.xlsxSheets(buf);
          if (sheets.length) {
            const L = [];
            for (const sh of sheets) {
              L.push('### 工作表：' + (sh.name || ''));
              L.push(text.rowsToText(sh.rows));
              L.push('');
            }
            base.text = L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
            base.sheets = sheets.map(sh => ({ name: sh.name, rows: sh.rows, merges: sh.merges, cols: sh.cols }));
            base.meta = { byLib: 'exceljs', sheets: sheets.length };
            return base;
          }
        } catch (e) { if (e && e.code !== 'ENOLIB') base.meta.libError = String((e && e.message) || e); }
      }
      const r = kind === 'docx' ? oo.readDocx(buf) : kind === 'xlsx' ? oo.readXlsx(buf, opts) : oo.readPptx(buf);
      base.text = r.text || '';
      base.meta = Object.assign({ byLib: 'builtin' }, r.meta || {});
      if (kind === 'xlsx') base.sheets = r.sheets || null;
      if (kind === 'pptx') base.slides = r.slides || null;
      if (kind === 'docx') base.paragraphs = r.paragraphs || null;
      return base;
    }
    if (kind === 'rtf') { base.text = text.rtfToText(buf.toString('latin1')); return base; }
    if (kind === 'html') {
      const s = text.decodeBytes(buf).text;
      base.meta.title = text.htmlTitle(s);
      base.text = text.htmlToText(s);
      return base;
    }
    if (kind === 'csv') {
      const s = text.decodeBytes(buf).text;
      const rows = text.parseDelimited(s, /\t|\.tab$/.test(name) ? '\t' : undefined);
      base.meta.rows = rows.length;
      base.meta.cols = rows.reduce((a, r) => Math.max(a, r.length), 0);
      base.text = text.rowsToText(rows);
      return base;
    }
    if (kind === 'json') {
      const d = text.decodeBytes(buf);
      base.text = readJson(d.text);
      base.meta.encoding = d.encoding;
      return base;
    }
    if (kind === 'image') {
      /* 顺手把真实像素尺寸读出来（只读文件头）。模型要「按原图尺寸」时用它，
       * 不要再让模型自己去解析 JPEG 字节 —— 那玩意儿它算错过。 */
      const sz = require('./imageinfo').sizeOf(buf);
      if (sz) { base.meta.width = sz.width; base.meta.height = sz.height; base.meta.format = sz.format; }
      base.note = '这是图片，走识图通道（不是文档）。';
      return base;
    }
    if (kind === 'ole') {
      base.note = '这是旧版 Office 二进制格式（.doc/.xls/.ppt），需要先转换。';
      return base;
    }
    if (kind === 'zip') {
      const { unzip } = require('./zip');
      const m = unzip(buf);
      const names = [...m.keys()];
      base.text = '压缩包条目（' + names.length + ' 个）：\n' + names.slice(0, 200).join('\n');
      base.meta.entries = names.length;
      return base;
    }
    /* 其余按纯文本读，编码交给 decodeBytes 猜 */
    const d = text.decodeBytes(buf);
    if (d.binary) {
      base.kind = 'binary';
      base.note = '这是一个二进制文件（' + (extOf(name) || '无扩展名') + '），读不出文本。';
      return base;
    }
    base.meta.encoding = d.encoding;
    base.text = d.text;
    return base;
  } finally {
    if (base.text && base.text.length > MAX_TEXT) {
      base.truncatedFrom = base.text.length;
      base.text = base.text.slice(0, MAX_TEXT);
      base.note = (base.note ? base.note + ' ' : '') + '文本过长，只取了前 ' + MAX_TEXT + ' 字符。';
    }
  }
}

/* 旧版 .doc/.xls：借本机 Office 转成 OOXML 再读（转出来的文件留在临时目录，只转一次） */
function convertLegacy(filePath, kind, opts) {
  const { spawnSync } = require('child_process');
  const e = extOf(filePath);
  if (kind === 'ole' && e !== 'doc' && e !== 'xls') return null;
  const outExt = e === 'xls' ? '.xlsx' : '.docx';
  const cacheDir = path.join(require('os').tmpdir(), 'lm-doc-convert');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
  const out = path.join(cacheDir, path.basename(filePath).replace(/\.[^.]+$/, '') + outExt);
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(filePath).mtimeMs) return out;
  const q = (p) => String(p).replace(/'/g, "''");
  const script = e === 'xls'
    ? "$ErrorActionPreference='Stop';$x=New-Object -ComObject Excel.Application;$x.Visible=$false;$x.DisplayAlerts=$false;"
      + "$wb=$x.Workbooks.Open('" + q(filePath) + "',$false,$true);$wb.SaveAs('" + q(out) + "',51);$wb.Close($false);$x.Quit()"
    : "$ErrorActionPreference='Stop';$w=New-Object -ComObject Word.Application;$w.Visible=$false;$w.DisplayAlerts=0;"
      + "$d=$w.Documents.Open('" + q(filePath) + "',$false,$true);$d.SaveAs2('" + q(out) + "',16);$d.Close(0);$w.Quit()";
  const r = spawnSync(pwshExe(), ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: (opts && opts.convertTimeout) || 90000, windowsHide: true, encoding: 'utf8' });
  if (fs.existsSync(out)) return out;
  const msg = ((r.stderr || '') + (r.stdout || '')).trim().slice(0, 300);
  throw new Error('这个 ' + e + ' 是旧版二进制格式，需要本机 Office 转换，但转换失败：' + (msg || '未知原因'));
}

const _cache = new Map();                             // path|mtime|size → result
/** 异步：.docx/.xlsx 走 mammoth / exceljs（都是异步 API）。 */
async function extractPath(filePath, opts) {
  opts = opts || {};
  const abs = path.resolve(filePath);
  const st = fs.statSync(abs);
  const key = abs + '|' + st.mtimeMs + '|' + st.size;
  if (!opts.force && _cache.has(key)) return _cache.get(key);
  let buf = fs.readFileSync(abs);
  let kind = kindOf(path.basename(abs), buf);
  if (kind === 'ole') {
    const conv = convertLegacy(abs, kind, opts);
    buf = fs.readFileSync(conv);
    kind = kindOf(conv, buf);
    const r = await extractBuffer(buf, path.basename(conv), opts);
    r.convertedFrom = abs;
    r.sourcePath = abs;
    r.path = abs;
    _cache.set(key, r);
    return r;
  }
  const r = await extractBuffer(buf, path.basename(abs), opts);
  r.path = abs;
  if (_cache.size > 40) _cache.clear();                // 桌面应用，缓存小一点无所谓
  _cache.set(key, r);
  return r;
}
function clearCache() { _cache.clear(); }

/* ------------------------------------------------------------ 写 */
/**
 * 把内容写成文档。返回 Promise（PDF 分支要走 Edge，是异步的）。
 * @param {string} filePath 目标路径（扩展名决定格式）
 * @param {string} content 文本内容（md / csv / html / 纯文本，取决于目标格式）
 * @param {{title?:string, sheets?:{name:string,rows:any[][][]}, sheetName?:string, fontSize?:number}} [opts]
 */
async function writeDocument(filePath, content, opts) {
  opts = opts || {};
  const abs = path.resolve(filePath);
  const e = extOf(abs);
  const body = content == null ? '' : String(content);
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) {}
  const done = (kind, note) => ({ ok: true, kind, bytes: fs.statSync(abs).size, path: abs, note: note || '' });

  if (e === 'docx') {
    const { writeDocx } = require('./ooxml');
    const blocks = md.mdToBlocks(body);
    const buf = writeDocx({ title: opts.title || path.basename(abs, '.docx'), blocks });
    fs.writeFileSync(abs, buf);
    return done('docx', '已生成 Word 文档（' + blocks.length + ' 个段落块）');
  }
  if (e === 'xlsx') {
    const { writeXlsx } = require('./ooxml');
    let sheets;
    if (Array.isArray(opts.sheets) && opts.sheets.length) sheets = opts.sheets;
    else sheets = [{ name: opts.sheetName || 'Sheet1', rows: md.dataToRows(body) }];
    const buf = writeXlsx({ sheets });
    fs.writeFileSync(abs, buf);
    const n = sheets.reduce((a, s) => a + (s.rows || []).length, 0);
    return done('xlsx', '已生成 Excel（' + sheets.length + ' 个工作表 / ' + n + ' 行）');
  }
  if (e === 'pdf') {
    const { printHtmlToPdf } = require('./pdfout');
    const html = looksLikeHtml(body) ? body : md.htmlDocument(opts.title || path.basename(abs, '.pdf'), md.mdToHtml(body), opts);
    const r = await printHtmlToPdf(html, abs, opts);
    return { ok: true, kind: 'pdf', bytes: r.bytes, path: abs, note: '已用本机浏览器打印成 PDF' };
  }
  if (e === 'html' || e === 'htm') {
    const html = looksLikeHtml(body) ? body : md.htmlDocument(opts.title || path.basename(abs, path.extname(abs)), md.mdToHtml(body), opts);
    fs.writeFileSync(abs, html, 'utf8');
    return done('html');
  }
  if (e === 'json' || e === 'jsonl') {
    fs.writeFileSync(abs, body, 'utf8');
    return done('json');
  }
  fs.writeFileSync(abs, body, 'utf8');                 // md/txt/csv/其它一律当文本写
  return done(WRITABLE.has(e) ? e : 'text');
}
function canWrite(name) { return WRITABLE.has(extOf(name)); }

/* ------------------------------------------------------------ 给模型的一句话说明 */
function formatNote(r) {
  const bits = [];
  const kindName = { pdf: 'PDF', docx: 'Word 文档', xlsx: 'Excel 表格', pptx: 'PPT', rtf: 'RTF', html: 'HTML', csv: '表格文本', json: 'JSON', text: '文本', image: '图片', binary: '二进制文件', zip: '压缩包', ole: '旧版 Office 文件' }[r.kind] || r.kind;
  bits.push(kindName);
  if (r.meta && r.meta.width && r.meta.height) bits.push(r.meta.width + '×' + r.meta.height + ' 像素');
  if (r.pages && r.pages.length) bits.push(r.pages.length + ' 页');
  if (r.sheets && r.sheets.length) bits.push(r.sheets.length + ' 个工作表');
  if (r.slides && r.slides.length) bits.push(r.slides.length + ' 张幻灯片');
  if (r.meta && r.meta.rows) bits.push(r.meta.rows + ' 行');
  bits.push(r.text ? r.text.length + ' 字' : '没抽到文字');
  return bits.join(' · ');
}

module.exports = {
  kindOf, isDocName, isImageName, extOf, extractBuffer, extractPath, clearCache,
  writeDocument, canWrite, formatNote, looksLikeHtml, MAX_TEXT,
  sizeOf: require('./imageinfo').sizeOf, sizeOfFile: require('./imageinfo').sizeOfFile,
  /* 给 server.js 复用的底层工具（读文本文件时按 BOM/GBK 猜编码等） */
  decodeBytes: text.decodeBytes, sniff: text.sniff, rowsToText: text.rowsToText,
  mdToBlocks: md.mdToBlocks, mdToHtml: md.mdToHtml, htmlDocument: md.htmlDocument,
};
