'use strict';
/* ========================= 成熟开源库：读 Office =========================
 * 手写解析器（./ooxml）留着当兜底，这里用两个主流库补强：
 *   · mammoth  —— .docx → HTML（表格/列表/编号/脚注都照原文来）
 *   · exceljs  —— .xlsx → 单元格值（真日期、公式缓存值、合并单元格）
 * 两个库都是异步 API，所以 doc/index.js 的 extractBuffer / extractPath 也是 async。
 * 库没装（没人跑 npm install）不是致命错误：dep() 抛 code='ENOLIB'，
 * 调用方（extractBuffer）捕获后退回手写实现，界面照旧能用。
 * ------------------------------------------------------------------------ */

function dep(name) {
  try { return require(name); }
  catch (e) {
    const err = new Error('缺少依赖 ' + name + '（在项目目录执行 npm install 即可）：' + ((e && e.message) || e));
    err.code = 'ENOLIB';
    throw err;
  }
}
/** 只探测有没有装，不加载（界面/接口用它说明「增强解析可用吗」）。 */
function libsOk() {
  const o = {};
  for (const n of ['mammoth', 'exceljs']) {
    try { require.resolve(n); o[n] = true; } catch (_) { o[n] = false; }
  }
  return o;
}

/* ------------------------------- .docx ---------------------------------- */
async function docxToHtml(buf) {
  const mammoth = dep('mammoth');
  const r = await mammoth.convertToHtml({ buffer: buf }, {
    ignoreEmptyParagraphs: true,
    /* 图片不要转成 data: URI 塞进 HTML —— 正文用不上，还会把内存撑爆 */
    convertImage: mammoth.images.imgElement(() => ({ src: '' })),
  });
  let html = String((r && r.value) || '');
  html = html.replace(/<img[^>]*>/gi, '').replace(/src="data:[^"]*"/gi, '');
  return { html, messages: ((r && r.messages) || []).map(m => String((m && m.message) || '')) };
}

/* ------------------------------- .xlsx ---------------------------------- */
const XLSX_MAX_ROWS = 5000;
const XLSX_MAX_COLS = 200;
function colToNum(s) { let n = 0; for (const ch of String(s)) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function splitRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref || '').toUpperCase());
  return m ? { c: colToNum(m[1]), r: parseInt(m[2], 10) } : null;
}
function cellToText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    const d = v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
    const t = p(v.getHours()) + ':' + p(v.getMinutes());
    return t === '00:00' ? d : d + ' ' + t;
  }
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number' || t === 'boolean') return String(v);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(x => String((x && x.text) || '')).join('');
    if (v.text !== undefined && (v.hyperlink !== undefined || v.richText === undefined)) return String(v.text);
    if (v.formula !== undefined || v.sharedFormula !== undefined) return cellToText(v.result);
    if (v.error !== undefined) return '';
  }
  return String(v);
}
async function xlsxSheets(buf) {
  const ExcelJS = dep('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheets = [];
  for (const ws of wb.worksheets) {
    const grid = [];
    ws.eachRow({ includeEmpty: true }, (row, rn) => {
      if (rn > XLSX_MAX_ROWS) return;
      const arr = [];
      row.eachCell({ includeEmpty: true }, (cell, cn) => {
        if (cn > XLSX_MAX_COLS) return;
        arr[cn - 1] = cellToText(cell.value);
      });
      grid[rn - 1] = arr;
    });
    /* 合并单元格：纵向合并把左上角的值往下铺满（「这几行属于同一项」的信息手写版丢了）；
     * 横向合并不铺 —— 一个跨 4 列的标题铺出来就是「标题 | 标题 | 标题 | 标题」，纯噪声。 */
    let merges = 0;
    for (const range of (ws.model && ws.model.merges) || []) {
      const [a, b] = String(range).split(':');
      const p = splitRef(a), q = splitRef(b || a);
      if (!p || !q) continue;
      merges++;
      if (q.r <= p.r) continue;                        // 横向合并：不动
      const v = grid[p.r - 1] ? grid[p.r - 1][p.c - 1] : '';
      if (v === '' || v === undefined) continue;
      for (let r = p.r; r <= Math.min(q.r, XLSX_MAX_ROWS); r++) {
        if (!grid[r - 1]) grid[r - 1] = [];
        for (let c = p.c; c <= Math.min(q.c, XLSX_MAX_COLS); c++) if (!grid[r - 1][c - 1]) grid[r - 1][c - 1] = v;
      }
    }
    const rows = [];
    for (let i = 0; i < grid.length; i++) {
      const r = grid[i] || [];
      if (r.some(x => String(x === undefined || x === null ? '' : x).trim() !== '')) {
        while (r.length && String(r[r.length - 1] === undefined || r[r.length - 1] === null ? '' : r[r.length - 1]).trim() === '') r.pop();
        rows.push(r.map(x => (x === undefined || x === null ? '' : x)));
      } else rows.push([]);
    }
    sheets.push({ name: ws.name, rows, merges, cols: rows.reduce((a, r) => Math.max(a, r.length), 0) });
  }
  return sheets;
}

module.exports = { libsOk, docxToHtml, xlsxSheets, dep };
