'use strict';
/**
 * pdf.js —— 零依赖 PDF 文本提取器（CommonJS，只用 node 内置模块）
 *
 *   const { extractPdfText } = require('./pdf.js');
 *   const r = extractPdfText(fs.readFileSync('x.pdf'));
 *   // r.text / r.pages / r.meta
 *
 * 设计要点（都是被真实 PDF 逼出来的）：
 *  - 全文按 latin1 读成字符串：1 字符 == 1 字节，字节偏移和字符串下标一致，
 *    绝不用 toString('utf8')（会把字节偏移毁掉、把二进制流撕碎）。
 *  - 对象发现靠扫 "N G obj … endobj"，不依赖 xref（xref 常常是坏的/增量的）。
 *    扫到的偏移落在已发现的 stream 区间内就跳过（二进制流里恰好出现 "12 0 obj" 是常事）。
 *  - 对象流（/Type /ObjStm）里的对象（字体字典、ToUnicode CMap 等）按需解压后并入对象表。
 *  - 页面顺序走 /Root → /Pages → /Kids；树坏了就退化成按对象号排序的全量 /Type /Page。
 *
 * 明确不做：OCR（扫描件）、/Encrypt 解密、竖排细节、PDF 表单字段值、注释文本、
 *          图像（DCTDecode/JPXDecode/CCITTFaxDecode）内容。
 */

const zlib = require('zlib');
const fs = require('fs');

/* =========================================================================
 * 1. 基础工具
 * ========================================================================= */

const CH_SP = 0x20, CH_LF = 0x0a, CH_CR = 0x0d, CH_TAB = 0x09, CH_FF = 0x0c, CH_NUL = 0x00;

function isWhite(c) { return c === CH_SP || c === CH_LF || c === CH_CR || c === CH_TAB || c === CH_FF || c === CH_NUL; }
function isDelim(c) {
  return c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b ||
         c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
}
function isDigit(c) { return c >= 0x30 && c <= 0x39; }

/** 去掉 UTF-16 目标串里的 BOM / 零宽字符 */
function cleanDest(s) {
  return s.replace(/^\uFEFF/, '').replace(/\u0000/g, '');
}

/* =========================================================================
 * 2. 词法 / 语法：PDF 对象
 * ========================================================================= */

/** 值节点：{t:'name'|'str'|'num'|'bool'|'null'|'kw'|'arr'|'dict'|'ref'|'stream'} */
function skipWs(lex, end) {
  const S = lex.S;
  let i = lex.i;
  while (i < end) {
    const c = S.charCodeAt(i);
    if (isWhite(c)) { i++; continue; }
    if (c === 0x25) { // % 注释
      while (i < end) { const d = S.charCodeAt(i); if (d === CH_LF || d === CH_CR) break; i++; }
      continue;
    }
    break;
  }
  lex.i = i;
}

function readWord(lex, end) {
  const S = lex.S, start = lex.i;
  let i = lex.i;
  while (i < end) {
    const c = S.charCodeAt(i);
    if (isWhite(c) || isDelim(c)) break;
    i++;
  }
  lex.i = i;
  return S.slice(start, i);
}

function parseName(lex, end) {
  const S = lex.S;
  let i = lex.i + 1, out = '';
  while (i < end) {
    const c = S.charCodeAt(i);
    if (isWhite(c) || isDelim(c)) break;
    if (c === 0x23 /* # */ && i + 2 < end) {
      const h = S.substr(i + 1, 2);
      if (/^[0-9A-Fa-f]{2}$/.test(h)) { out += String.fromCharCode(parseInt(h, 16)); i += 3; continue; }
    }
    out += S[i];
    i++;
  }
  lex.i = i;
  return { t: 'name', v: out };
}

function parseNumberToken(lex, end) {
  const S = lex.S, start = lex.i;
  let i = lex.i;
  while (i < end) {
    const c = S.charCodeAt(i);
    if (isDigit(c) || c === 0x2b /*+*/ || c === 0x2d /*-*/ || c === 0x2e /*.*/) i++;
    else break;
  }
  lex.i = i;
  const v = parseFloat(S.slice(start, i));
  return isNaN(v) ? 0 : v;
}

function parseLiteralString(lex, end) {
  const S = lex.S;
  let i = lex.i + 1, depth = 1;
  const bytes = [];
  while (i < end) {
    const c = S.charCodeAt(i);
    if (c === 0x5c /* \ */) {
      i++;
      const e = S.charCodeAt(i);
      switch (e) {
        case 0x6e: bytes.push(10); i++; break;
        case 0x72: bytes.push(13); i++; break;
        case 0x74: bytes.push(9); i++; break;
        case 0x62: bytes.push(8); i++; break;
        case 0x66: bytes.push(12); i++; break;
        case 0x28: bytes.push(40); i++; break;
        case 0x29: bytes.push(41); i++; break;
        case 0x5c: bytes.push(92); i++; break;
        case CH_CR: i++; if (S.charCodeAt(i) === CH_LF) i++; break;   // 反斜杠续行
        case CH_LF: i++; break;
        default: {
          if (e >= 0x30 && e <= 0x37) {                                 // \ddd 八进制
            let oct = 0, k = 0;
            while (k < 3 && i < end) {
              const d = S.charCodeAt(i);
              if (d < 0x30 || d > 0x37) break;
              oct = oct * 8 + (d - 0x30); i++; k++;
            }
            bytes.push(oct & 0xff);
          } else { bytes.push((e || 0) & 0xff); i++; }
        }
      }
      continue;
    }
    if (c === 0x28) { depth++; bytes.push(40); i++; continue; }
    if (c === 0x29) { depth--; i++; if (depth === 0) break; bytes.push(41); continue; }
    bytes.push(c & 0xff); i++;
  }
  lex.i = i;
  return { t: 'str', b: Buffer.from(bytes) };
}

function parseHexString(lex, end) {
  const S = lex.S;
  let i = lex.i + 1, hex = '';
  while (i < end) {
    const c = S.charCodeAt(i);
    i++;
    if (c === 0x3e /* > */) break;
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) hex += S[i - 1];
  }
  lex.i = i;
  if (hex.length & 1) hex += '0';   // 奇数长度补 0（规范要求）
  return { t: 'str', b: Buffer.from(hex, 'hex') };
}

function parseArray(lex, end) {
  const out = [];
  lex.i++; // [
  for (;;) {
    skipWs(lex, end);
    if (lex.i >= end) break;
    const c = lex.S.charCodeAt(lex.i);
    if (c === 0x5d /* ] */) { lex.i++; break; }
    const before = lex.i;
    const v = parseValue(lex, end);
    if (v === null) break;
    if (lex.i === before) { lex.i++; continue; }   // 防御：游标没动就硬推一格
    if (out.length < 500000) out.push(v);
  }
  return { t: 'arr', v: out };
}

function parseDict(lex, end) {
  const map = new Map();
  lex.i += 2; // <<
  for (;;) {
    skipWs(lex, end);
    if (lex.i >= end) break;
    const c = lex.S.charCodeAt(lex.i);
    if (c === 0x3e && lex.S.charCodeAt(lex.i + 1) === 0x3e) { lex.i += 2; break; }
    if (c !== 0x2f) { // 容错：不是名字就跳过
      lex.i++;
      continue;
    }
    const key = parseName(lex, end).v;
    skipWs(lex, end);
    const before = lex.i;
    const val = parseValue(lex, end);
    if (val !== null) map.set(key, val);
    if (lex.i === before) lex.i++;   // 防御：游标没动就硬推一格
  }
  return { t: 'dict', v: map };
}

function parseNumberOrRef(lex, end) {
  const n1 = parseNumberToken(lex, end);
  const after1 = lex.i;
  skipWs(lex, end);
  const c = lex.S.charCodeAt(lex.i);
  if (isDigit(c)) {
    const n2 = parseNumberToken(lex, end);
    skipWs(lex, end);
    if (lex.S.charCodeAt(lex.i) === 0x52 /* R */) {
      const nb = lex.i + 1;
      if (nb >= end || isWhite(lex.S.charCodeAt(nb)) || isDelim(lex.S.charCodeAt(nb))) {
        lex.i = nb;
        if (Number.isInteger(n1) && Number.isInteger(n2)) return { t: 'ref', num: n1, gen: n2 };
      }
    }
  }
  lex.i = after1;
  return { t: 'num', v: n1 };
}

/** 解析一个 PDF 对象（游标进，游标停在对象之后） */
function parseValue(lex, end) {
  skipWs(lex, end);
  if (lex.i >= end) return null;
  const S = lex.S, i = lex.i;
  const c = S.charCodeAt(i);
  if (c === 0x3c) return S.charCodeAt(i + 1) === 0x3c ? parseDict(lex, end) : parseHexString(lex, end);
  if (c === 0x5b) return parseArray(lex, end);
  if (c === 0x28) return parseLiteralString(lex, end);
  if (c === 0x2f) return parseName(lex, end);
  if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) return parseNumberOrRef(lex, end);
  const w = readWord(lex, end);
  if (w === '') {
    // 没有任何分支识别的分隔符：吞掉一个字符再返回空关键字。
    // 关键：必须让游标前进，否则 parseArray/parseDict 的循环会永不终止（OOM）。
    lex.i++;
    return { t: 'kw', v: '' };
  }
  if (w === 'true') return { t: 'bool', v: true };
  if (w === 'false') return { t: 'bool', v: false };
  if (w === 'null') return { t: 'null' };
  return { t: 'kw', v: w };
}

/* 取值辅助 */
function asName(v) { return v && v.t === 'name' ? v.v : null; }
function asNum(v) { return v && v.t === 'num' ? v.v : null; }
function asBool(v) { return v && v.t === 'bool' ? v.v : null; }
function asMap(v) { return v && v.t === 'dict' ? v.v : null; }
function dictGet(d, key) { return d ? d.get(key) : undefined; }

/* =========================================================================
 * 3. 过滤器解码（Flate + 预测器 + LZW/ASCIIHex/ASCII85/RunLength）
 * ========================================================================= */

function inflate(buf) {
  // finishFlush=Z_SYNC_FLUSH 能容忍被截断的流（现实中很常见），比直接 inflateSync 皮实
  try { return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
  catch (e) { /* fallthrough */ }
  try { return zlib.inflateRawSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
  catch (e) { return null; }
}

/** PNG(10-15)/TIFF(2) 预测器还原 */
function applyPredictor(data, parms) {
  if (!parms) return data;
  const pred = parms.Predictor || 1;
  if (pred <= 1) return data;
  const colors = parms.Colors || 1;
  const bpc = parms.BitsPerComponent || 8;
  const columns = parms.Columns || 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));   // 每像素字节数
  const rowLen = Math.ceil((colors * bpc * columns) / 8);   // 每行字节数
  if (rowLen <= 0) return data;
  const out = Buffer.alloc(((data.length / rowLen) | 0) * rowLen + rowLen);
  let op = 0, ip = 0;
  if (pred === 2) {   // TIFF
    if (data.length < rowLen) return data;
    let prev = data.subarray(0, rowLen);
    prev.copy(out, 0); op = rowLen; ip = rowLen;
    while (ip + rowLen <= data.length) {
      for (let k = 0; k < rowLen; k++) {
        const raw = data[ip + k];
        const left = k >= bpp ? out[op + k - bpp] : 0;
        out[op + k] = (raw + left) & 0xff;
      }
      ip += rowLen; op += rowLen;
    }
    return out.subarray(0, op);
  }
  // PNG：每行开头 1 字节 filter type
  let prevRow = Buffer.alloc(rowLen);
  while (ip + 1 + rowLen <= data.length) {
    const ft = data[ip]; ip++;
    const row = data.subarray(ip, ip + rowLen); ip += rowLen;
    for (let k = 0; k < rowLen; k++) {
      const raw = row[k];
      const left = k >= bpp ? out[op + k - bpp] : 0;
      const up = prevRow[k];
      const upLeft = k >= bpp ? prevRow[k - bpp] : 0;
      let val;
      switch (ft) {
        case 0: val = raw; break;
        case 1: val = raw + left; break;
        case 2: val = raw + up; break;
        case 3: val = raw + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          val = raw + (pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft));
          break;
        }
        default: val = raw;
      }
      out[op + k] = val & 0xff;
    }
    prevRow = out.subarray(op, op + rowLen);
    op += rowLen;
  }
  return out.subarray(0, op);
}

function decodeLZW(buf, early) {
  const out = [];
  const dict = [];
  const resetDict = () => { dict.length = 0; for (let i = 0; i < 256; i++) dict.push([i]); dict.push(null); dict.push(null); };
  resetDict();
  let bitBuf = 0, bitLen = 0, codeLen = 9, prev = null;
  const e = early === 0 ? 0 : 1;
  for (let i = 0; i < buf.length; i++) {
    bitBuf = (bitBuf << 8) | buf[i];
    bitLen += 8;
    while (bitLen >= codeLen) {
      const code = (bitBuf >> (bitLen - codeLen)) & ((1 << codeLen) - 1);
      bitLen -= codeLen;
      if (code === 256) { resetDict(); codeLen = 9; prev = null; continue; }
      if (code === 257) return Buffer.from(out);
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (prev) entry = prev.concat([prev[0]]);
      else break;
      for (const b of entry) out.push(b);
      if (prev) {
        dict.push(prev.concat([entry[0]]));
        if (dict.length + e >= (1 << codeLen) && codeLen < 12) codeLen++;
      }
      prev = entry;
    }
  }
  return Buffer.from(out);
}

function decodeASCIIHex(buf) {
  const s = buf.toString('latin1');
  let hex = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '>') break;
    if (/[0-9A-Fa-f]/.test(c)) hex += c;
  }
  if (hex.length & 1) hex += '0';
  return Buffer.from(hex, 'hex');
}

function decodeASCII85(buf) {
  const s = buf.toString('latin1');
  const out = [];
  let tuple = 0, count = 0;
  let i = 0;
  if (s.startsWith('<~')) i = 2;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isWhite(c)) continue;
    if (c === 0x7e /* ~ */) break;
    if (c === 0x7a /* z */ && count === 0) { out.push(0, 0, 0, 0); continue; }
    if (c < 0x21 || c > 0x75) continue;
    tuple = tuple * 85 + (c - 33);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0; count = 0;
    }
  }
  if (count > 0) {
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84;
    out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
    return Buffer.from(out.subarray(0, out.length - (5 - count)));
  }
  return Buffer.from(out);
}

function decodeRunLength(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const l = buf[i++];
    if (l === 128) break;
    if (l < 128) { for (let k = 0; k < l + 1 && i < buf.length; k++) out.push(buf[i++]); }
    else { const b = buf[i++]; for (let k = 0; k < 257 - l; k++) out.push(b); }
  }
  return Buffer.from(out);
}

const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);

/* =========================================================================
 * 4. 文档对象：扫描 / 对象流 / 取流
 * ========================================================================= */

class PdfDocument {
  constructor(buf) {
    this.buf = buf;
    this.S = buf.toString('latin1');   // 1 字符 = 1 字节，偏移即下标
    this.objects = new Map();          // 对象号 -> 值节点
    this.streamRanges = [];            // 已识别的 stream 字节区间（扫描时跳过）
    this.objStmCache = new Map();      // 对象流里的对象
    this.objStmBuilt = false;
    this.trailers = [];                // trailer 字典（后出现的优先）
    this.errors = [];
    this._scan();
    this._collectTrailers();
  }

  /* ---- 4.1 全文件扫描 N G obj ---- */
  _scan() {
    const S = this.S;
    const re = /(\d{1,10})[\x00\t\n\f\r ]+(\d{1,5})[\x00\t\n\f\r ]+obj(?![A-Za-z0-9_])/g;
    let m;
    while ((m = re.exec(S)) !== null) {
      const at = m.index;
      // obj 号前面必须是分隔符（防止二进制流里恰好出现的数字串）
      if (at > 0) {
        const p = S.charCodeAt(at - 1);
        if (!isWhite(p) && p !== 0x3e && p !== 0x5d && p !== 0x29) continue;
      }
      if (this._inStream(at)) continue;
      const num = parseInt(m[1], 10);
      let endObj = S.indexOf('endobj', re.lastIndex);
      if (endObj < 0) endObj = S.length;
      try {
        const lex = { S, i: re.lastIndex };
        const val = parseValue(lex, endObj);
        if (val !== null) {
          skipWs(lex, endObj);
          if (val.t === 'dict' && S.startsWith('stream', lex.i)) {
            let p = lex.i + 6;
            if (S.charCodeAt(p) === CH_CR) p++;
            if (S.charCodeAt(p) === CH_LF) p++;
            let len = null;
            const lv = val.v.get('Length');
            if (lv && lv.t === 'num') len = lv.v;
            let dataEnd;
            if (len != null && len >= 0 && p + len <= S.length) {
              const tail = S.substr(p + len, 20);
              dataEnd = /^\s*endstream/.test(tail) ? p + len : -1;
            }
            if (dataEnd == null || dataEnd < 0) {
              const es = S.indexOf('endstream', p);
              dataEnd = es < 0 ? S.length : es;
            }
            const node = { t: 'stream', v: val.v, s: p, e: dataEnd };
            this.objects.set(num, node);
            this.streamRanges.push([at, endObj + 6]);
          } else {
            this.objects.set(num, val);
          }
        }
      } catch (e) {
        this.errors.push('obj ' + num + ': ' + e.message);
      }
    }
    this.streamRanges.sort((a, b) => a[0] - b[0]);
  }

  _inStream(off) {
    const rs = this.streamRanges;
    // 扫描按偏移升序，只需回看最后几个区间
    for (let i = rs.length - 1; i >= 0 && i >= rs.length - 8; i--) {
      if (off >= rs[i][0] && off < rs[i][1]) return true;
    }
    return false;
  }

  /* ---- 4.2 trailer 与 xref 流里的 trailer 信息 ---- */
  _collectTrailers() {
    const S = this.S;
    const re = /trailer/g;
    let m;
    while ((m = re.exec(S)) !== null) {
      const lex = { S, i: m.index + 7 };
      try {
        const v = parseValue(lex, S.length);
        if (v && v.t === 'dict') this.trailers.push(v.v);
      } catch (e) { /* ignore */ }
      re.lastIndex = m.index + 7;
    }
    for (const val of this.objects.values()) {
      if (val && val.t === 'stream' && asName(val.v.get('Type')) === 'XRef') this.trailers.push(val.v);
    }
  }

  trailerGet(key) {
    for (let i = this.trailers.length - 1; i >= 0; i--) {
      const v = this.trailers[i].get(key);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /* ---- 4.3 取对象（含对象流） ---- */
  get(num) {
    if (this.objects.has(num)) return this.objects.get(num);
    if (this.objStmCache.has(num)) return this.objStmCache.get(num);
    if (!this.objStmBuilt) this._buildObjStmIndex();
    if (this.objStmCache.has(num)) return this.objStmCache.get(num);
    return null;
  }

  _buildObjStmIndex() {
    this.objStmBuilt = true;   // 先置位，避免解压时 resolve 递归
    const S = this.S;
    for (const val of this.objects.values()) {
      if (!val || val.t !== 'stream') continue;
      if (asName(val.v.get('Type')) !== 'ObjStm') continue;
      /* 必须走 streamData（会按 /Filter 解压）：rawStreamData 给的是压缩态字节，
       * 拿它当 ObjStm 的正文去解析配对表永远解不出来 —— 结果是「页树在对象流里
       * 的 PDF 一页都找不到」（iText 5 出的国标那类文件就是这样，4MB 抽出 0 字）。 */
      const data = this.streamData(val);
      if (!data) continue;
      const text = data.toString('latin1');
      let n = asNum(this.resolve(val.v.get('N')));
      let first = asNum(this.resolve(val.v.get('First')));
      if (typeof n !== 'number' || !isFinite(n) || n <= 0 || n > 100000) continue;
      if (typeof first !== 'number' || !isFinite(first) || first < 0 || first > text.length) continue;
      const lex = { S: text, i: 0 };
      const pairs = [];
      try {
        for (let k = 0; k < n; k++) {
          const a = parseValue(lex, first);
          const b = parseValue(lex, first);
          if (!a || !b || a.t !== 'num' || b.t !== 'num') break;
          pairs.push([a.v, b.v]);
        }
      } catch (e) { /* 头部坏了就算了 */ }
      for (const [onum, off] of pairs) {
        if (this.objStmCache.has(onum) || this.objects.has(onum)) continue;
        const lex2 = { S: text, i: first + off };
        try {
          const v = parseValue(lex2, text.length);
          if (v !== null) this.objStmCache.set(onum, v);
        } catch (e) { /* ignore */ }
      }
    }
  }

  resolve(v) {
    let guard = 0;
    while (v && v.t === 'ref' && guard++ < 32) v = this.get(v.num);
    return v || null;
  }

  dictArray(v) {
    const r = this.resolve(v);
    if (!r) return [];
    if (r.t === 'arr') return r.v;
    return [r];
  }

  /** 未解压的流字节 */
  rawStreamData(st) {
    if (!st || st.t !== 'stream') return null;
    return Buffer.from(this.S.slice(st.s, st.e), 'latin1');
  }

  /** 按 /Filter /DecodeParms 解压；图像流返回 null */
  streamData(st) {
    if (!st || st.t !== 'stream') return null;
    let data = this.rawStreamData(st);
    let filters = this.resolve(st.v.get('Filter'));
    let parms = this.resolve(st.v.get('DecodeParms') || st.v.get('DP'));
    if (filters && filters.t === 'arr') filters = filters.v; else filters = filters ? [filters] : [];
    if (parms && parms.t === 'arr') parms = parms.v; else parms = [parms];
    for (let i = 0; i < filters.length; i++) {
      const f = asName(this.resolve(filters[i]));
      if (!f) continue;
      if (IMAGE_FILTERS.has(f)) return null;
      let p = this.resolve(parms[i]);
      let pm = null;
      if (p && p.t === 'dict') {
        pm = {};
        for (const [k, v] of p.v) { const rv = this.resolve(v); const n = asNum(rv); if (n !== null) pm[k] = n; }
      }
      try {
        if (f === 'FlateDecode' || f === 'Fl') {
          data = inflate(data);
          if (data === null) return null;
          data = applyPredictor(data, pm);
        } else if (f === 'LZWDecode' || f === 'LZW') {
          data = decodeLZW(data, pm && pm.EarlyChange);
          data = applyPredictor(data, pm);
        } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
          data = decodeASCIIHex(data);
        } else if (f === 'ASCII85Decode' || f === 'A85') {
          data = decodeASCII85(data);
        } else if (f === 'RunLengthDecode' || f === 'RL') {
          data = decodeRunLength(data);
        } else if (f === 'Crypt') {
          continue;
        } else {
          return null;  // 未知过滤器：不要拿垃圾当文本
        }
      } catch (e) {
        this.errors.push('filter ' + f + ': ' + e.message);
        return null;
      }
    }
    return data;
  }

  /** 流的文本形式（内容流 / CMap / ObjStm 都用它） */
  streamText(st) {
    const d = this.streamData(st);
    return d ? d.toString('latin1') : null;
  }
}

/* =========================================================================
 * 5. 字形名 → Unicode
 * ========================================================================= */

const GLYPH_TABLE = (() => {
  const t = Object.create(null);
  // ASCII 字母/数字按名字自映射
  for (let c = 0x41; c <= 0x5a; c++) t[String.fromCharCode(c)] = String.fromCharCode(c);
  for (let c = 0x61; c <= 0x7a; c++) t[String.fromCharCode(c)] = String.fromCharCode(c);
  const data = `
space=0020;exclam=0021;quotedbl=0022;numbersign=0023;dollar=0024;percent=0025;ampersand=0026;quotesingle=0027;quoteright=2019;quoteleft=2018;
parenleft=0028;parenright=0029;asterisk=002A;plus=002B;comma=002C;hyphen=002D;period=002E;slash=002F;fraction=2044;percent=0025;
zero=0030;one=0031;two=0032;three=0033;four=0034;five=0035;six=0036;seven=0037;eight=0038;nine=0039;
colon=003A;semicolon=003B;less=003C;equal=003D;greater=003E;question=003F;at=0040;
bracketleft=005B;backslash=005C;bracketright=005D;asciicircum=005E;underscore=005F;grave=0060;
braceleft=007B;bar=007C;braceright=007D;asciitilde=007E;
nbspace=00A0;exclamdown=00A1;cent=00A2;sterling=00A3;currency=00A4;yen=00A5;brokenbar=00A6;section=00A7;dieresis=00A8;copyright=00A9;
ordfeminine=00AA;guillemotleft=00AB;logicalnot=00AC;softhyphen=00AD;registered=00AE;macron=00AF;degree=00B0;plusminus=00B1;twosuperior=00B2;threesuperior=00B3;
acute=00B4;mu=00B5;paragraph=00B6;periodcentered=00B7;cedilla=00B8;onesuperior=00B9;ordmasculine=00BA;guillemotright=00BB;onequarter=00BC;onehalf=00BD;threequarters=00BE;questiondown=00BF;
Agrave=00C0;Aacute=00C1;Acircumflex=00C2;Atilde=00C3;Adieresis=00C4;Aring=00C5;AE=00C6;Ccedilla=00C7;Egrave=00C8;Eacute=00C9;Ecircumflex=00CA;Edieresis=00CB;
Igrave=00CC;Iacute=00CD;Icircumflex=00CE;Idieresis=00CF;Eth=00D0;Ntilde=00D1;Ograve=00D2;Oacute=00D3;Ocircumflex=00D4;Otilde=00D5;Odieresis=00D6;multiply=00D7;Oslash=00D8;
Ugrave=00D9;Uacute=00DA;Ucircumflex=00DB;Udieresis=00DC;Yacute=00DD;Thorn=00DE;germandbls=00DF;
agrave=00E0;aacute=00E1;acircumflex=00E2;atilde=00E3;adieresis=00E4;aring=00E5;ae=00E6;ccedilla=00E7;egrave=00E8;eacute=00E9;ecircumflex=00EA;edieresis=00EB;
igrave=00EC;iacute=00ED;icircumflex=00EE;idieresis=00EF;eth=00F0;ntilde=00F1;ograve=00F2;oacute=00F3;ocircumflex=00F4;otilde=00F5;odieresis=00F6;divide=00F7;oslash=00F8;
ugrave=00F9;uacute=00FA;ucircumflex=00FB;udieresis=00FC;yacute=00FD;thorn=00FE;ydieresis=00FF;
dotlessi=0131;Lslash=0141;lslash=0142;OE=0152;oe=0153;Scaron=0160;scaron=0161;Ydieresis=0178;Zcaron=017D;zcaron=017E;
Aogonek=0104;aogonek=0105;Cacute=0106;cacute=0107;Ccaron=010C;ccaron=010D;Dcaron=010E;dcaron=010F;Dcroat=0110;dcroat=0111;Eogonek=0118;eogonek=0119;
Lcaron=013D;lcaron=013E;Nacute=0143;nacute=0144;Ncaron=0147;ncaron=0148;Racute=0154;racute=0155;Rcaron=0158;rcaron=0159;Sacute=015A;sacute=015B;
Scedilla=015E;scedilla=015F;Tcaron=0164;tcaron=0165;Uring=016E;uring=016F;Uhungarumlaut=0170;uhungarumlaut=0171;Zacute=0179;zacute=017A;Zdotaccent=017B;zdotaccent=017C;
Ohungarumlaut=0150;ohungarumlaut=0151;
ff=FB00;fi=FB01;fl=FB02;ffi=FB03;ffl=FB04;
dagger=2020;daggerdbl=2021;bullet=2022;ellipsis=2026;perthousand=2030;guilsinglleft=2039;guilsinglright=203A;
quotedblleft=201C;quotedblright=201D;quotedblbase=201E;quotesinglbase=201A;endash=2013;emdash=2014;minus=2212;
florin=0192;Euro=20AC;trademark=2122;lozenge=25CA;dotaccent=02D9;ring=02DA;ogonek=02DB;caron=02C7;breve=02D8;hungarumlaut=02DD;circumflex=02C6;tilde=02DC;
Delta=2206;Omega=2126;pi=03C0;partialdiff=2202;summation=2211;product=220F;integral=222B;radical=221A;infinity=221E;
notequal=2260;lessequal=2264;greaterequal=2265;approxequal=2248;apple=F8FF;
`;
  for (const item of data.split(';')) {
    const s = item.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const name = s.slice(0, eq), hex = s.slice(eq + 1);
    const units = [];
    for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.substr(i, 4), 16));
    if (units.length) t[name] = String.fromCharCode(...units);
  }
  return t;
})();

/** 字形名 → Unicode（含 uniXXXX / uXXXXXX / 常见 CJK 名） */
function glyphToUnicode(name) {
  if (!name) return null;
  const direct = GLYPH_TABLE[name];
  if (direct !== undefined) return direct;
  let m = /^uni([0-9A-Fa-f]{4})([0-9A-Fa-f]{4})?$/.exec(name);
  if (m) {
    const a = parseInt(m[1], 16);
    const b = m[2] ? parseInt(m[2], 16) : null;
    return b === null || b === 0 ? String.fromCharCode(a) : String.fromCharCode(a, b);
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
    return String.fromCodePoint(cp);
  }
  if (/^g\d+$/.test(name) || /^cid\d+$/.test(name) || /^index\d+$/.test(name) || /^glyph\d+$/.test(name)) return null;
  return null;
}

/* =========================================================================
 * 6. 编码表
 * ========================================================================= */

function buildEncoding(names) {
  const t = new Array(256).fill(null);
  for (let i = 0; i < 256; i++) {
    const n = names[i];
    if (!n) continue;
    const u = GLYPH_TABLE[n] !== undefined ? GLYPH_TABLE[n] : glyphToUnicode(n);
    if (u) t[i] = u;
  }
  return t;
}

/** WinAnsi == cp1252：0x80-0x9F 与 latin1 不同，其余等于 latin1 */
const CP1252_HIGH = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026', 0x86: '\u2020', 0x87: '\u2021',
  0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160', 0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018',
  0x92: '\u2019', 0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014', 0x98: '\u02DC',
  0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153', 0x9E: '\u017E', 0x9F: '\u0178'
};

const WIN_ANSI = (() => {
  const t = new Array(256).fill(null);
  for (let i = 0; i < 0x80; i++) t[i] = String.fromCharCode(i);
  for (const k of Object.keys(CP1252_HIGH)) t[+k] = CP1252_HIGH[+k];
  for (let i = 0xa0; i < 0x100; i++) t[i] = String.fromCharCode(i);
  return t;
})();

const MAC_ROMAN_NAMES = ('Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla ' +
  'eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde ' +
  'uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright ' +
  'trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi ' +
  'integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta ' +
  'guillemotleft guillemotright ellipsis nbspace Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright ' +
  'quoteleft quoteright divide lozenge ydieresis Ydieresis fraction Euro guilsinglleft guilsinglright fi fl daggerdbl ' +
  'periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex ' +
  'Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve ' +
  'dotaccent ring cedilla hungarumlaut ogonek caron').split(/\s+/);

const MAC_ROMAN = (() => {
  const names = new Array(256).fill(null);
  for (let i = 0; i < 0x80; i++) names[i] = String.fromCharCode(i) === ' ' ? 'space' : null;
  for (let i = 0x20; i < 0x7f; i++) {
    const ch = String.fromCharCode(i);
    names[i] = ch === ' ' ? 'space' : (ch === "'" ? 'quotesingle' : (ch === '`' ? 'grave' : ch));
  }
  for (let i = 0; i < 128; i++) names[0x80 + i] = MAC_ROMAN_NAMES[i] || null;
  return buildEncoding(names);
})();

const STANDARD_NAMES = (() => {
  const names = new Array(256).fill(null);
  for (let i = 0x20; i < 0x7f; i++) {
    const ch = String.fromCharCode(i);
    names[i] = ch === ' ' ? 'space' : ch;
  }
  names[0x27] = 'quoteright';
  names[0x60] = 'quoteleft';
  const sparse = {
    0xa1: 'exclamdown', 0xa2: 'cent', 0xa3: 'sterling', 0xa4: 'fraction', 0xa5: 'yen', 0xa6: 'florin', 0xa7: 'section',
    0xa8: 'currency', 0xa9: 'quotesingle', 0xaa: 'quotedblleft', 0xab: 'guillemotleft', 0xac: 'guilsinglleft',
    0xad: 'guilsinglright', 0xae: 'fi', 0xaf: 'fl', 0xb1: 'endash', 0xb2: 'dagger', 0xb3: 'daggerdbl',
    0xb4: 'periodcentered', 0xb6: 'paragraph', 0xb7: 'bullet', 0xb8: 'quotesinglbase', 0xb9: 'quotedblbase',
    0xba: 'quotedblright', 0xbb: 'guillemotright', 0xbc: 'ellipsis', 0xbd: 'perthousand', 0xbf: 'questiondown',
    0xc1: 'grave', 0xc2: 'acute', 0xc3: 'circumflex', 0xc4: 'tilde', 0xc5: 'macron', 0xc6: 'breve', 0xc7: 'dotaccent',
    0xc8: 'dieresis', 0xca: 'ring', 0xcb: 'cedilla', 0xcd: 'hungarumlaut', 0xce: 'ogonek', 0xcf: 'caron',
    0xd0: 'emdash', 0xe1: 'AE', 0xe3: 'ordfeminine', 0xe8: 'Lslash', 0xe9: 'Oslash', 0xea: 'OE', 0xeb: 'ordmasculine',
    0xf1: 'ae', 0xf5: 'dotlessi', 0xf8: 'lslash', 0xf9: 'oslash', 0xfa: 'oe', 0xfb: 'germandbls'
  };
  for (const k of Object.keys(sparse)) names[+k] = sparse[k];
  return buildEncoding(names);
})();

const PDFDOC_NAMES = (() => {
  const names = new Array(256).fill(null);
  for (let i = 0x20; i < 0x7f; i++) names[i] = String.fromCharCode(i) === ' ' ? 'space' : String.fromCharCode(i);
  const sparse = {
    0x18: 'breve', 0x19: 'caron', 0x1a: 'circumflex', 0x1b: 'tilde', 0x1c: 'macron', 0x1d: 'dotaccent', 0x1e: 'ring', 0x1f: 'cedilla',
    0x80: 'bullet', 0x81: 'dagger', 0x82: 'daggerdbl', 0x83: 'ellipsis', 0x84: 'emdash', 0x85: 'endash', 0x86: 'florin',
    0x87: 'fraction', 0x88: 'guilsinglleft', 0x89: 'guilsinglright', 0x8a: 'minus', 0x8b: 'perthousand', 0x8c: 'quotedblbase',
    0x8d: 'quotedblleft', 0x8e: 'quotedblright', 0x8f: 'quoteleft', 0x90: 'quoteright', 0x91: 'quotesinglbase',
    0x92: 'trademark', 0x93: 'fi', 0x94: 'fl', 0x95: 'Lslash', 0x96: 'OE', 0x97: 'Scaron', 0x98: 'Ydieresis',
    0x99: 'Zcaron', 0x9a: 'dotlessi', 0x9b: 'lslash', 0x9c: 'oe', 0x9d: 'scaron', 0x9e: 'zcaron'
  };
  for (const k of Object.keys(sparse)) names[+k] = sparse[k];
  for (let i = 0xa0; i < 0x100; i++) names[i] = String.fromCharCode(i) === '\u00a0' ? 'nbspace' : String.fromCharCode(i);
  return buildEncoding(names);
})();

function baseEncodingTable(name) {
  switch (name) {
    case 'WinAnsiEncoding': return WIN_ANSI;
    case 'MacRomanEncoding': return MAC_ROMAN;
    case 'StandardEncoding': return STANDARD;
    case 'PDFDocEncoding': return PDFDOC_NAMES;
    case 'MacExpertEncoding': return MAC_ROMAN;
    default: return null;
  }
}
const STANDARD = STANDARD_NAMES;

/** 文档信息串：FE FF 开头是 UTF-16BE，否则 PDFDocEncoding */
function decodePdfTextString(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const out = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) { out[i - 2] = buf[i + 1]; out[i - 1] = buf[i]; }
    return out.toString('utf16le').replace(/\u0000+$/, '');
  }
  let s = '';
  for (let i = 0; i < buf.length; i++) s += (PDFDOC_NAMES[buf[i]] || '');
  return s;
}

/* =========================================================================
 * 7. ToUnicode CMap
 * ========================================================================= */

function tokenizeCMap(S) {
  const toks = [];
  let i = 0;
  while (i < S.length) {
    const c = S.charCodeAt(i);
    if (c === 0x3c /* < */) {
      if (S.charCodeAt(i + 1) === 0x3c) { toks.push({ t: '<<' }); i += 2; continue; }
      const j = S.indexOf('>', i);
      toks.push({ t: 'hex', v: S.slice(i + 1, j < 0 ? S.length : j) });
      i = j < 0 ? S.length : j + 1;
    } else if (c === 0x5b) { toks.push({ t: '[' }); i++; }
    else if (c === 0x5d) { toks.push({ t: ']' }); i++; }
    else if (c === 0x2f) {
      let j = i + 1;
      while (j < S.length && !isWhite(S.charCodeAt(j)) && !isDelim(S.charCodeAt(j))) j++;
      toks.push({ t: 'name', v: S.slice(i + 1, j) });
      i = j;
    } else if (c === 0x28 /* ( */) {
      // 字面串（CMap 里常见于 /Registry (Adobe)）：必须整体吃掉，
      // 否则会停在 '(' 上生成空记号、游标不前进 → 死循环 OOM
      let j = i + 1, depth = 1;
      while (j < S.length && depth > 0) {
        const d = S.charCodeAt(j);
        if (d === 0x5c /* \ */) { j += 2; continue; }
        if (d === 0x28) depth++;
        else if (d === 0x29) depth--;
        j++;
      }
      i = j < S.length ? j : S.length;
    } else if (c === 0x25) {
      const j = S.indexOf('\n', i);
      i = j < 0 ? S.length : j + 1;
    } else if (isWhite(c)) i++;
    else {
      let j = i;
      while (j < S.length && !isWhite(S.charCodeAt(j)) && !isDelim(S.charCodeAt(j))) j++;
      if (j === i) { i++; continue; }   // 其余分隔符（> } * ' " 等）：单字符跳过，保证前进
      toks.push({ t: 'op', v: S.slice(i, j) });
      i = j;
    }
  }
  return toks;
}

function hexToCode(hex) {
  const h = hex.replace(/\s+/g, '');
  if (!h) return 0;
  return parseInt(h, 16) || 0;
}
function hexBytes(hex) {
  const h = hex.replace(/\s+/g, '');
  return (h.length + 1) >> 1;
}
/** UTF-16BE 十六进制串 → JS 字符串（自动处理代理对、BOM） */
function hexToUtf16(hex) {
  let h = hex.replace(/\s+/g, '');
  if (!h) return '';
  if (h.length & 1) h += '0';
  const buf = Buffer.from(h, 'hex');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) { out[i] = buf[i + 1]; out[i + 1] = buf[i]; }
  return cleanDest(out.toString('utf16le'));
}

/**
 * 解析 ToUnicode CMap。
 * @returns {{map: Map<number,string>, codeBytes: number}}
 */
function parseCMap(S) {
  const map = new Map();
  const toks = tokenizeCMap(S);
  let codeBytes = 0;
  let i = 0;
  const nextHex = () => (toks[i] && toks[i].t === 'hex') ? toks[i++].v : null;
  const nextOp = () => (toks[i] && toks[i].t === 'op') ? toks[i++].v : null;

  while (i < toks.length) {
    const tk = toks[i];
    if (tk.t === 'op') {
      const op = tk.v;
      i++;
      if (op === 'begincodespacerange') {
        for (;;) {
          skipNothing();
          if (toks[i] && toks[i].t === 'op' && toks[i].v === 'endcodespacerange') { i++; break; }
          const lo = nextHex();
          if (lo === null) { if (toks[i]) i++; else break; continue; }
          const hi = nextHex();
          if (hi === null) break;
          if (!codeBytes) codeBytes = hexBytes(lo) || 1;
        }
      } else if (op === 'beginbfchar') {
        for (;;) {
          if (toks[i] && toks[i].t === 'op' && toks[i].v === 'endbfchar') { i++; break; }
          const src = nextHex();
          if (src === null) { if (toks[i]) i++; else break; continue; }
          const code = hexToCode(src);
          if (toks[i] && toks[i].t === '[') {           // 极少见：<src> [<d1> <d2>]
            i++;
            const arr = [];
            while (toks[i] && toks[i].t !== ']') { if (toks[i].t === 'hex') arr.push(hexToUtf16(toks[i].v)); i++; }
            if (toks[i]) i++;
            if (arr.length) map.set(code, arr[0]);
          } else {
            const dst = nextHex();
            if (dst === null) break;
            map.set(code, hexToUtf16(dst));
          }
          if (!codeBytes) codeBytes = hexBytes(src);
        }
      } else if (op === 'beginbfrange') {
        for (;;) {
          if (toks[i] && toks[i].t === 'op' && toks[i].v === 'endbfrange') { i++; break; }
          const loH = nextHex();
          if (loH === null) { if (toks[i]) i++; else break; continue; }
          const hiH = nextHex();
          if (hiH === null) break;
          const lo = hexToCode(loH), hi = hexToCode(hiH);
          if (!codeBytes) codeBytes = hexBytes(loH);
          if (toks[i] && toks[i].t === '[') {           // 数组形式：一一对应
            i++;
            let code = lo;
            while (toks[i] && toks[i].t !== ']') {
              if (toks[i].t === 'hex') { map.set(code, hexToUtf16(toks[i].v)); code++; }
              i++;
            }
            if (toks[i]) i++;
          } else {
            const dstH = nextHex();
            if (dstH === null) break;
            let h = dstH.replace(/\s+/g, '');
            if (h.length & 1) h += '0';
            const dstBuf = Buffer.from(h, 'hex');
            const units = [];
            for (let k = 0; k + 1 < dstBuf.length; k += 2) units.push((dstBuf[k] << 8) | dstBuf[k + 1]);
            if (!units.length) units.push(0);
            const span = Math.min(hi - lo, 65535);
            for (let k = 0; k <= span; k++) {
              const u = units.slice();
              u[u.length - 1] += k;
              let s = '';
              for (const x of u) s += String.fromCharCode(x & 0xffff);
              map.set(lo + k, cleanDest(s));
            }
          }
        }
      }
      continue;
    }
    i++;
  }
  if (!codeBytes) codeBytes = 2;
  return { map, codeBytes };

  function skipNothing() { }
}

/* =========================================================================
 * 8. 字体
 * ========================================================================= */

function parseWidthsArray(doc, arrNode, firstChar) {
  const widths = new Array(256).fill(null);
  if (!arrNode || arrNode.t !== 'arr') return widths;
  for (let i = 0; i < arrNode.v.length; i++) {
    const n = asNum(doc.resolve(arrNode.v[i]));
    if (n !== null) {
      const code = firstChar + i;
      if (code >= 0 && code < 256) widths[code] = n;
    }
  }
  return widths;
}

function createFont(doc, fd) {
  const info = {
    composite: false,
    codeBytes: 2,
    map: null,           // composite: Map；simple: 256 数组
    wmap: null,          // composite
    widths: null,        // simple
    dw: 1000,
    missingWidth: 500,
    hasWidths: false,
    cmapName: ''
  };

  // ---- ToUnicode ----
  const tu = doc.resolve(fd.get('ToUnicode'));
  if (tu && tu.t === 'stream') {
    const text = doc.streamText(tu);
    if (text) {
      try {
        const cm = parseCMap(text);
        if (cm.map.size) {
          info.toUnicode = cm.map;
          info.tuCodeBytes = cm.codeBytes;
          // 有些国产排版工具（方正系）导出的 ToUnicode 是坏的：ASCII 码位被映到
          // CJK/PUA 区，抽出来就是「犐犆犛」这种鬼东西（本该是 ICS）。数一数。
          let bad = 0;
          for (const [code, ch] of cm.map) {
            if (code >= 0x20 && code <= 0x7e) {
              const c = ch.codePointAt(0);
              if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0xe000 && c <= 0xf8ff)) bad++;
            }
          }
          if (bad >= 5) doc._badToUnicode = (doc._badToUnicode || 0) + 1;
        }
      } catch (e) { /* 坏 CMap 忽略 */ }
    }
  }

  const subtype = asName(doc.resolve(fd.get('Subtype'))) || '';
  const isType0 = subtype === 'Type0' || fd.get('DescendantFonts') !== undefined;

  if (isType0) {
    info.composite = true;
    let encName = asName(doc.resolve(fd.get('Encoding')));
    const encDict = doc.resolve(fd.get('Encoding'));
    if (!encName && encDict && encDict.t === 'dict') encName = asName(doc.resolve(encDict.v.get('CMapName')));
    info.cmapName = encName || 'Identity-H';
    // 代码字节数：优先 CMap 的 codespace，其次名字
    if (info.toUnicode && info.tuCodeBytes) info.codeBytes = info.tuCodeBytes;
    else if (/^Identity-[HV]$/.test(info.cmapName) || /^Uni[A-Z]+-UCS2/.test(info.cmapName) || /^UniJIS|^UniGB|^UniCNS|^UniKS/.test(info.cmapName)) info.codeBytes = 2;
    else info.codeBytes = 2;
    info.map = info.toUnicode || null;
    // 复合字体没有 ToUnicode：抽出来的字只能猜（方正/国标类 PDF 极常见），
    // 记一笔，最后给用户一句诚实提醒 —— 不然中文会静默变成乱码。
    if (!info.toUnicode) doc._noUnicodeFonts = (doc._noUnicodeFonts || 0) + 1;

    const desc = doc.resolve(fd.get('DescendantFonts'));
    let cid = null;
    if (desc && desc.t === 'arr' && desc.v.length) cid = doc.resolve(desc.v[0]);
    info.wmap = new Map();
    if (cid && cid.t === 'dict') {
      const dw = asNum(doc.resolve(cid.v.get('DW')));
      if (dw !== null) info.dw = dw;
      const W = doc.resolve(cid.v.get('W'));
      if (W && W.t === 'arr') {
        info.hasWidths = true;
        const a = W.v;
        let i = 0;
        while (i < a.length) {
          const c0 = asNum(doc.resolve(a[i]));
          if (c0 === null) { i++; continue; }
          const nx = doc.resolve(a[i + 1]);
          if (nx && nx.t === 'arr') {
            for (let k = 0; k < nx.v.length; k++) {
              const w = asNum(doc.resolve(nx.v[k]));
              if (w !== null) info.wmap.set(c0 + k, w);
            }
            i += 2;
          } else {
            const c1 = asNum(nx);
            const w = asNum(doc.resolve(a[i + 2]));
            if (c1 === null || w === null) { i++; continue; }
            for (let c = c0; c <= c1 && c - c0 < 65536; c++) info.wmap.set(c, w);
            i += 3;
          }
        }
      } else {
        info.hasWidths = true;   // 有 /DW 默认宽度即可用
      }
    }
    return info;
  }

  // ---- 简单字体（Type1 / TrueType / MMType1 / Type3）----
  const enc = doc.resolve(fd.get('Encoding'));
  let baseName = 'WinAnsiEncoding';
  if (enc && enc.t === 'name') baseName = enc.v;
  else if (enc && enc.t === 'dict') {
    const b = asName(doc.resolve(enc.v.get('BaseEncoding')));
    if (b) baseName = b;
  }
  const base = baseEncodingTable(baseName) || WIN_ANSI;
  const out = new Array(256).fill(null);
  for (let i = 0; i < 256; i++) out[i] = base[i] || null;
  if (enc && enc.t === 'dict') {
    const diffs = doc.resolve(enc.v.get('Differences'));
    if (diffs && diffs.t === 'arr') {
      let code = 0;
      for (const item of diffs.v) {
        const r = doc.resolve(item);
        if (!r) continue;
        if (r.t === 'num') code = r.v;
        else if (r.t === 'name') {
          if (code >= 0 && code < 256) out[code] = glyphToUnicode(r.v) || '?';
          code++;
        }
      }
    }
  }
  if (info.toUnicode) {
    for (let i = 0; i < 256; i++) {
      const u = info.toUnicode.get(i);
      if (u !== undefined) out[i] = u;
    }
  }
  info.map = out;

  const firstChar = asNum(doc.resolve(fd.get('FirstChar')));
  const widthsNode = doc.resolve(fd.get('Widths'));
  if (widthsNode && widthsNode.t === 'arr' && firstChar !== null) {
    info.widths = parseWidthsArray(doc, widthsNode, firstChar);
    info.hasWidths = true;
  }
  const fdesc = doc.resolve(fd.get('FontDescriptor'));
  if (fdesc && fdesc.t === 'dict') {
    const mw = asNum(doc.resolve(fdesc.v.get('MissingWidth')));
    if (mw !== null) info.missingWidth = mw;
    const w = asNum(doc.resolve(fdesc.v.get('Widths')));  // 少见，忽略
    if (widthsNode === undefined && asNum(doc.resolve(fdesc.v.get('MissingWidth'))) !== null) info.hasWidths = true;
    void w;
  }
  return info;
}

function GLYPH_FOR_BYTE(i) {
  // 32..126 直接用字符名自映射（GLYPH_TABLE 已含 A-Z a-z 0-9，其余靠这里兜底）
  const ch = String.fromCharCode(i);
  if (ch === ' ') return 'space';
  if (/[A-Za-z0-9]/.test(ch)) return ch;
  const alias = {
    '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', '$': 'dollar', '%': 'percent', '&': 'ampersand',
    "'": 'quotesingle', '(': 'parenleft', ')': 'parenright', '*': 'asterisk', '+': 'plus', ',': 'comma',
    '-': 'hyphen', '.': 'period', '/': 'slash', ':': 'colon', ';': 'semicolon', '<': 'less', '=': 'equal',
    '>': 'greater', '?': 'question', '@': 'at', '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright',
    '^': 'asciicircum', '_': 'underscore', '`': 'grave', '{': 'braceleft', '|': 'bar', '}': 'braceright', '~': 'asciitilde'
  };
  return alias[ch] || null;
}

/** 按字体把字节串解成 [{ch, code, w}]（w 单位 1/1000 em，可能为 null） */
function decodeRuns(doc, font, buf) {
  const runs = [];
  if (!font) {
    for (let i = 0; i < buf.length; i++) runs.push({ ch: String.fromCharCode(buf[i]) || '', code: buf[i], w: null });
    return runs;
  }
  if (font.composite) {
    const n = font.codeBytes || 2;
    for (let i = 0; i + n <= buf.length; i += n) {
      let code = 0;
      for (let k = 0; k < n; k++) code = (code << 8) | buf[i + k];
      let ch;
      if (font.map) ch = font.map.get(code);
      if (ch === undefined) ch = compositeFallback(font, code);
      runs.push({ ch: ch || '', code, w: cidWidth(font, code) });
    }
    return runs;
  }
  for (let i = 0; i < buf.length; i++) {
    const code = buf[i];
    let ch = font.map ? font.map[code] : null;
    if (ch === null || ch === undefined) ch = '?';
    runs.push({ ch, code, w: simpleWidth(font, code) });
  }
  return runs;
}

function compositeFallback(font, code) {
  const name = font.cmapName || '';
  // UniXXX-UCS2-H/V：码本身就是 Unicode 值（实践中成立）
  if (/^Uni[A-Z]+-UCS2/.test(name)) {
    if (code >= 0x20) return String.fromCharCode(code);
    return '';
  }
  if (/^Identity-[HV]$/.test(name)) {
    if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);   // ASCII 子集常常没进 ToUnicode
    return '';
  }
  if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
  return '';
}

function cidWidth(font, code) {
  if (font.wmap) {
    const w = font.wmap.get(code);
    if (w !== undefined) return w;
  }
  return font.dw;
}
function simpleWidth(font, code) {
  if (font.widths && font.widths[code] !== null && font.widths[code] !== undefined) return font.widths[code];
  const ch = font.map ? font.map[code] : null;
  if (ch === undefined || ch === null) return font.missingWidth;
  return font.missingWidth;
}

/* =========================================================================
 * 9. 内容流 → 文本
 * ========================================================================= */

const TJ_SPACE_EM = 0.15;      // TJ 数字间距超过 0.15 em 视为词间空格（1em=1000；Word/Skia 的空格都 >200）
const POS_GAP_EM = 0.25;       // 两段文字起点位置差超过 0.25 em 视为有空格（需要真实 /Widths 才启用）
const LINE_Y_EM = 0.35;        // 纵坐标变化超过 0.35 em 视为换行

function isCjkChar(ch) {
  if (!ch) return false;
  const c = ch.codePointAt(0);
  return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) ||
         (c >= 0xff00 && c <= 0xffef) || (c >= 0x20000 && c <= 0x3ffff);
}
function isSpaceChar(ch) { return !!ch && /^[\s\u00a0]$/.test(ch); }

function matMul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]
  ];
}

function extractPageText(doc, pageDict, resources, limits) {
  const lines = [];
  let parts = [];
  let lastChar = '';
  let pendingGap = 0;

  const fonts = new Map();
  const xobjects = new Map();

  const st = {
    ctm: [1, 0, 0, 1, 0, 0],
    stack: [],
    tm: [1, 0, 0, 1, 0, 0],
    tlm: [1, 0, 0, 1, 0, 0],
    fontSize: 0,
    hScale: 1,
    charSpacing: 0,
    wordSpacing: 0,
    leading: 0,
    font: null,
    inText: false
  };
  let curX = 0, curY = 0, lineStarted = false;
  /* 换行只在「真有字要写」的那一刻判断：拿这个字的位置跟当前这一行的基线比。
   * 不能在定位算子（Td/Tm/T*）里断行 —— 中文期刊排版（方正/书版那套）把每个字形
   * 单独放进一个 BT…Tj…T*…ET：那个 T* 纯粹是装饰（后面紧跟 ET，不写字），
   * 但它已经把基线挪下去了，随后下一个字形的 Tm 又挪回同一 y。按定位断行的话
   * 整页会变成一个字符一行（实测：58249 字的指南抽成 29129 行）。
   * 用「垂直于基线方向的距离」判断，竖排/旋转页面也不会误判。 */
  let lineX = 0, lineY = 0, lineDir = [1, 0];

  function endLine() {
    const t = parts.join('').replace(/[ \t]+$/, '');
    parts = [];
    lastChar = '';
    if (t) lines.push(t);
  }
  function emit(s) {
    if (!s) return;
    const m = trm();
    const fsDev = Math.max((st.fontSize || 12) * deviceScale(), 1);
    const len = Math.hypot(m[0], m[1]) || 1;
    const dx = m[0] / len, dy = m[1] / len;
    if (parts.length) {
      const perp = Math.abs((m[4] - lineX) * -dy + (m[5] - lineY) * dx);
      const turned = Math.abs(dx * lineDir[1] - dy * lineDir[0]) > 0.02;
      if (perp > Math.max(fsDev * LINE_Y_EM, 0.5) || turned) { endLine(); pendingGap = 0; }
    }
    if (!parts.length) { lineX = m[4]; lineY = m[5]; lineDir = [dx, dy]; }
    parts.push(s);
    lastChar = s[s.length - 1];
  }
  function emitSpace() {
    if (!parts.length) return;
    if (isSpaceChar(lastChar)) return;
    parts.push(' ');
    lastChar = ' ';
  }
  function maybeGapSpace(prevCh, nextCh, emGap) {
    if (emGap < TJ_SPACE_EM) return;
    if (!prevCh || !nextCh) return;
    if (isSpaceChar(prevCh) || isSpaceChar(nextCh)) return;
    if (isCjkChar(prevCh) && isCjkChar(nextCh)) return;   // CJK 之间的负间距多是排版补偿，不是空格
    emitSpace();
  }

  function trm() { return matMul(st.tm, st.ctm); }
  function deviceScale() {
    const d = Math.abs(st.ctm[0] * st.ctm[3] - st.ctm[1] * st.ctm[2]);
    return Math.sqrt(d) || 1;
  }

  function onPosition() {
    const t = trm();
    const x = t[4], y = t[5];
    const fsDev = Math.max((st.fontSize || 12) * deviceScale(), 1);
    if (!lineStarted) { curX = x; curY = y; lineStarted = true; pendingGap = 0; return; }
    if (Math.abs(y - curY) > Math.max(fsDev * LINE_Y_EM, 0.5)) {
      /* 只清掉段内间距；要不要断行交给 emit() 拿真实字形位置判断 */
      curX = x; curY = y; pendingGap = 0;
      return;
    }
    const gap = x - curX;
    if (gap > 0 && gap < fsDev * 4) pendingGap = Math.max(pendingGap, gap);
    else pendingGap = 0;
    curX = x; curY = y;
  }

  function advance(emWidth, code) {
    let dx = ((emWidth === null || emWidth === undefined ? 500 : emWidth) / 1000) * (st.fontSize || 12);
    dx += st.charSpacing;
    if (code === 32) dx += st.wordSpacing;
    dx *= st.hScale;
    const t = trm();
    curX += dx * t[0];
    curY += dx * t[1];
  }

  function showString(buf) {
    const runs = decodeRuns(doc, st.font, buf);
    const fsDev = Math.max((st.fontSize || 12) * deviceScale(), 1);
    for (const r of runs) {
      if (r.ch) {
        if (pendingGap > 0 && st.font && st.font.hasWidths && pendingGap > fsDev * POS_GAP_EM) {
          maybeGapSpace(lastChar, r.ch, (pendingGap / fsDev) * 1);
        }
        pendingGap = 0;
        emit(r.ch);
      }
      advance(r.w, r.code);
    }
  }

  function showArray(arr) {
    const fsDev = Math.max((st.fontSize || 12) * deviceScale(), 1);
    const items = arr.v;
    for (let i = 0; i < items.length; i++) {
      const it = doc.resolve(items[i]);
      if (!it) continue;
      if (it.t === 'str') { showString(it.b); continue; }
      if (it.t === 'num') {
        const gapEm = -it.v / 1000;
        const t = trm();
        curX += gapEm * st.fontSize * st.hScale * t[0];
        curY += gapEm * st.fontSize * st.hScale * t[1];
        // 找下一个字符串的第一个字符，用于判断「两边都是 CJK」的情况
        let next = null, prev = lastChar;
        for (let k = i + 1; k < items.length && !next; k++) {
          const nx = doc.resolve(items[k]);
          if (nx && nx.t === 'str') {
            const rr = decodeRuns(doc, st.font, nx.b);
            next = rr.length ? rr[0].ch : null;
          }
        }
        const emGap = Math.abs(gapEm);
        if (emGap > 0 && prev && next) maybeGapSpace(prev, next, emGap);
        else if (emGap >= TJ_SPACE_EM && fsDev) pendingGap = 0;
      }
    }
  }

  /* ---- 资源 ---- */
  function fontFor(name) {
    if (fonts.has(name)) return fonts.get(name);
    let f = null;
    const fd = resources ? doc.resolve(resources.get('Font')) : null;
    if (fd && fd.t === 'dict') {
      const node = doc.resolve(fd.v.get(name));
      if (node && node.t === 'dict') {
        try { f = createFont(doc, node.v); } catch (e) { f = null; }
      }
    }
    fonts.set(name, f);
    return f;
  }
  function xobjectFor(name) {
    const xo = resources ? doc.resolve(resources.get('XObject')) : null;
    if (!xo || xo.t !== 'dict') return null;
    const node = doc.resolve(xo.v.get(name));
    if (node && node.t === 'stream') return node;
    return null;
  }

  /* ---- 内容流解释 ---- */
  function runContent(text, depth) {
    const end = text.length;
    const lex = { S: text, i: 0 };
    const stack = [];
    let guard = 0;
    while (lex.i < end) {
      if (++guard > 3000000) break;
      skipWs(lex, end);
      if (lex.i >= end) break;
      const c = text.charCodeAt(lex.i);
      let v;
      if (c === 0x2f || c === 0x28 || c === 0x3c || c === 0x5b || isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) {
        v = parseValue(lex, end);
        if (v === null) break;
        if (v.t !== 'kw') {
          stack.push(v);
          if (stack.length > 64) stack.shift();
          continue;
        }
      } else {
        const start = lex.i;
        while (lex.i < end) {
          const d = text.charCodeAt(lex.i);
          if (isWhite(d) || isDelim(d)) break;
          lex.i++;
        }
        if (lex.i === start) { lex.i++; continue; }
        v = { t: 'kw', v: text.slice(start, lex.i) };
      }
      const op = v.v;
      handleOp(op, stack, text, lex, end, depth);
      stack.length = 0;
    }
  }

  function handleOp(op, stack, text, lex, end, depth) {
    const num = (i) => { const v = stack[i]; return v && v.t === 'num' ? v.v : null; };
    const nameOf = (i) => { const v = stack[i]; return v && v.t === 'name' ? v.v : null; };
    switch (op) {
      case 'BT':
        st.tm = [1, 0, 0, 1, 0, 0];
        st.tlm = [1, 0, 0, 1, 0, 0];
        st.inText = true;
        // 注意：这里**不能**重置 lineStarted/curX/curY。
        // Word/WPS/Chrome 常常为每一小段文字开一个 BT…ET，段落与表格行的
        // 换行只能靠「新位置与上一处文字的设备坐标 Y 差」判断，一旦在 BT 里
        // 清掉基准点，整页文字就会被拼成一行。
        pendingGap = 0;
        break;
      case 'ET':
        st.inText = false;
        break;
      case 'Tf': {
        const nm = nameOf(0);
        const size = num(1);
        if (nm !== null) st.font = fontFor(nm);
        if (size !== null) st.fontSize = size;
        break;
      }
      case 'TL': { const l = num(0); if (l !== null) st.leading = l; break; }
      case 'Tc': { const l = num(0); if (l !== null) st.charSpacing = l; break; }
      case 'Tw': { const l = num(0); if (l !== null) st.wordSpacing = l; break; }
      case 'Tz': { const l = num(0); if (l !== null) st.hScale = l / 100; break; }
      case 'Ts': break;
      case 'Tr': break;
      case 'Td': {
        const tx = num(0), ty = num(1);
        if (tx !== null && ty !== null) {
          st.tlm = matMul([1, 0, 0, 1, tx, ty], st.tlm);
          st.tm = st.tlm.slice();
          onPosition();
        }
        break;
      }
      case 'TD': {
        const tx = num(0), ty = num(1);
        if (tx !== null && ty !== null) {
          st.leading = -ty;
          st.tlm = matMul([1, 0, 0, 1, tx, ty], st.tlm);
          st.tm = st.tlm.slice();
          onPosition();
        }
        break;
      }
      case 'Tm': {
        const a = num(0), b = num(1), c2 = num(2), d = num(3), e = num(4), f = num(5);
        if (a !== null && b !== null && c2 !== null && d !== null && e !== null && f !== null) {
          st.tm = [a, b, c2, d, e, f];
          st.tlm = st.tm.slice();
          onPosition();
        }
        break;
      }
      case 'T*': {
        st.tlm = matMul([1, 0, 0, 1, 0, -st.leading], st.tlm);
        st.tm = st.tlm.slice();
        onPosition();
        break;
      }
      case 'Tj': {
        const s = stack[0];
        if (s && s.t === 'str') showString(s.b);
        break;
      }
      case "'": {
        st.tlm = matMul([1, 0, 0, 1, 0, -st.leading], st.tlm);
        st.tm = st.tlm.slice();
        onPosition();
        const s = stack[0];
        if (s && s.t === 'str') showString(s.b);
        break;
      }
      case '"': {
        const aw = num(0), ac = num(1), s = stack[2];
        if (aw !== null) st.wordSpacing = aw;
        if (ac !== null) st.charSpacing = ac;
        st.tlm = matMul([1, 0, 0, 1, 0, -st.leading], st.tlm);
        st.tm = st.tlm.slice();
        onPosition();
        if (s && s.t === 'str') showString(s.b);
        break;
      }
      case 'TJ': {
        const arr = stack[0];
        if (arr && arr.t === 'arr') showArray(arr);
        break;
      }
      case 'q':
        st.stack.push({ ctm: st.ctm.slice() });
        break;
      case 'Q': {
        const s = st.stack.pop();
        if (s) st.ctm = s.ctm;
        break;
      }
      case 'cm': {
        const a = num(0), b = num(1), c2 = num(2), d = num(3), e = num(4), f = num(5);
        if (a !== null && b !== null && c2 !== null && d !== null && e !== null && f !== null) {
          st.ctm = matMul([a, b, c2, d, e, f], st.ctm);
        }
        break;
      }
      case 'BI':
        lex.i = skipInlineImage(text, lex.i, end);
        break;
      case 'Do': {
        const nm = nameOf(0);
        if (nm === null || depth >= 4) break;
        const xo = xobjectFor(nm);
        if (!xo) break;
        const sub = asName(doc.resolve(xo.v.get('Subtype')));
        if (sub !== 'Form') break;
        const data = doc.streamData(xo);
        if (!data) break;
        const saved = {
          ctm: st.ctm, stack: st.stack, tm: st.tm, tlm: st.tlm, font: st.font,
          fontSize: st.fontSize, hScale: st.hScale, leading: st.leading,
          charSpacing: st.charSpacing, wordSpacing: st.wordSpacing
        };
        const m = doc.resolve(xo.v.get('Matrix'));
        let mm = [1, 0, 0, 1, 0, 0];
        if (m && m.t === 'arr' && m.v.length === 6) {
          const got = m.v.map((x) => asNum(doc.resolve(x)));
          if (got.every((x) => x !== null)) mm = got;
        }
        st.ctm = matMul(mm, st.ctm);
        st.stack = [];
        const fRes = doc.resolve(xo.v.get('Resources'));
        const savedRes = resources;
        if (fRes && fRes.t === 'dict') resources = fRes.v;
        // 不重置 curX/curY/lineStarted：Form 的 /Matrix 已经并入 ctm，
        // 它里面的 Tm 算出来的仍是同一套设备坐标，可与外部文字比较换行。
        runContent(data.toString('latin1'), depth + 1);
        resources = savedRes;
        Object.assign(st, saved);
        break;
      }
      default:
        break;
    }
  }

  // ---- 取页面内容流 ----
  const contents = doc.resolve(pageDict.get('Contents'));
  const streams = [];
  if (contents) {
    if (contents.t === 'stream') streams.push(contents);
    else if (contents.t === 'arr') {
      for (const c of contents.v) {
        const r = doc.resolve(c);
        if (r && r.t === 'stream') streams.push(r);
      }
    }
  }
  let total = 0;
  for (const s of streams) {
    if (limits && total >= limits.maxCharsPage) break;
    const data = doc.streamData(s);
    if (!data || !data.length) continue;
    total += data.length;
    runContent(data.toString('latin1'), 0);
  }
  endLine();
  return lines.join('\n');
}

function skipInlineImage(text, i, end) {
  // BI ... ID <binary> EI ；二进制里什么都可能有，只能找 "EI" 前后是分隔符的位置
  const id = text.indexOf('ID', i);
  if (id < 0 || id > end) return end;
  let p = id + 2;
  if (p < end && isWhite(text.charCodeAt(p))) p++;
  while (p < end) {
    const e = text.indexOf('EI', p);
    if (e < 0) return end;
    const before = e > 0 ? text.charCodeAt(e - 1) : 0x20;
    const after = e + 2 < end ? text.charCodeAt(e + 2) : 0x20;
    if (isWhite(before) && (isWhite(after) || isDelim(after))) return e + 2;
    p = e + 2;
  }
  return end;
}

/* =========================================================================
 * 10. 页面树
 * ========================================================================= */

function mergeResources(doc, parent, child) {
  const c = doc.resolve(child);
  if (!c || c.t !== 'dict') return parent;
  const cm = c.v;
  if (!parent || parent.size === 0) return cm;
  const out = new Map(parent);
  for (const [k, v] of cm) out.set(k, v);
  return out;
}

function walkPages(doc, node, inherited, out, seen, depth) {
  if (!node || depth > 64 || out.length > 50000) return;
  const d = doc.resolve(node);
  if (!d || d.t !== 'dict') return;
  const num = node.t === 'ref' ? node.num : -1;
  if (num >= 0) { if (seen.has(num)) return; seen.add(num); }
  const type = asName(doc.resolve(d.v.get('Type')));
  const res = mergeResources(doc, inherited, d.v.get('Resources'));
  const kids = doc.resolve(d.v.get('Kids'));
  if (type === 'Pages' || (kids && kids.t === 'arr' && type !== 'Page')) {
    if (kids && kids.t === 'arr') {
      for (const k of kids.v) walkPages(doc, k, res, out, seen, depth + 1);
    }
    return;
  }
  if (type === 'Page' || d.v.get('Contents') !== undefined || d.v.get('MediaBox') !== undefined) {
    out.push({ dict: d.v, resources: res });
  }
}

function collectPages(doc) {
  const seen = new Set();
  const out = [];
  const root = doc.resolve(doc.trailerGet('Root'));
  if (root && root.t === 'dict') {
    const res = mergeResources(doc, new Map(), root.v.get('Resources'));
    walkPages(doc, root.v.get('Pages'), res, out, seen, 0);
  }
  if (out.length) return out;
  // 兜底：/Pages 树坏了 → 按对象号顺序找 /Type /Page
  const nums = [...doc.objects.keys()].sort((a, b) => a - b);
  for (const n of nums) {
    const v = doc.resolve({ t: 'ref', num: n });
    if (!v || v.t !== 'dict') continue;
    if (asName(doc.resolve(v.v.get('Type'))) !== 'Page') continue;
    out.push({ dict: v.v, resources: mergeResources(doc, new Map(), v.v.get('Resources')) });
  }
  return out;
}

/* =========================================================================
 * 11. 对外 API
 * ========================================================================= */

/**
 * 提取 PDF 文本。
 * @param {Buffer} buf 整个 PDF 文件
 * @param {{maxPages?:number, maxChars?:number, pageSeparators?:boolean}} [options]
 * @returns {{text:string, pages:{n:number,text:string}[], meta:object}}
 */
function extractPdfText(buf, options) {
  const opts = options || {};
  if (!Buffer.isBuffer(buf)) {
    // 调用方偶尔会递字符串（比如把二进制文件按 utf8 读成了 string）：按 latin1 还原，
    // 1 字符 == 1 字节，跟直接读文件一样；用 utf8 会把每个高位字节毁掉，抽出来就是空文本。
    if (typeof buf === 'string') buf = Buffer.from(buf, 'latin1');
    else buf = Buffer.from(buf || '');
  }
  if (!buf.length) throw new Error('PDF 文件为空');
  const head = buf.subarray(0, 1024).toString('latin1');
  if (head.indexOf('%PDF-') < 0) throw new Error('不是有效的 PDF 文件（找不到 %PDF- 文件头）');

  const maxPages = opts.maxPages > 0 ? opts.maxPages : 2000;
  const maxChars = opts.maxChars > 0 ? opts.maxChars : 5000000;

  const doc = new PdfDocument(buf);

  const meta = {
    pageCount: 0,
    hasText: false,
    scanned: false,
    encrypted: false,
    producer: '',
    title: '',
    chars: 0,
    truncated: false,
    warnings: doc.errors.slice(0, 20)
  };

  // ---- Info ----
  const info = doc.resolve(doc.trailerGet('Info'));
  if (info && info.t === 'dict') {
    const t = doc.resolve(info.v.get('Title'));
    const p = doc.resolve(info.v.get('Producer'));
    if (t && t.t === 'str') meta.title = decodePdfTextString(t.b).trim();
    if (p && p.t === 'str') meta.producer = decodePdfTextString(p.b).trim();
  }

  // ---- 加密 ----
  const enc = doc.resolve(doc.trailerGet('Encrypt'));
  meta.encrypted = !!(enc && enc.t !== 'null' && enc.t !== 'bool');

  const pages = collectPages(doc);
  const pageCountAll = pages.length;
  const cap = Math.min(pageCountAll, maxPages);
  meta.pageCount = pageCountAll;
  if (pageCountAll > cap) meta.truncated = true;

  const outPages = [];
  let totalChars = 0;
  if (!meta.encrypted) {
    for (let i = 0; i < cap; i++) {
      let text = '';
      try {
        text = extractPageText(doc, pages[i].dict, pages[i].resources, { maxCharsPage: maxChars });
      } catch (e) {
        doc.errors.push('page ' + (i + 1) + ': ' + e.message);
        text = '';
      }
      if (text) {
        outPages.push({ n: i + 1, text });
        totalChars += text.length;
      } else {
        outPages.push({ n: i + 1, text: '' });
      }
      if (totalChars >= maxChars) {
        if (i + 1 < cap) meta.truncated = true;
        break;
      }
    }
  }

  let text;
  if (opts.pageSeparators) {
    text = outPages.map((p) => '===== 第 ' + p.n + ' 页 =====\n' + p.text).join('\n\n');
  } else {
    text = outPages.filter((p) => p.text).map((p) => p.text).join('\n\n');
  }
  text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  meta.chars = text.length;
  meta.hasText = totalChars > 0;
  const effectivePages = outPages.length || 0;
  meta.scanned = !meta.encrypted && effectivePages > 0 && totalChars < effectivePages * 20;
  meta.noUnicodeFonts = doc._noUnicodeFonts || 0;
  meta.badToUnicode = doc._badToUnicode || 0;
  const lost = (text.match(/\?/g) || []).length;
  meta.missingChars = lost;
  meta.missingRatio = text.length ? lost / text.length : 0;
  if (meta.hasText) {
    const pct = Math.round(meta.missingRatio * 100);
    const why = [];
    const weird = (text.match(/[\u7280-\u72ff\ue000-\uf8ff]/g) || []).length;
    meta.weirdChars = weird;
    const weirdRatio = text.length ? weird / text.length : 0;
    // 零星几个怪字无所谓（很多正常 PDF 也有），成片出现才算文字层坏了
    if (weird >= 10 && weirdRatio >= 0.005) why.push('英文、数字被映成了怪字（' + weird + ' 处）');
    if (lost >= 20 && meta.missingRatio >= 0.02) why.push('约 ' + pct + '% 的字符没能还原（问号）');
    if (why.length) {
      meta.warn = '这份 PDF 的文字层本身不可靠：' + why.join('，') + '。'
        + '国产排版（方正/国标类）常见这种字体映射问题，抽出来的中英文会有缺字或乱码 —— '
        + '重要内容请看原文，或用 Word 打开这份 PDF 另存为 .docx / .txt 后再上传。';
    }
  }
  meta.warnings = doc.errors.slice(0, 20);

  return { text, pages: outPages, meta };
}

module.exports = { extractPdfText };

/* =========================================================================
 * 12. CLI：node app/doc/pdf.js <file.pdf> [--json] [--max N] [--pages]
 * ========================================================================= */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const wantJson = argv.includes('--json');
  const wantPages = argv.includes('--pages');
  const mi = argv.indexOf('--max');
  const max = mi >= 0 && argv[mi + 1] ? parseInt(argv[mi + 1], 10) : 4000;

  if (!file) {
    console.error('用法: node pdf.js <file.pdf> [--json] [--max N] [--pages]');
    process.exit(2);
  }
  try {
    const buf = fs.readFileSync(file);
    const r = extractPdfText(buf, {});
    if (wantJson) {
      const out = {
        meta: r.meta,
        pageCount: r.meta.pageCount,
        chars: r.meta.chars,
        firstText: r.text.slice(0, max)
      };
      console.log(JSON.stringify(out, null, 2));
    } else if (wantPages) {
      for (const p of r.pages) console.log('===== 第 ' + p.n + ' 页 =====\n' + p.text.slice(0, max));
    } else {
      console.log(r.text.slice(0, max));
    }
    process.exit(0);
  } catch (e) {
    console.error('提取失败: ' + e.message);
    process.exit(1);
  }
}
