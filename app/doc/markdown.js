/* app/doc/markdown.js —— 极简 Markdown 解析（够用就好）
 *
 * 只服务两个出口：
 *   - writeDocx 要的 blocks 数组（标题/段落/列表/表格/代码块/分页）
 *   - PDF 与 HTML 导出要的 HTML 片段
 * 不追求 CommonMark 完备（没有引用嵌套、脚注、HTML 内联），但表、代码块、有序表、
 * 粗体/斜体/行内码这些写报告真会用到的语法都在。
 */
const { escapeHtml } = require('./text');

/* ------------------------------------------------------------ → blocks */
/** @returns {{t:'h',level:number,text:string}|{t:'p',text:string}|{t:'li',text:string,ordered:boolean,level:number}|{t:'table',rows:string[][]}|{t:'code',text:string}|{t:'pagebreak'}[]} */
function mdToBlocks(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s);
  const isTableSep = (s) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(s) && /-/.test(s);
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {                       // 代码块
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      blocks.push({ t: 'code', text: buf.join('\n') });
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ t: 'p', text: '────────' }); i++; continue; }
    if (/^\s*\[(pagebreak|分页)\]\s*$/i.test(line)) { blocks.push({ t: 'pagebreak' }); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ t: 'h', level: Math.min(6, h[1].length), text: h[2].trim() }); i++; continue; }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows = [];
      const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      rows.push(cells(line));
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      blocks.push({ t: 'table', rows });
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      blocks.push({ t: 'li', text: li[3].trim(), ordered: /\d/.test(li[2]), level: Math.min(3, Math.floor(li[1].length / 2)) });
      i++; continue;
    }
    // 普通段落：连续非空行拼成一段
    const buf = [line.trim()];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*```/.test(lines[i])
      && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !isTableRow(lines[i])) { buf.push(lines[i].trim()); i++; }
    blocks.push({ t: 'p', text: buf.join(' ') });
  }
  return blocks;
}

/* ------------------------------------------------------------ → HTML */
function inline(s) {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => (/^(https?:|mailto:)/i.test(url) ? '<a href="' + url + '">' + txt + '</a>' : txt));
  return t;
}
/** Markdown → HTML 片段（不含 <html>/<head>，PDF 导出与 .html 导出共用）。 */
function mdToHtml(md) {
  const out = [];
  let list = null;                                     // 'ul' | 'ol'
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  for (const b of mdToBlocks(md)) {
    if (b.t !== 'li') closeList();
    if (b.t === 'h') out.push('<h' + b.level + '>' + inline(b.text) + '</h' + b.level + '>');
    else if (b.t === 'p') out.push('<p>' + inline(b.text) + '</p>');
    else if (b.t === 'code') out.push('<pre><code>' + escapeHtml(b.text) + '</code></pre>');
    else if (b.t === 'pagebreak') out.push('<div class="pagebreak"></div>');
    else if (b.t === 'table') {
      out.push('<table>');
      b.rows.forEach((r, ri) => {
        out.push('<tr>' + r.map((c) => (ri === 0 ? '<th>' : '<td>') + inline(c) + (ri === 0 ? '</th>' : '</td>')).join('') + '</tr>');
      });
      out.push('</table>');
    } else if (b.t === 'li') {
      const want = b.ordered ? 'ol' : 'ul';
      if (list !== want) { closeList(); out.push('<' + want + '>'); list = want; }
      out.push('<li>' + inline(b.text) + '</li>');
    }
  }
  closeList();
  return out.join('\n');
}
/** 完整 HTML 文档（PDF 导出用；样式刻意内联，标题与表格都要好看）。 */
function htmlDocument(title, body, opts) {
  opts = opts || {};
  const fs = opts.fontSize || 14;
  return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>' + escapeHtml(title || '文档') + '</title>\n'
    + '<style>\n'
    + '@page{size:A4;margin:' + (opts.margin || '18mm 16mm') + '}\n'
    + 'body{font-family:"Microsoft YaHei","微软雅黑",Calibri,sans-serif;font-size:' + fs + 'px;line-height:1.7;color:#1a1a1a;margin:0}\n'
    + 'h1{font-size:' + (fs + 10) + 'px;border-bottom:2px solid #333;padding-bottom:6px;margin:0 0 14px}\n'
    + 'h2{font-size:' + (fs + 6) + 'px;margin:20px 0 8px}\n'
    + 'h3{font-size:' + (fs + 3) + 'px;margin:16px 0 6px}\n'
    + 'p{margin:8px 0}\n'
    + 'ul,ol{margin:8px 0 8px 22px;padding:0}\n'
    + 'li{margin:3px 0}\n'
    + 'code{font-family:Consolas,"Courier New",monospace;background:#f2f2f2;padding:1px 4px;border-radius:3px;font-size:' + (fs - 1) + 'px}\n'
    + 'pre{background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:10px;overflow:auto;white-space:pre-wrap}\n'
    + 'pre code{background:none;padding:0}\n'
    + 'table{border-collapse:collapse;width:100%;margin:10px 0}\n'
    + 'th,td{border:1px solid #bbb;padding:6px 8px;text-align:left;vertical-align:top}\n'
    + 'th{background:#f0f0f0}\n'
    + 'blockquote{border-left:4px solid #ccc;margin:10px 0;padding:2px 12px;color:#555}\n'
    + '.pagebreak{page-break-after:always}\n'
    + '</style></head><body>\n' + body + '\n</body></html>\n';
}
/** 表格数据（md 表 / CSV 文本）→ 二维数组，给 xlsx 用。 */
function dataToRows(content) {
  const text = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const isRow = (s) => /^\s*\|.*\|\s*$/.test(s);
  if (lines.filter((l) => isRow(l)).length >= 2) {
    const rows = lines.filter((l) => isRow(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
      .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    if (rows.length) return rows;
  }
  const { parseDelimited } = require('./text');
  const rows = parseDelimited(text);
  if (rows.length && rows.some((r) => r.length > 1)) return rows;
  return lines.filter((l) => l.trim() !== '').map((l) => [l.trim()]);
}

module.exports = { mdToBlocks, mdToHtml, htmlDocument, dataToRows, inline };
