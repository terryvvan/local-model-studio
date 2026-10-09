/* app/doc/zip.js —— 零依赖 ZIP 读写
 *
 * docx / xlsx / pptx 都是 ZIP 包（OOXML），所以「读写常见文档」的第一层就是能把 zip
 * 拆开、装回去。只用 node:zlib 的 inflateRawSync / deflateRawSync，不引任何第三方包
 * —— 这个项目的服务器进程不允许出现 node_modules。
 *
 * 几个刻意的取舍：
 *  - 读：走「中央目录」（End of Central Directory → 逐条 Central Directory Header），
 *    不顺扫本地文件头。写流式 zip 的工具有时把尺寸写进 data descriptor（本地头里是 0），
 *    只有中央目录里的尺寸永远可信。
 *  - 读：支持 filter，避免为了取 word/document.xml 去解压整包几十 MB 的图片
 *    （微信里转出来的 docx 有 20 MB、pptx 有 33 MB，全解压纯属浪费）。
 *  - 写：名字带 UTF-8 标志位（GP bit 11），不写 data descriptor，条目顺序保持传入顺序。
 *    Excel/Word 对这两点都敏感，缺一个就会弹「文件已损坏」。
 */
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_Z64_LOC = 0x07064b50;

/* ------------------------------------------------------------------ CRC32 */
let _crcT = null;
function crcTable() {
  if (_crcT) return _crcT;
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return (_crcT = t);
}
function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------------ 读 */
function findEOCD(buf) {
  const stop = Math.max(0, buf.length - 66000);      // 注释最长 65535
  for (let i = buf.length - 22; i >= stop; i--) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  return -1;
}

/**
 * 解开一个 zip。
 * @param {Buffer} buf
 * @param {{filter?: (name:string)=>boolean, maxEntryBytes?: number}} [opts]
 * @returns {Map<string, Buffer>} 条目名（正斜杠）→ 内容
 */
function unzip(buf, opts) {
  opts = opts || {};
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 包（找不到中央目录）');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  if ((count === 0xffff || cdOff === 0xffffffff) && eocd >= 20) {
    const loc = eocd - 20;                            // ZIP64：EOCD 前 20 字节是 locator
    if (buf.readUInt32LE(loc) === SIG_Z64_LOC) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      if (z64 + 56 <= buf.length && buf.readUInt32LE(z64) === SIG_Z64_EOCD) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOff = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }
  const out = new Map();
  let p = cdOff, n = 0;
  while (p + 46 <= buf.length && (count === 0xffff ? true : n < count)) {
    if (buf.readUInt32LE(p) !== SIG_CD) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + cmtLen;
    n++;
    if (name.endsWith('/')) continue;                 // 目录条目
    if (opts.filter && !opts.filter(name)) continue;
    if (compSize === 0xffffffff || rawSize === 0xffffffff) throw new Error('暂不支持 ZIP64 单条目：' + name);
    if (opts.maxEntryBytes && rawSize > opts.maxEntryBytes) continue;   // 超大媒体直接跳过
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== SIG_LOCAL) throw new Error('本地文件头损坏：' + name);
    const nlen = buf.readUInt16LE(lho + 26), elen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + nlen + elen;
    const comp = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('不支持的压缩方式 ' + method + '（仅 stored/deflate）：' + name);
    out.set(name, Buffer.from(data));                 // 复制一份，别让小条目攥住整个大 buffer
  }
  return out;
}

/* ------------------------------------------------------------------ 写 */
/**
 * 打包成 zip。
 * @param {{name:string, data:Buffer|string, store?:boolean, level?:number}[]} entries
 * @returns {Buffer}
 */
function zip(entries) {
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = String(e.name).replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data == null ? '' : e.data), 'utf8');
    const store = e.store === true || data.length === 0;   // 空文件不能 deflate（会多出 2 字节头）
    const comp = store ? data : zlib.deflateRawSync(data, { level: e.level || 6 });
    const crc = crc32(data);
    const method = store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(20, 4);                 // version needed
    lh.writeUInt16LE(0x0800, 6);             // GP：文件名为 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CD, 0);
    cd.writeUInt16LE(20, 4);                 // version made by（0x14 = MS-DOS/Windows）
    cd.writeUInt16LE(20, 6);                 // version needed
    cd.writeUInt16LE(0x0800, 8);             // GP：UTF-8
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(parts), cdBuf, eocd]);
}

module.exports = { unzip, zip, crc32 };

/* ------------------------------------------------------------------ CLI
 * node app/doc/zip.js a.zip                 列表
 * node app/doc/zip.js a.zip --cat name.xml  打印某个条目（前 4000 字）
 */
if (require.main === module) {
  const fs = require('fs');
  const [file, flag, entry] = process.argv.slice(2);
  if (!file) { console.error('用法: node app/doc/zip.js <a.zip> [--cat <条目名>]'); process.exit(2); }
  try {
    const buf = fs.readFileSync(file);
    const m = unzip(buf, flag === '--cat' ? { filter: (n) => n === entry } : {});
    if (flag === '--cat') {
      const b = m.get(entry);
      if (!b) { console.error('没有这个条目：' + entry); process.exit(1); }
      console.log(b.toString('utf8').slice(0, 4000));
    } else {
      for (const [n, b] of m) console.log(String(b.length).padStart(9) + '  ' + n);
    }
  } catch (e) { console.error('失败：' + (e.message || e)); process.exit(1); }
}
