/* app/doc/ooxml.js —— 零依赖 OOXML 读写（docx / xlsx / pptx）
 *
 * 只依赖同目录的 zip.js（node:zlib 实现），不引任何第三方包 —— 这个项目的服务器进程
 * 不允许出现 node_modules。
 *
 * 设计要点：
 *  - 读：一律走 zip.js 的 filter，只解压真正需要的 XML。docx 里 20 MB 的正文包其实
 *    只有几百 KB 的 document.xml，pptx 33 MB 里只有一堆几十 KB 的 slide XML；媒体
 *    一律不解压，这几条是「大文件也不卡」的关键。
 *  - 读：自己写了个极简 XML 事件扫描器（扫 '<'，不做 DOM）。OOXML 的标签是机器生成的、
 *    属性值里的 '>' 一定被转义，所以按 '>' 截断标签是安全的；这比正则套娃稳，也比
 *    引 DOM 便宜。所有解析器共用它。
 *  - 读：任何部件缺失/损坏都只记进 meta.warnings，绝不抛错（除 zip 本身解不开）。
 *  - 写：手写最小的合法包。元素顺序按 ECMA-376 的 sequence 排（pPr / rPr / tblPr /
 *    worksheet 的子元素顺序都很敏感，排错一个 Word 就会弹「需要修复」）。
 *
 * 已知取舍（都记录在 meta / 返回值里，或在此声明）：
 *  - docx 列表：bullet 一律渲染成 '- '；编号列表只有 numFmt=decimal 才渲染成 'N. '
 *    （其余 numFmt 如 lowerRoman / chineseCounting 退化成 '- '，不做花哨映射）。
 *    层级用每级两个空格缩进。
 *  - docx 表格：按 `<w:tc>` 逐个出，不做 gridSpan 展开（合并单元格只出现一次），
 *    单元格内多个段落用空格连接，行用 ' | ' 连接。表格里的段落不进 paragraphs[]。
 *  - xlsx 布尔单元格在 rows 里是 JS boolean，csv/text 里显示成 TRUE / FALSE。
 *  - xlsx 公式只取缓存值（<v>），不解析公式本身；共享公式、图表、图片、批注一律忽略。
 *  - xlsx 日期：内置 numFmtId 14–17 / 22、18–21 / 45–47 与自定义格式码含 y/m/d/h 的
 *    序列号会转成 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM' / 'HH:MM'；时间为 0 时只出日期。
 *  - pptx 表格里的文字与普通段落一样按行输出（不画 ' | '）；备注以 '[备注] ' 前缀附在
 *    该页文字后面。
 */
'use strict';
const { unzip, zip } = require('./zip');

/* ============================================================ 1. XML 小工具 */

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/* XML 1.0 不允许的控制字符：写出去 Word 会直接判定包损坏 */
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** 实体解码：5 个内置实体 + 数字实体（&#x4E2D; / &#20013;）+ OOXML 的 _xHHHH_ 转义 */
function decodeXml(s) {
  let t = String(s == null ? '' : s);
  if (t.indexOf('&') < 0 && t.indexOf('_x') < 0) return t;
  if (t.indexOf('_x') >= 0) {
    t = t.replace(/_x005F_(x[0-9A-Fa-f]{4}_)/g, '\u0001$1');           // _x005F_x0041_ = 字面量 _x0041_
    t = t.replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => {
      const cp = parseInt(h, 16);
      return (cp > 0 && cp <= 0x10ffff) ? String.fromCodePoint(cp) : m;
    });
    t = t.replace(/\u0001/g, '_');
  }
  if (t.indexOf('&') < 0) return t;
  return t.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return (cp > 0 && cp <= 0x10ffff) ? String.fromCodePoint(cp) : m;
    }
    const v = XML_ENT[e];
    return v === undefined ? m : v;
  });
}

/** 归一化换行 + 丢掉 XML 非法字符（写包前必过一道，否则 Office 弹修复） */
function cleanText(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(XML_BAD, '');
}
function escapeXml(s) {
  return cleanText(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
function escapeAttr(s) {
  return cleanText(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
/** 单元格文本：换行/制表用字符引用，Excel 才会在单元格内换行 */
function escapeCellText(s) {
  return escapeXml(s).replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

/** 标签名 → 本地名（丢掉 w: / a: / p: 前缀） */
function localName(raw) {
  const i = raw.indexOf(':');
  return i < 0 ? raw : raw.slice(i + 1);
}

const _reCache = new Map();
/** 取属性值：忽略命名空间前缀、吃掉属性名是别人后缀的情况（abstractNumId 不会命中 id） */
function attrOf(tag, name) {
  let re = _reCache.get(name);
  if (!re) {
    re = new RegExp('(?:^|[\\s])(?:[A-Za-z0-9_.-]+:)?' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')');
    _reCache.set(name, re);
  }
  const m = re.exec(tag);
  if (!m) return null;
  return decodeXml(m[1] !== undefined ? m[1] : m[2]);
}
/* 关系 Id 必须带命名空间前缀（r:id）——否则会误抓同一标签里的普通 id 属性 */
const RE_RELID = /(?:^|\s)[A-Za-z0-9_.-]+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/** 极简 XML 事件扫描器。handler: { open(local, tag, selfClose), close(local), text(str) } */
function scanXml(xml, h) {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { if (i < n) h.text(xml.slice(i)); break; }
    if (lt > i) h.text(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      h.text(xml.slice(lt + 9, e < 0 ? n : e));
      i = e < 0 ? n : e + 3; continue;
    }
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (xml.startsWith('<!', lt)) { const e = xml.indexOf('>', lt + 2); i = e < 0 ? n : e + 1; continue; }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    const raw = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (raw[0] === '/') { h.close(localName(raw.slice(1))); continue; }
    let inner = raw;
    let self = false;
    if (inner.charCodeAt(inner.length - 1) === 47) { self = true; inner = inner.slice(0, -1); }
    const sp = inner.search(/[\s/]/);
    h.open(localName(sp < 0 ? inner : inner.slice(0, sp)), '<' + raw + '>', self);
  }
}

/** 取某个本地名元素的文本（用于 docProps 这种小文件） */
function tagText(xml, local) {
  const re = new RegExp('<(?:[A-Za-z0-9_.-]+:)?' + local + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?' + local + '\\s*>');
  const m = re.exec(xml);
  return m ? decodeXml(m[1]).trim() : '';
}
function tagNum(xml, local) {
  const v = parseInt(tagText(xml, local), 10);
  return Number.isFinite(v) ? v : null;
}

/** OOXML 部件里的相对路径（Target）解析成包内全路径 */
function resolveTarget(baseDir, target) {
  let t = String(target || '').replace(/\\/g, '/');
  if (!t) return '';
  if (t[0] === '/') return t.replace(/^\/+/, '');
  const out = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** 解析 .rels → Map<Id, {type, target, mode}> */
function parseRels(buf) {
  const map = new Map();
  if (!buf) return map;
  scanXml(buf.toString('utf8'), {
    open(name, tag) {
      if (name !== 'Relationship') return;
      const id = attrOf(tag, 'Id');
      if (!id) return;
      map.set(id, { type: attrOf(tag, 'Type') || '', target: attrOf(tag, 'Target') || '', mode: attrOf(tag, 'TargetMode') || '' });
    },
    close() {}, text() {},
  });
  return map;
}

/* ================================================== 2. 段落 / 表格通用提取器 */

const SKIP_SUBTREE = new Set(['Fallback', 'instrText', 'delText', 'rPh']);
const HEADING_RE = /^(?:heading|标题|h)\s*([1-9])$/i;

/** pStyle / 样式名 → 'Heading1'..'Heading9' | ''（styles.xml 优先，styleId 自身的写法兜底） */
function headingOf(styleId, styles) {
  if (!styleId) return '';
  const st = styles && styles.get ? styles.get(styleId) : null;
  if (st) {
    if (st.heading) return 'Heading' + st.heading;
    if (st.outlineLvl != null && st.outlineLvl >= 0 && st.outlineLvl < 9) return 'Heading' + (st.outlineLvl + 1);
  }
  const m = HEADING_RE.exec(styleId);
  if (m) return 'Heading' + m[1];
  if (/^[1-9]$/.test(styleId)) return 'Heading' + styleId;         // WPS 的纯数字 styleId
  return '';
}

/** 列表前缀：只有 decimal 出序号，其余出 '-'（见文件头的取舍说明） */
function listMarker(numId, ilvl, numbering, counters) {
  if (!numId) return null;
  const def = numbering && numbering.get ? numbering.get(String(numId)) : null;
  const lvl = def && def.levels ? def.levels[ilvl] : null;
  const fmt = (lvl && lvl.fmt) || 'bullet';
  const base = { indent: '  '.repeat(Math.min(ilvl, 8)), level: ilvl, numId, fmt };
  if (fmt !== 'decimal' && fmt !== 'decimalZero') return Object.assign(base, { marker: '-', ordered: false });
  const key = numId + ':' + ilvl;
  const start = lvl && lvl.start ? lvl.start : 1;
  const n = (counters.get(key) || (start - 1)) + 1;
  counters.set(key, n);
  for (const k of Array.from(counters.keys())) {                  // 更深层的序号重新开始
    const p = k.split(':');
    if (p[0] === String(numId) && Number(p[1]) > ilvl) counters.delete(k);
  }
  return Object.assign(base, { marker: n + '.', ordered: true });
}

/**
 * 段落/表格提取器：docx 的 w:p 与 pptx 的 a:p 结构一致，共用一套状态机。
 * @param {string} xml
 * @param {{styles?:Map, numbering?:Map, tablesAsCells?:boolean}} cfg
 *        tablesAsCells=true（docx）：表格进 tableRows，单元格内段落不进 paragraphs
 *        tablesAsCells=false（pptx）：表格内的段落当普通段落处理
 * @returns {{lines:string[], paragraphs:object[], tableRows:string[][][], tables:number}}
 */
function scanBody(xml, cfg) {
  cfg = cfg || {};
  const styles = cfg.styles || null;
  const numbering = cfg.numbering || null;
  const asCells = !!cfg.tablesAsCells;
  const lines = [], paragraphs = [], tableRows = [];
  const pstack = [], tstack = [];
  const counters = new Map();
  let tables = 0, tDepth = 0, skip = 0;

  const cur = () => (pstack.length ? pstack[pstack.length - 1] : null);
  const curCell = () => {
    if (!tstack.length) return null;
    const t = tstack[tstack.length - 1];
    return t.cell || null;
  };

  /** 段落收尾：定样式、加列表前缀、决定进正文还是进单元格 */
  const finishPara = (p) => {
    if (!p) return;
    const style = headingOf(p.styleId, styles)
      || (p.outlineLvl != null ? 'Heading' + (p.outlineLvl + 1) : '');
    let text = p.text;
    let list = null;
    if (p.numId) {
      const mk = listMarker(p.numId, p.ilvl, numbering, counters);
      if (mk) { list = mk; text = mk.indent + mk.marker + ' ' + text; }
    }
    const entry = { style, text };
    if (p.styleId) entry.styleId = p.styleId;
    if (list) entry.list = list;
    const cell = asCells ? curCell() : null;
    if (cell) cell.push(entry);
    else { paragraphs.push(entry); lines.push(text); }
  };

  scanXml(xml, {
    open(name, tag, selfClose) {
      if (SKIP_SUBTREE.has(name)) { if (!selfClose) skip++; return; }
      if (skip) return;
      switch (name) {
        case 't': if (!selfClose) tDepth++; break;
        case 'tab': { const p = cur(); if (p) p.text += '\t'; break; }
        case 'br': case 'cr': {
          const p = cur();
          if (!p) break;
          const ty = attrOf(tag, 'type');
          if (ty !== 'page' && ty !== 'column') p.text += '\n';       // 分页符不产生换行
          break;
        }
        case 'noBreakHyphen': { const p = cur(); if (p) p.text += '-'; break; }
        case 'softHyphen': { const p = cur(); if (p) p.text += '\u00ad'; break; }
        case 'p': {
          const p = { text: '', styleId: '', outlineLvl: null, numId: 0, ilvl: 0 };
          if (selfClose) finishPara(p);                 // Word 把空段落写成 <w:p/>
          else pstack.push(p);
          break;
        }
        case 'pStyle': { const p = cur(); if (p && !p.styleId) p.styleId = attrOf(tag, 'val') || ''; break; }
        case 'outlineLvl': {
          const p = cur();
          if (p && p.outlineLvl == null) { const v = parseInt(attrOf(tag, 'val'), 10); if (Number.isFinite(v)) p.outlineLvl = v; }
          break;
        }
        case 'ilvl': { const p = cur(); if (p) { const v = parseInt(attrOf(tag, 'val'), 10); if (Number.isFinite(v)) p.ilvl = v; } break; }
        case 'numId': { const p = cur(); if (p) { const v = parseInt(attrOf(tag, 'val'), 10); if (Number.isFinite(v)) p.numId = v; } break; }
        case 'tbl': if (asCells) tstack.push({ rows: [], row: null, cell: null }); break;
        case 'tr': { const t = asCells && tstack.length ? tstack[tstack.length - 1] : null; if (t) t.row = []; break; }
        case 'tc': { const t = asCells && tstack.length ? tstack[tstack.length - 1] : null; if (t) t.cell = []; break; }
        default: break;
      }
    },
    close(name) {
      if (SKIP_SUBTREE.has(name)) { if (skip) skip--; return; }
      if (skip) return;
      switch (name) {
        case 't': if (tDepth) tDepth--; break;
        case 'p': {
          const p = pstack.pop();
          if (!p) break;
          finishPara(p);
          break;
        }
        case 'tc': {
          const t = asCells && tstack.length ? tstack[tstack.length - 1] : null;
          if (t && t.cell) {
            if (!t.row) t.row = [];
            t.row.push(t.cell.map((e) => e.text).join(' '));           // 单元格内多段用空格连
            t.cell = null;
          }
          break;
        }
        case 'tr': {
          const t = asCells && tstack.length ? tstack[tstack.length - 1] : null;
          if (t && t.row) { t.rows.push(t.row); t.row = null; }
          break;
        }
        case 'tbl': {
          if (!asCells || !tstack.length) break;
          const t = tstack.pop();
          if (t && t.rows.length) {
            tables++;
            tableRows.push(t.rows);
            for (const r of t.rows) lines.push(r.join(' | '));
          }
          break;
        }
        default: break;
      }
    },
    text(s) {
      if (skip || !tDepth) return;                                     // 只认 <w:t> / <a:t> 里的字
      const p = cur();
      if (p) p.text += decodeXml(s);
    },
  });
  return { lines, paragraphs, tableRows, tables };
}

/* ============================================================== 3. 读 docx */

const DOCX_PART = /^(?:word\/document\d*\.xml|word\/(?:styles|numbering)\.xml|docProps\/(?:core|app)\.xml)$/;

/** 解析 word/styles.xml → Map<styleId, {name, heading, outlineLvl, numId, ilvl}> */
function parseDocxStyles(buf) {
  const map = new Map();
  if (!buf) return map;
  let cur = null;
  scanXml(buf.toString('utf8'), {
    open(name, tag, selfClose) {
      if (name === 'style') {
        cur = { id: attrOf(tag, 'styleId') || '', name: '', heading: 0, outlineLvl: null, numId: 0, ilvl: 0 };
        if (selfClose) cur = null;
        return;
      }
      if (!cur) return;
      switch (name) {
        case 'name': if (!cur.name) cur.name = attrOf(tag, 'val') || ''; break;
        case 'outlineLvl': {
          const v = parseInt(attrOf(tag, 'val'), 10);
          if (Number.isFinite(v) && cur.outlineLvl == null) cur.outlineLvl = v;
          break;
        }
        case 'numId': { const v = parseInt(attrOf(tag, 'val'), 10); if (Number.isFinite(v)) cur.numId = v; break; }
        case 'ilvl': { const v = parseInt(attrOf(tag, 'val'), 10); if (Number.isFinite(v)) cur.ilvl = v; break; }
        default: break;
      }
    },
    close(name) {
      if (name !== 'style' || !cur) return;
      if (cur.id && !map.has(cur.id)) {
        const m = HEADING_RE.exec(String(cur.name).trim());
        if (m) cur.heading = Number(m[1]);
        map.set(cur.id, cur);
      }
      cur = null;
    },
    text() {},
  });
  return map;
}

/** 解析 word/numbering.xml → Map<numId, {levels:[{fmt,start,text}]}> */
function parseDocxNumbering(buf) {
  const out = new Map();
  if (!buf) return out;
  const abstracts = new Map();
  const nums = [];
  let levels = null, lvl = null, curNum = null;
  scanXml(buf.toString('utf8'), {
    open(name, tag, selfClose) {
      if (name === 'abstractNum') {
        const id = attrOf(tag, 'abstractNumId');
        levels = [];
        if (id != null) abstracts.set(String(id), levels);
        curNum = null; lvl = null;
        return;
      }
      if (name === 'num') {
        curNum = { numId: String(attrOf(tag, 'numId') == null ? '' : attrOf(tag, 'numId')), abstractId: null };
        nums.push(curNum);
        levels = null; lvl = null;
        return;
      }
      if (name === 'abstractNumId' && curNum) { curNum.abstractId = attrOf(tag, 'val'); return; }
      if (name === 'lvl' && levels) {
        const i = parseInt(attrOf(tag, 'ilvl'), 10);
        lvl = { i: Number.isFinite(i) ? i : 0, fmt: 'bullet', start: 1, text: '' };
        levels[lvl.i] = lvl;
        return;
      }
      if (!lvl) return;
      if (name === 'numFmt') lvl.fmt = attrOf(tag, 'val') || 'bullet';
      else if (name === 'start') { const v = parseInt(attrOf(tag, 'val'), 10); if (Number.isFinite(v)) lvl.start = v; }
      else if (name === 'lvlText') lvl.text = attrOf(tag, 'val') || '';
    },
    close(name) {
      if (name === 'abstractNum') { levels = null; lvl = null; }
      else if (name === 'num') curNum = null;
      else if (name === 'lvl') lvl = null;
    },
    text() {},
  });
  for (const n of nums) {
    const lv = abstracts.get(String(n.abstractId));
    if (lv) out.set(n.numId, { levels: lv });
  }
  return out;
}

function countWords(s) {
  const cjk = s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g);
  const latin = s.match(/[A-Za-z0-9][A-Za-z0-9'\u2019._+-]*/g);
  return (cjk ? cjk.length : 0) + (latin ? latin.length : 0);
}

/**
 * 读 docx。
 * @param {Buffer} buf
 * @returns {{text:string, paragraphs:{style:string,text:string}[], meta:object}}
 */
function readDocx(buf) {
  const bytes = buf && buf.length ? buf.length : 0;
  const warnings = [];
  const fail = (why) => ({
    text: '', paragraphs: [],
    meta: { title: '', author: '', created: '', paragraphs: 0, tables: 0, words: 0, bytes, warnings: warnings.concat(why) },
  });
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || []);
  let parts;
  try {
    parts = unzip(buf, { filter: (n) => DOCX_PART.test(n) });
  } catch (e) {
    return fail('解不开这个 docx：' + ((e && e.message) || e));
  }
  let mainName = 'word/document.xml';
  if (!parts.has(mainName)) {
    for (const n of parts.keys()) if (/^word\/document\d*\.xml$/.test(n)) { mainName = n; break; }
  }
  const mainBuf = parts.get(mainName);
  if (!mainBuf) warnings.push('包里没有 word/document.xml，正文为空');

  const styles = parseDocxStyles(parts.get('word/styles.xml'));
  const numbering = parseDocxNumbering(parts.get('word/numbering.xml'));
  if (!styles.size) warnings.push('缺少/无法解析 word/styles.xml，标题层级只能靠 pStyle 名字判断');
  const res = mainBuf
    ? scanBody(mainBuf.toString('utf8'), { styles, numbering, tablesAsCells: true })
    : { lines: [], paragraphs: [], tableRows: [], tables: 0 };

  const text = res.lines.join('\n');
  let title = '', author = '', created = '';
  const core = parts.get('docProps/core.xml');
  if (core) {
    const cx = core.toString('utf8');
    title = tagText(cx, 'title');
    author = tagText(cx, 'creator');
    created = tagText(cx, 'created');
  } else warnings.push('没有 docProps/core.xml（标题/作者/时间取不到）');
  const app = parts.get('docProps/app.xml');
  const meta = {
    title, author, created,
    paragraphs: res.paragraphs.length,
    tables: res.tables,
    words: countWords(text),
    bytes,
  };
  if (app) {
    const ax = app.toString('utf8');
    const pages = tagNum(ax, 'Pages');
    const appWords = tagNum(ax, 'Words');
    const application = tagText(ax, 'Application');
    if (pages != null) meta.pages = pages;
    if (appWords != null) meta.appWords = appWords;
    if (application) meta.application = application;
  } else warnings.push('没有 docProps/app.xml（页数/字数取不到）');
  if (warnings.length) meta.warnings = warnings;
  return { text, paragraphs: res.paragraphs, meta };
}

/* ============================================================= 4. 读 xlsx */

const XLSX_PART = /^(?:xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/styles\.xml|xl\/worksheets\/[^/]+\.xml)$/;

/** 解析 xl/sharedStrings.xml → string[]（单个 si 里的多个 r/t 要拼起来） */
function parseSharedStrings(buf) {
  const out = [];
  if (!buf) return out;
  let cur = null, inT = false, skip = 0;
  scanXml(buf.toString('utf8'), {
    open(name, tag, selfClose) {
      if (name === 'rPh') { if (!selfClose) skip++; return; }
      if (skip) return;
      if (name === 'si') { if (selfClose) out.push(''); else cur = ''; return; }
      if (name === 't' && cur !== null) { if (!selfClose) inT = true; return; }
    },
    close(name) {
      if (name === 'rPh') { if (skip) skip--; return; }
      if (skip) return;
      if (name === 't') inT = false;
      else if (name === 'si' && cur !== null) { out.push(cur); cur = null; }
    },
    text(s) { if (cur !== null && inT && !skip) cur += decodeXml(s); },
  });
  return out;
}

/** 解析 xl/styles.xml → {xfs:[numFmtId...], custom:{id:code}} */
function parseXlsxStyles(buf) {
  const res = { xfs: [], custom: {} };
  if (!buf) return res;
  let inCellXfs = false;
  scanXml(buf.toString('utf8'), {
    open(name, tag, selfClose) {
      if (name === 'cellXfs') { inCellXfs = true; return; }
      if (name === 'cellStyleXfs') { inCellXfs = false; return; }
      if (name === 'numFmt') {
        const id = parseInt(attrOf(tag, 'numFmtId'), 10);
        const code = attrOf(tag, 'formatCode');
        if (Number.isFinite(id) && code) res.custom[id] = code;
        return;
      }
      if (name === 'xf' && inCellXfs) {
        const id = parseInt(attrOf(tag, 'numFmtId'), 10);
        res.xfs.push(Number.isFinite(id) ? id : 0);
      }
    },
    close(name) { if (name === 'cellXfs' || name === 'cellStyleXfs') inCellXfs = false; },
    text() {},
  });
  return res;
}

/** 格式码 → 'date' | 'time' | 'datetime' | null */
function classifyFmt(code) {
  const s = String(code)
    .replace(/\[[^\]]*\]/g, '')          // [Red] / [h] / [$-409]
    .replace(/"[^"]*"/g, '')             // 字面量
    .replace(/\\./g, '')                 // 转义字符
    .replace(/_.|\*./g, '');
  const date = /[yd]/i.test(s) || /m/i.test(s);
  const time = /[hs]/i.test(s) || /:/.test(s);
  if (!date && !time) return null;
  if (date && time) return 'datetime';
  return date ? 'date' : 'time';
}
function numFmtKind(numFmtId, custom) {
  const code = custom[numFmtId];
  if (code) {
    const k = classifyFmt(code);
    if (k === 'date' && (numFmtId === 22)) return 'datetime';
    return k;
  }
  if (numFmtId >= 14 && numFmtId <= 17) return 'date';
  if (numFmtId === 22) return 'datetime';
  if ((numFmtId >= 18 && numFmtId <= 21) || (numFmtId >= 45 && numFmtId <= 47)) return 'time';
  return null;
}

const pad2 = (n) => (n < 10 ? '0' + n : String(n));
/** Excel 序列号 → 文本。1900 系统里序列号 60 是 Excel 编造的 1900-02-29，这里按真实日期算。 */
function serialToText(n, date1904, kind) {
  if (!Number.isFinite(n) || n < 0 || n > 2958466) return null;
  const days = Math.floor(n), frac = n - days;
  let base;
  if (date1904) base = Date.UTC(1904, 0, 1) + days * 86400000;
  else base = Date.UTC(1899, 11, 31) + (days >= 60 ? days - 1 : days) * 86400000;
  const d = new Date(base + Math.round(frac * 86400000));
  if (!Number.isFinite(d.getTime())) return null;
  const Y = d.getUTCFullYear(), M = pad2(d.getUTCMonth() + 1), D = pad2(d.getUTCDate());
  const h = pad2(d.getUTCHours()), mi = pad2(d.getUTCMinutes());
  if (kind === 'time') return h + ':' + mi;
  if (kind === 'datetime' && (d.getUTCHours() || d.getUTCMinutes())) return Y + '-' + M + '-' + D + ' ' + h + ':' + mi;
  return Y + '-' + M + '-' + D;
}

function colIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i) & ~32;                    // 大写
    if (c < 65 || c > 90) continue;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}
function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const STOP = { stop: true };

/** 解析单个 sheet XML → rows（稀疏补齐；超上限抛 STOP） */
function parseSheet(xml, ctx) {
  const rows = [];
  let cells = null, curRow = 0, cell = null, colSeq = 0;
  let inV = false, inT = false, inIs = false, skip = 0;

  const ensureRow = (n) => {
    if (n > ctx.maxRows) { ctx.truncated = true; throw STOP; }
    while (rows.length < n) rows.push([]);
    return rows[n - 1];
  };

  try {
    scanXml(xml, {
      open(name, tag, selfClose) {
        if (name === 'rPh') { if (!selfClose) skip++; return; }
        if (skip) return;
        switch (name) {
          case 'row': {
            const r = parseInt(attrOf(tag, 'r'), 10);
            curRow = Number.isFinite(r) ? r : rows.length + 1;
            cells = ensureRow(curRow);
            break;
          }
          case 'c': {
            const ref = attrOf(tag, 'r');
            let col = colSeq;
            if (ref) {
              const m = /^\$?([A-Za-z]+)\$?(\d+)/.exec(ref.trim());
              if (m) {
                col = colIndex(m[1]);
                const r = parseInt(m[2], 10);
                if (Number.isFinite(r) && r !== curRow) { curRow = r; cells = ensureRow(r); }
              }
            }
            colSeq = col + 1;
            cell = {
              col, row: curRow,
              type: attrOf(tag, 't') || '',
              style: parseInt(attrOf(tag, 's'), 10) || 0,
              v: '', is: '',
            };
            break;
          }
          case 'v': if (!selfClose) inV = true; break;
          case 'is': if (cell) inIs = true; break;
          case 't': if (cell && inIs && !selfClose) inT = true; break;
          default: break;
        }
      },
      close(name) {
        if (name === 'rPh') { if (skip) skip--; return; }
        if (skip) return;
        switch (name) {
          case 'v': inV = false; break;
          case 't': inT = false; break;
          case 'is': inIs = false; break;
          case 'row': cells = null; colSeq = 0; break;
          case 'c': {
            if (!cell) break;
            const val = cellValue(cell, ctx);
            if (cells && cell.col < ctx.maxCols) {
              while (cells.length < cell.col) cells.push(null);
              cells[cell.col] = val;
            }
            cell = null;
            break;
          }
          default: break;
        }
      },
      text(s) {
        if (skip || !cell) return;
        if (inT) cell.is += decodeXml(s);
        else if (inV) cell.v += decodeXml(s);
      },
    });
  } catch (e) {
    if (e !== STOP) throw e;
  }
  while (rows.length && isEmptyRow(rows[rows.length - 1])) rows.pop();   // 去掉尾部空行
  return rows;
}

function isEmptyRow(r) {
  for (const v of r) if (v !== null && v !== undefined && v !== '') return false;
  return true;
}

function cellValue(cell, ctx) {
  const t = cell.type;
  if (t === 's') {
    if (!ctx.shared) {
      if (!ctx.sharedMissing) { ctx.sharedMissing = true; ctx.warn('缺少 xl/sharedStrings.xml，t="s" 的单元格按空处理'); }
      return '';
    }
    const i = parseInt(cell.v, 10);
    const s = ctx.shared[i];
    if (s === undefined) { ctx.warn('共享字符串索引越界：' + cell.v); return ''; }
    return s;
  }
  if (t === 'inlineStr') return cell.is;
  if (t === 'str') return cell.v;
  if (t === 'b') return cell.v === '1' || /^true$/i.test(cell.v);
  if (t === 'e') return cell.v || '#N/A';
  if (t === 'd') return cell.v;
  if (!cell.v) return null;
  const n = Number(cell.v);
  if (!Number.isFinite(n)) return cell.v;
  const kind = numFmtKind(ctx.fmtId(cell.style), ctx.styles.custom);
  if (kind) {
    const txt = serialToText(n, ctx.date1904, kind);
    if (txt) return txt;
  }
  return n;
}

function displayCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}
function csvCell(v) {
  const s = displayCell(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function rowsToCsv(rows) {
  return rows.map((r) => (r || []).map(csvCell).join(',')).join('\n');
}
function rowsToText(rows) {
  return rows.map((r) => (r || []).map(displayCell).join(' | ').replace(/( \| )+$/, '').replace(/ +$/, '')).join('\n');
}

/**
 * 读 xlsx。
 * @param {Buffer} buf
 * @param {{maxRows?:number, maxCols?:number}} [opts] 默认每表 5000 行 / 200 列
 * @returns {{sheets:object[], text:string, meta:object}}
 */
function readXlsx(buf, opts) {
  opts = opts || {};
  const maxRows = opts.maxRows > 0 ? opts.maxRows : 5000;
  const maxCols = opts.maxCols > 0 ? opts.maxCols : 200;
  const bytes = buf && buf.length ? buf.length : 0;
  const warnings = [];
  const fail = (why) => ({ sheets: [], text: '', meta: { sheetNames: [], bytes, warnings: warnings.concat(why) } });
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || []);
  let parts;
  try {
    parts = unzip(buf, { filter: (n) => XLSX_PART.test(n) });
  } catch (e) {
    return fail('解不开这个 xlsx：' + ((e && e.message) || e));
  }

  const wbBuf = parts.get('xl/workbook.xml');
  const rels = parseRels(parts.get('xl/_rels/workbook.xml.rels'));
  let list = [];
  if (wbBuf) {
    scanXml(wbBuf.toString('utf8'), {
      open(name, tag, selfClose) {
        if (name !== 'sheet') return;
        list.push({
          name: attrOf(tag, 'name') || ('Sheet' + (list.length + 1)),
          rid: (RE_RELID.exec(tag) || [])[1] || '',
          state: attrOf(tag, 'state') || 'visible',
          target: '',
        });
      },
      close() {}, text() {},
    });
  }
  if (!list.length) {
    warnings.push('xl/workbook.xml 缺失或没有 <sheet>，按文件名顺序猜工作表');
    const names = Array.from(parts.keys()).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))
      .sort((a, b) => (parseInt((a.match(/(\d+)/) || [0, 0])[1], 10) || 0) - (parseInt((b.match(/(\d+)/) || [0, 0])[1], 10) || 0));
    list = names.map((n, i) => ({ name: 'Sheet' + (i + 1), rid: '', state: 'visible', target: n }));
  }

  let date1904 = false;
  if (wbBuf) {
    scanXml(wbBuf.toString('utf8'), {
      open(name, tag) { if (name === 'workbookPr') { const v = attrOf(tag, 'date1904'); if (v === '1' || v === 'true') date1904 = true; } },
      close() {}, text() {},
    });
  }

  const shared = parts.has('xl/sharedStrings.xml') ? parseSharedStrings(parts.get('xl/sharedStrings.xml')) : null;
  if (!shared) warnings.push('没有 xl/sharedStrings.xml');
  const stylesRaw = parseXlsxStyles(parts.get('xl/styles.xml'));
  if (!parts.has('xl/styles.xml')) warnings.push('没有 xl/styles.xml，日期格式可能识别不出');

  const ctx = {
    shared, styles: stylesRaw, date1904, maxRows, maxCols, truncated: false,
    sharedMissing: false,
    warn: (m) => { if (warnings.indexOf(m) < 0) warnings.push(m); },
    fmtId: (sIdx) => {
      const id = stylesRaw.xfs[sIdx];
      return Number.isFinite(id) ? id : 0;
    },
  };

  const sheets = [];
  const truncatedSheets = [];
  const blocks = [];
  list.forEach((sh, i) => {
    let target = sh.target;
    if (!target) {
      const rel = sh.rid ? rels.get(sh.rid) : null;
      target = rel ? resolveTarget('xl', rel.target) : '';
      if (!target) {
        const guess = 'xl/worksheets/sheet' + (i + 1) + '.xml';
        if (parts.has(guess)) { target = guess; ctx.warn('工作表「' + sh.name + '」的 r:id 解析不到，按 sheet' + (i + 1) + '.xml 猜'); }
      }
    }
    const xbuf = target ? parts.get(target) : null;
    let rows = [];
    if (xbuf) {
      try {
        rows = parseSheet(xbuf.toString('utf8'), ctx);
      } catch (e) {
        ctx.warn('工作表「' + sh.name + '」解析失败：' + ((e && e.message) || e));
        rows = [];
      }
    } else {
      ctx.warn('找不到工作表「' + sh.name + '」对应的 XML（' + (target || '无 Target') + '）');
    }
    let nCols = 0;
    for (const r of rows) if (r.length > nCols) nCols = r.length;
    if (ctx.truncated) { truncatedSheets.push(sh.name); ctx.truncated = false; }
    const sheet = {
      name: sh.name,
      rows,
      csv: rowsToCsv(rows),
      nRows: rows.length,
      nCols,
    };
    if (sh.state && sh.state !== 'visible') sheet.state = sh.state;
    sheets.push(sheet);
    blocks.push('### 工作表：' + sh.name + '\n' + rowsToText(rows));
  });

  const meta = { sheetNames: sheets.map((s) => s.name), bytes };
  if (truncatedSheets.length) {
    meta.truncated = true;
    meta.truncatedSheets = truncatedSheets;
    warnings.push('有工作表超过 ' + maxRows + ' 行上限，已截断：' + truncatedSheets.join('、'));
  }
  if (shared) meta.sharedStrings = shared.length;
  if (warnings.length) meta.warnings = warnings;
  return { sheets, text: blocks.join('\n\n'), meta };
}

/* ============================================================= 5. 读 pptx */

const PPTX_PART = /^(?:ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels|ppt\/slides\/slide\d+\.xml|ppt\/slides\/_rels\/slide\d+\.xml\.rels|ppt\/notesSlides\/notesSlide\d+\.xml)$/;

/** slide/notes 部件 → 段落文本数组 */
function partParagraphs(xml) {
  const res = scanBody(xml, { tablesAsCells: false });
  return res.paragraphs.map((p) => p.text).filter((t) => t !== '');
}

/**
 * 读 pptx。
 * @param {Buffer} buf
 * @returns {{slides:object[], text:string, meta:object}}
 */
function readPptx(buf) {
  const bytes = buf && buf.length ? buf.length : 0;
  const warnings = [];
  const fail = (why) => ({ slides: [], text: '', meta: { slideCount: 0, bytes, warnings: warnings.concat(why) } });
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || []);
  let parts;
  try {
    parts = unzip(buf, { filter: (n) => PPTX_PART.test(n) });
  } catch (e) {
    return fail('解不开这个 pptx：' + ((e && e.message) || e));
  }

  const presBuf = parts.get('ppt/presentation.xml');
  const rels = parseRels(parts.get('ppt/_rels/presentation.xml.rels'));
  let targets = [];
  if (presBuf) {
    scanXml(presBuf.toString('utf8'), {
      open(name, tag, selfClose) {
        if (name !== 'sldId') return;
        const rid = (RE_RELID.exec(tag) || [])[1] || '';
        const rel = rid ? rels.get(rid) : null;
        if (rel && rel.target) targets.push(resolveTarget('ppt', rel.target));
        else warnings.push('某个 <p:sldId> 的 r:id="' + rid + '" 在 rels 里找不到');
      },
      close() {}, text() {},
    });
  }
  if (!targets.length) {
    warnings.push('ppt/presentation.xml 或它的 rels 不可用，按文件名顺序排页');
    targets = Array.from(parts.keys())
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => (parseInt((a.match(/(\d+)/) || [0, 0])[1], 10) || 0) - (parseInt((b.match(/(\d+)/) || [0, 0])[1], 10) || 0));
  }

  const slides = [];
  const blocks = [];
  let withNotes = 0;
  targets.forEach((t, i) => {
    const sbuf = parts.get(t);
    const n = i + 1;
    let text = '';
    if (sbuf) {
      text = partParagraphs(sbuf.toString('utf8')).join('\n');
    } else {
      warnings.push('第 ' + n + ' 页的 XML 找不到：' + t);
    }
    const slide = { n, text };

    // 备注：slide 的 rels 里 Type 以 /notesSlide 结尾的那条
    const relBuf = parts.get('ppt/slides/_rels/' + t.replace(/^ppt\/slides\//, '') + '.rels');
    if (relBuf) {
      for (const rel of parseRels(relBuf).values()) {
        if (!/\/notesSlide$/.test(rel.type)) continue;
        const np = parts.get(resolveTarget('ppt/slides', rel.target));
        if (!np) continue;
        const lines = partParagraphs(np.toString('utf8')).filter((s) => !/^\d+$/.test(s.trim()));
        if (lines.length) { slide.notes = lines.join('\n'); withNotes++; }
        break;
      }
    }
    slides.push(slide);
    blocks.push('--- 第 ' + n + ' 页 ---\n' + text + (slide.notes ? '\n[备注] ' + slide.notes : ''));
  });

  const meta = { slideCount: slides.length, bytes };
  if (withNotes) meta.withNotes = withNotes;
  if (warnings.length) meta.warnings = warnings;
  return { slides, text: blocks.join('\n\n'), meta };
}

/* ============================================================ 6. 写 docx */

const PAGE_SIZES = { a4: [11906, 16838], a5: [8391, 11906], a3: [16838, 23811], letter: [12240, 15840], legal: [12240, 20160] };
const HEAD_FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Calibri"/>';
const CODE_FONT = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体" w:cs="Consolas"/>';
const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const R_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const CT_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/content-types"';
const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** 文本 → 一串 run；\n 变 <w:br/>，\t 变 <w:tab/>，空格靠 xml:space="preserve" 保住 */
function wRuns(text, rPr) {
  const rp = rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '';
  const s = cleanText(text);
  if (!s) return '';
  let out = '';
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i) out += '<w:r>' + rp + '<w:br/></w:r>';
    const chunks = lines[i].split('\t');
    for (let j = 0; j < chunks.length; j++) {
      if (j) out += '<w:r>' + rp + '<w:tab/></w:r>';
      if (chunks[j]) out += '<w:r>' + rp + '<w:t xml:space="preserve">' + escapeXml(chunks[j]) + '</w:t></w:r>';
    }
  }
  return out;
}

/** 一个段落。pPr 子元素顺序按 ECMA-376：pStyle → numPr → spacing → ind → jc → rPr */
function wPara(text, o) {
  o = o || {};
  let pPr = '';
  if (o.style) pPr += '<w:pStyle w:val="' + escapeAttr(o.style) + '"/>';
  if (o.numId) pPr += '<w:numPr><w:ilvl w:val="' + (o.ilvl || 0) + '"/><w:numId w:val="' + o.numId + '"/></w:numPr>';
  if (o.spacing) pPr += o.spacing;
  if (o.ind) pPr += o.ind;
  if (o.jc) pPr += '<w:jc w:val="' + o.jc + '"/>';
  if (o.rPr) pPr += '<w:rPr>' + o.rPr + '</w:rPr>';
  return '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + wRuns(text, o.rPr) + '</w:p>';
}

const BORDER = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((s) => '<w:' + s + ' w:val="single" w:sz="4" w:space="0" w:color="auto"/>').join('');

function wTable(rows) {
  const clean = rows.map((r) => (Array.isArray(r) ? r : [r]).map((c) => (c == null ? '' : String(c))));
  let cols = 1;
  for (const r of clean) if (r.length > cols) cols = r.length;
  const usable = 9026;                                   // A4 宽 - 左右各 1440 twips
  const colW = Math.floor(usable / cols);
  let x = '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>' + BORDER + '</w:tblBorders>'
    + '<w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
    + '<w:tblGrid>' + ('<w:gridCol w:w="' + colW + '"/>').repeat(cols) + '</w:tblGrid>';
  clean.forEach((row, ri) => {
    const head = ri === 0;
    const cells = [];
    for (let c = 0; c < cols; c++) {
      const tcPr = '<w:tcPr><w:tcW w:w="' + colW + '" w:type="dxa"/>'
        + (head ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : '') + '</w:tcPr>';
      const lines = String(row[c] == null ? '' : row[c]).split('\n');
      const body = lines.map((ln) => wPara(ln, head ? { rPr: '<w:b/>' } : {})).join('');
      cells.push('<w:tc>' + tcPr + body + '</w:tc>');
    }
    x += '<w:tr>' + (head ? '<w:trPr><w:tblHeader/></w:trPr>' : '') + cells.join('') + '</w:tr>';
  });
  return x + '</w:tbl>';
}

function docxStylesXml() {
  const head = (n, sz) => '<w:style w:type="paragraph" w:styleId="Heading' + n + '"><w:name w:val="heading ' + n + '"/>'
    + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="' + (n - 1) + '"/><w:spacing w:before="240" w:after="120"/></w:pPr>'
    + '<w:rPr>' + HEAD_FONT + '<w:b/><w:bCs/><w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/><w:color w:val="1F3864"/></w:rPr></w:style>';
  return XMLDECL + '<w:styles ' + W_NS + '>'
    + '<w:docDefaults><w:rPrDefault><w:rPr>' + HEAD_FONT + '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + head(1, 32) + head(2, 28) + head(3, 24)
    + '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/></w:pPr>'
    + '<w:rPr>' + CODE_FONT + '<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>'
    + '</w:styles>';
}

function docxNumberingXml() {
  const lvl = (i, kind) => {
    const ind = 420 + i * 420;
    const mid = kind === 'bullet'
      ? '<w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>'
      : '<w:numFmt w:val="decimal"/><w:lvlText w:val="%' + (i + 1) + '."/>';
    return '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/>' + mid + '<w:lvlJc w:val="left"/>'
      + '<w:pPr><w:ind w:left="' + ind + '" w:hanging="420"/></w:pPr></w:lvl>';
  };
  return XMLDECL + '<w:numbering ' + W_NS + '>'
    + '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' + lvl(0, 'bullet') + lvl(1, 'bullet') + lvl(2, 'bullet') + '</w:abstractNum>'
    + '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' + lvl(0, 'dec') + lvl(1, 'dec') + lvl(2, 'dec') + '</w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
    + '</w:numbering>';
}

function propsCoreXml(o) {
  o = o || {};
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const created = o.created || now;
  return XMLDECL + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
    + ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + '<dc:title>' + escapeXml(o.title || '') + '</dc:title>'
    + '<dc:creator>' + escapeXml(o.author || '') + '</dc:creator>'
    + '<cp:lastModifiedBy>' + escapeXml(o.author || '') + '</cp:lastModifiedBy>'
    + '<dcterms:created xsi:type="dcterms:W3CDTF">' + created + '</dcterms:created>'
    + '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>'
    + '</cp:coreProperties>';
}

/** docProps/app.xml：子元素顺序必须按 CT_Properties 的 sequence（Company→Pages→Words→…→AppVersion→DocSecurity） */
function propsAppXml(o) {
  o = o || {};
  let x = XMLDECL + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
    + ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">';
  if (o.company) x += '<Company>' + escapeXml(o.company) + '</Company>';
  if (o.pages) x += '<Pages>' + o.pages + '</Pages>';
  if (o.words) x += '<Words>' + o.words + '</Words>';
  x += '<ScaleCrop>false</ScaleCrop><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>'
    + '<HyperlinksChanged>false</HyperlinksChanged><Application>' + escapeXml(o.application || 'DSH OOXML Writer')
    + '</Application><AppVersion>16.0000</AppVersion><DocSecurity>0</DocSecurity></Properties>';
  return x;
}

/**
 * 生成 docx。
 * @param {{title?:string, author?:string, blocks:object[]}} doc
 * @param {{pageSize?:string|{w:number,h:number}}} [opts]
 * @returns {Buffer}
 */
function writeDocx(doc, opts) {
  doc = doc || {};
  opts = opts || {};
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  const body = [];
  let pages = 1;
  let lastWasTable = false;

  const push = (xml, isTable) => { body.push(xml); lastWasTable = !!isTable; };

  for (const b of blocks) {
    if (!b) continue;
    const t = b.t || 'p';
    if (t === 'h') {
      const lv = Math.min(Math.max(parseInt(b.level, 10) || 1, 1), 3);
      push(wPara(b.text || '', { style: 'Heading' + lv }), false);
    } else if (t === 'li') {
      const lv = Math.min(Math.max(parseInt(b.level, 10) || 0, 0), 2);
      push(wPara(b.text || '', b.ordered
        ? { numId: 2, ilvl: lv }
        : { numId: 1, ilvl: lv }), false);
    } else if (t === 'table') {
      const rows = Array.isArray(b.rows) ? b.rows : [];
      if (!rows.length) push(wPara(''), false);
      else push(wTable(rows), true);
    } else if (t === 'code') {
      const lines = cleanText(b.text || '').split('\n');
      for (const ln of lines) push(wPara(ln, { style: 'Code' }), false);
    } else if (t === 'pagebreak') {
      push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>', false);
      pages++;
    } else {
      push(wPara(b.text || '', {}), false);
    }
  }
  if (lastWasTable) body.push(wPara(''));           // 表格结尾 Word 需要跟一个段落
  if (!body.length) body.push(wPara(''));
  // 标题：既写进 docProps/core.xml，也在正文最前面渲染一个居中加粗的大字标题
  if (doc.title) {
    body.unshift(wPara(String(doc.title), {
      spacing: '<w:spacing w:before="0" w:after="240"/>',
      jc: 'center',
      rPr: HEAD_FONT + '<w:b/><w:bCs/><w:sz w:val="36"/><w:szCs w:val="36"/>',
    }));
  }

  const ps = PAGE_SIZES[String(opts.pageSize || 'a4').toLowerCase()] || PAGE_SIZES.a4;
  const w = (opts.pageSize && opts.pageSize.w) || ps[0];
  const h = (opts.pageSize && opts.pageSize.h) || ps[1];

  const documentXml = XMLDECL + '<w:document ' + W_NS + '><w:body>' + body.join('')
    + '<w:sectPr><w:pgSz w:w="' + w + '" w:h="' + h + '"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>'
    + '<w:cols w:space="425"/><w:docGrid w:type="lines" w:linePitch="312"/></w:sectPr>'
    + '</w:body></w:document>';

  const contentTypes = XMLDECL + '<Types ' + CT_NS + '>'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>';

  const rootRels = XMLDECL + '<Relationships ' + R_NS + '>'
    + '<Relationship Id="rId1" Type="' + OD + '/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="' + PKG + '/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="' + OD + '/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>';

  const docRels = XMLDECL + '<Relationships ' + R_NS + '>'
    + '<Relationship Id="rId1" Type="' + OD + '/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="' + OD + '/numbering" Target="numbering.xml"/>'
    + '</Relationships>';

  const wordText = body.join('').replace(/<[^>]*>/g, ' ');

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: docxStylesXml() },
    { name: 'word/numbering.xml', data: docxNumberingXml() },
    { name: 'docProps/core.xml', data: propsCoreXml(doc) },
    { name: 'docProps/app.xml', data: propsAppXml({ title: doc.title, company: '', pages, words: countWords(wordText) }) },
  ]);
}

/* ============================================================ 7. 写 xlsx */

const SHEET_BAD = /[\\/?*[\]:]/g;

function safeSheetName(raw, index, used) {
  let n = String(raw == null ? '' : raw).replace(SHEET_BAD, '').replace(/^'+|'+$/g, '').trim();
  if (!n) n = 'Sheet' + (index + 1);
  if (n.length > 31) n = n.slice(0, 31);
  let cand = n, k = 2;
  while (used.has(cand.toLowerCase())) {
    const suffix = ' (' + k++ + ')';
    cand = n.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(cand.toLowerCase());
  return cand;
}

/** 数字 → <v> 文本（整数值不写小数点，指数形式交给 Excel） */
function numXml(v) {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  return String(v);
}

function xSheetXml(rows) {
  let maxCols = 0;
  const body = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const arr = Array.isArray(rows[ri]) ? rows[ri] : [rows[ri]];
    if (arr.length > maxCols) maxCols = arr.length;
    const cells = [];
    for (let ci = 0; ci < arr.length; ci++) {
      const v = arr[ci];
      if (v === null || v === undefined) continue;
      const ref = colName(ci) + (ri + 1);
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) continue;
        cells.push('<c r="' + ref + '"><v>' + numXml(v) + '</v></c>');
      } else if (typeof v === 'boolean') {
        cells.push('<c r="' + ref + '" t="b"><v>' + (v ? 1 : 0) + '</v></c>');
      } else {
        const s = String(v);
        if (s === '') continue;
        cells.push('<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + escapeCellText(s) + '</t></is></c>');
      }
    }
    body.push('<row r="' + (ri + 1) + '"' + (cells.length ? '' : '/') + '>' + cells.join('') + (cells.length ? '</row>' : ''));
  }
  const lastRow = Math.max(1, rows.length);
  const dim = maxCols ? 'A1:' + colName(maxCols - 1) + lastRow : 'A1';
  return XMLDECL + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<dimension ref="' + dim + '"/>'
    + '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="14.25"/>'
    + '<sheetData>' + body.join('') + '</sheetData>'
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
    + '</worksheet>';
}

function xStylesXml() {
  return XMLDECL + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '<dxfs count="0"/>'
    + '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>'
    + '</styleSheet>';
}

/**
 * 生成 xlsx。字符串一律用 inline string（省掉 sharedStrings.xml，合法且简单）。
 * @param {{sheets:{name:string, rows:(string|number|boolean|null)[][]}[]}} wb
 * @returns {Buffer}
 */
function writeXlsx(wb, opts) {
  wb = wb || {};
  opts = opts || {};
  const raw = Array.isArray(wb.sheets) && wb.sheets.length ? wb.sheets : [{ name: 'Sheet1', rows: [] }];
  const used = new Set();
  const sheets = raw.map((s, i) => ({
    name: safeSheetName(s && s.name, i, used),
    rows: s && Array.isArray(s.rows) ? s.rows : [],
  }));

  let ct = XMLDECL + '<Types ' + CT_NS + '>'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>';
  sheets.forEach((s, i) => {
    ct += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
  });
  ct += '</Types>';

  const rootRels = XMLDECL + '<Relationships ' + R_NS + '>'
    + '<Relationship Id="rId1" Type="' + OD + '/officeDocument" Target="xl/workbook.xml"/>'
    + '<Relationship Id="rId2" Type="' + PKG + '/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="' + OD + '/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>';

  let wbRels = XMLDECL + '<Relationships ' + R_NS + '>';
  sheets.forEach((s, i) => {
    wbRels += '<Relationship Id="rId' + (i + 1) + '" Type="' + OD + '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
  });
  wbRels += '<Relationship Id="rId' + (sheets.length + 1) + '" Type="' + OD + '/styles" Target="styles.xml"/></Relationships>';

  const workbook = XMLDECL + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27321"/>'
    + '<workbookPr/>'
    + '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20490" windowHeight="7620"/></bookViews>'
    + '<sheets>' + sheets.map((s, i) => '<sheet name="' + escapeAttr(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>'
    + '<calcPr calcId="191029"/>'
    + '</workbook>';

  let words = 0;
  const files = [
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: xStylesXml() },
  ];
  sheets.forEach((s, i) => {
    files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: xSheetXml(s.rows) });
    for (const r of s.rows) for (const c of (r || [])) if (typeof c === 'string') words += countWords(c);
  });
  files.push({ name: 'docProps/core.xml', data: propsCoreXml({ title: wb.title, author: wb.author }) });
  files.push({ name: 'docProps/app.xml', data: propsAppXml({ words, company: '' }) });
  return zip(files);
}

/* ============================================================== 8. 导出 */

exports.readDocx = readDocx;
exports.readXlsx = readXlsx;
exports.readPptx = readPptx;
exports.writeDocx = writeDocx;
exports.writeXlsx = writeXlsx;

/* ------------------------------------------------------------------ CLI
 * node app/doc/ooxml.js read <a.docx|a.xlsx|a.pptx> [--chars 2000]
 */
if (require.main === module) {
  const fs = require('fs');
  const args = process.argv.slice(2);
  const cmd = args[0];
  const file = args[1];
  if (cmd !== 'read' || !file) {
    console.error('用法: node app/doc/ooxml.js read <a.docx|a.xlsx|a.pptx> [--chars N]');
    process.exit(2);
  }
  const ci = args.indexOf('--chars');
  const limit = ci > 0 ? parseInt(args[ci + 1], 10) || 2000 : 2000;
  try {
    const buf = fs.readFileSync(file);
    const ext = (file.match(/\.([a-z0-9]+)$/i) || [])[1] ? RegExp.$1.toLowerCase() : '';
    const t0 = Date.now();
    const r = ext === 'xlsx' ? readXlsx(buf) : ext === 'pptx' ? readPptx(buf) : readDocx(buf);
    const ms = Date.now() - t0;
    console.log(JSON.stringify(r.meta, null, 2));
    console.log('--- ' + ms + ' ms, ' + (r.text || '').length + ' chars ---');
    console.log((r.text || '').slice(0, limit));
  } catch (e) {
    console.error('失败：' + ((e && e.message) || e));
    process.exit(1);
  }
}
