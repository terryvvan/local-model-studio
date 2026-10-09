/* app/doc/text.js —— 「文本型文档」的读取工具集
 *
 * 覆盖三类真实需求：
 *  1. 编码：Windows 上导出的 txt/csv 十有八九是 GBK（或 UTF-16LE+BOM），直接按 UTF-8 读会
 *     得到一片「锟斤拷」。这里的 decodeBytes 按 BOM → UTF-8 严格校验 → GBK → latin1 逐级退让，
 *     并顺手判定「这其实是二进制文件」。
 *  2. 结构：HTML 要能出正文（保标题/列表/表格），CSV/TSV 要能出整齐的表格文本，RTF 要能
 *     剥离控制字（含 \uNNNN 与 \'hh 两种中文写法）。
 *  3. 编码嗅探：给 dispatcher 用（PDF 头、PK 头、OLE 头、BOM…）。
 */
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/* ------------------------------------------------------------ 编码判定 */
/**
 * 把一段字节解成文本，尽量不猜错。
 * @returns {{text:string, encoding:string, binary:boolean}}
 */
function decodeBytes(buf) {
  if (!buf || !buf.length) return { text: '', encoding: 'empty', binary: false };
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom', binary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le', binary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be', binary: false };
  }
  const head = buf.subarray(0, Math.min(buf.length, 65536));
  let ctrl = 0;
  for (const b of head) {
    if (b === 0) return { text: '', encoding: 'binary', binary: true };
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  if (ctrl / head.length > 0.05) return { text: '', encoding: 'binary', binary: true };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8', binary: false };
  } catch (_) { /* 不是合法 UTF-8，继续往下试 */ }
  try {
    const t = new TextDecoder('gbk').decode(buf);
    return { text: t, encoding: 'gbk', binary: false };
  } catch (_) {}
  return { text: buf.toString('latin1'), encoding: 'latin1', binary: false };
}

/** 按扩展名 + 魔数判断这是什么文件。返回值见 index.js 的 kindOf。 */
function sniff(name, buf) {
  const ext = String(name || '').toLowerCase().replace(/^.*\./, '');
  const b = buf || Buffer.alloc(0);
  const head = b.subarray(0, 8);
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (b.length >= 4 && b.toString('latin1', 0, 4) === '{\\rtf') return 'rtf';
  if (b.length >= 8 && head.equals(OLE_MAGIC)) {
    if (ext === 'xls' || ext === 'doc' || ext === 'ppt') return 'ole-' + ext;
    return 'ole';
  }
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) {
    const e = ext === 'docx' || ext === 'docm' ? 'docx'
      : ext === 'xlsx' || ext === 'xlsm' ? 'xlsx'
        : ext === 'pptx' || ext === 'pptm' ? 'pptx' : '';
    return e ? 'zip-' + e : 'zip';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image';
  if (b.length >= 8 && b.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'image';
  return 'text';
}

/* ------------------------------------------------------------ HTML */
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·',
  times: '×', divide: '÷', deg: '°', plusmn: '±', laquo: '«', raquo: '»', bull: '•', sect: '§',
  para: '¶', euro: '€', pound: '£', yen: '¥', cent: '¢', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', micro: 'µ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ',
  pi: 'π', sigma: 'σ', omega: 'ω', Omega: 'Ω', le: '≤', ge: '≥', ne: '≠', infin: '∞',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔', check: '✓', cross: '✗', prime: '′',
};
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === '#') {
      const cp = (ent[1] === 'x' || ent[1] === 'X') ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return (cp > 0 && cp <= 0x10ffff) ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED[ent] !== undefined ? NAMED[ent] : NAMED[ent.toLowerCase()];
    return v !== undefined ? v : m;
  });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** HTML → 正文。保留标题层级、列表符号、表格竖线，其余标签丢掉。 */
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|head|iframe|template)[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<h([1-6])[^>]*>/gi, (m, n) => '\n\n' + '#'.repeat(+n) + ' ');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(td|th)\s*>/gi, ' | ');
  s = s.replace(/<\/tr\s*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<hr\s*\/?>/gi, '\n---\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|ul|ol|table|blockquote|pre|section|article|header|footer|dd|dt|figure)\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  return s.replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? decodeEntities(m[1]).trim() : '';
}

/* ------------------------------------------------------------ CSV / TSV */
/** RFC4180 风格解析；不给分隔符时按前几行的出现次数投票（逗号/制表/分号/竖线）。 */
function parseDelimited(text, delim) {
  const t = String(text || '').replace(/^\uFEFF/, '');
  if (!delim) {
    const sample = t.split(/\r?\n/).slice(0, 5).join('\n');
    const score = [',', '\t', ';', '|'].map((d) => [d, sample.split(d).length - 1]);
    score.sort((a, b) => b[1] - a[1]);
    delim = score[0][1] > 0 ? score[0][0] : ',';
  }
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((x) => String(x).trim() === '')) rows.pop();
  return rows;
}
/** 二维表 → 文本（给模型看的形式，不是给人看的对齐表）。 */
function rowsToText(rows, opts) {
  opts = opts || {};
  const maxRows = opts.maxRows || 2000, maxCols = opts.maxCols || 60;
  const out = [];
  for (const r of (rows || []).slice(0, maxRows)) {
    const cells = (r || []).slice(0, maxCols).map((c) => String(c == null ? '' : c).replace(/[\r\n\t]+/g, ' ').trim());
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    out.push(cells.join(' | '));
  }
  return out.join('\n');
}

/* ------------------------------------------------------------ RTF */
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata',
  'colorschememapping', 'latentstyles', 'datastore', 'generator', 'listtable', 'listoverridetable',
  'rsidtbl', 'xmlnstbl', 'filetbl', 'revtbl', 'falt', 'panose', 'fcharset', 'fbidi']);
/**
 * RTF → 正文。\'hh 是「按当前代码页的字节」、\uNNNN 是真 Unicode，中文 RTF 两种都会出现，
 * 所以这里把字节片段单独攒起来、最后按 GBK 解码，别把两种混成一根字符串。
 */
function rtfToText(rtf) {
  const src = String(rtf || '');
  const out = [];                                     // {b:true, v:byte} | {s:true, v:string}
  const stack = [{ ign: false }];
  let ignored = 0;
  const pushText = (s) => { if (s) out.push({ s: true, v: s }); };
  const pushByte = (b) => out.push({ b: true, v: b });
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (c === '{') { stack.push({ ign: top.ign }); i++; continue; }
    if (c === '}') { if (stack.length > 1) stack.pop(); i++; continue; }
    if (c === '\\') {
      const w = /^\\([a-zA-Z]+)(-?\d+)?[ ]?/.exec(src.slice(i));
      if (w) {
        const word = w[1].toLowerCase();
        const arg = w[2] !== undefined ? parseInt(w[2], 10) : null;
        i += w[0].length;
        if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') pushText('\n');
        else if (word === 'tab') pushText('\t');
        else if (word === 'u' && arg !== null) {
          pushText(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
          if (src[i] === '?') i++;                    // 老工具会跟一个替代字符
        } else if (RTF_SKIP.has(word) || word === 'fonttbl') top.ign = true;
        continue;
      }
      const sym = /^\\(.)/.exec(src.slice(i));
      if (sym) {
        const ch = sym[1];
        i += 2;
        if (ch === "'") {
          const code = parseInt(src.substr(i, 2), 16);
          i += 2;
          if (!isNaN(code)) pushByte(code);
        } else if (ch === '*') top.ign = true;
        else if (ch === '{' || ch === '}' || ch === '\\') pushText(ch);
        else if (ch === '~') pushText('\u00a0');
        else if (ch === '-') pushText('\u00ad');
        continue;
      }
      i++; continue;
    }
    if (!top.ign) pushText(c);
    i++;
  }
  /* 相邻字节片段按 GBK 解码（中文 RTF 的 \'hh 就是 GBK 字节） */
  let res = '', run = [];
  const flush = () => {
    if (!run.length) return;
    const b = Buffer.from(run);
    run = [];
    let t;
    try { t = new TextDecoder('gbk').decode(b); } catch (_) { t = b.toString('latin1'); }
    res += t;
  };
  for (const p of out) {
    if (p.b) run.push(p.v);
    else { flush(); res += p.v; }
  }
  flush();
  ignored = stack.length;
  return res.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  OLE_MAGIC, decodeBytes, sniff, decodeEntities, escapeHtml, htmlToText, htmlTitle,
  parseDelimited, rowsToText, rtfToText,
};
