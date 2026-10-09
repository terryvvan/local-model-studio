'use strict';
/* ============================ 图片像素尺寸（只读文件头，不解码像素） ============================
 * 为什么要有这个：模型经常需要「这张图多大」（用户说「按原图尺寸再画一张」之类）。
 * 以前没东西告诉它，它就自己用 PowerShell 去抠 JPEG 字节，靠猜 marker —— 实测把
 * C:\Windows\Web\Wallpaper\ThemeC\img28.jpg（真值 3840×2400）读成了 505×306，
 * 于是画出来的图小得离谱。这里只读文件头，PNG / GIF / BMP / JPEG / WebP 都能拿到真实宽高。
 *
 * sizeOf(buf) → { width, height, format } | null
 * 不认识 / 头不完整 / JPEG 尺寸标记在 SOS 之后（罕见）都返回 null，调用方自己兜底。
 */

function jpegSize(b) {
  let i = 2;                                   // 跳过 SOI(FFD8)
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }      // 容忍标记之间的填充
    let m = b[i + 1];
    if (m === 0xff) { i++; continue; }         // 多字节填充 FF FF …
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }   // 无长度字段的标记
    if (m === 0xda) return null;               // SOS：压缩数据开始，尺寸标记应该在它之前
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    /* SOF0..SOF15 里带帧头（C4=DHT、C8=JPG、CC=DAC 不是） */
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), format: 'jpeg' };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const fourcc = b.toString('latin1', 12, 16);
  if (fourcc === 'VP8X') {                     // 扩展格式：24 位画布尺寸减一
    return {
      width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
      height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      format: 'webp',
    };
  }
  if (fourcc === 'VP8 ') {                     // 有损：帧头后面是 14 位宽高
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, format: 'webp' };
  }
  if (fourcc === 'VP8L') {                     // 无损：位流里 14+14 位
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), format: 'webp' };
  }
  return null;
}

function sizeOf(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 10) return null;
  if (b.length >= 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' && b.toString('latin1', 12, 16) === 'IHDR') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' };
  }
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), format: 'gif' };
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)), format: 'bmp' };
  }
  if (b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return webpSize(b);
  return null;
}

/** 读文件的尺寸（只读前 256 KB 的头，不解码像素）。找不到返回 null。 */
function sizeOfFile(absPath) {
  try {
    const fs = require('fs');
    const fd = fs.openSync(absPath, 'r');
    try {
      const n = Math.min(262144, Math.max(64, fs.fstatSync(fd).size));
      const buf = Buffer.alloc(n);
      const got = fs.readSync(fd, buf, 0, n, 0);
      return sizeOf(buf.subarray(0, got));
    } finally { try { fs.closeSync(fd); } catch (_) {} }
  } catch (_) { return null; }
}

/** {width,height} → '3840×2400 像素' */
function describe(sz) {
  if (!sz || !sz.width || !sz.height) return '';
  return sz.width + '×' + sz.height + ' 像素';
}

module.exports = { sizeOf, sizeOfFile, describe };
