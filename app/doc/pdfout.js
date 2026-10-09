/* app/doc/pdfout.js —— 写 PDF：借本机已有的 Edge/Chrome 无头打印
 *
 * 为什么不用纯 JS 拼 PDF：中文 PDF 要正确显示就得内嵌中文字体（SimSun 十几 MB），自己写
 * 字体子集化是另一个工程；而这台机器上浏览器本来就有（桌面外壳、测试都用它），
 * `msedge --headless=new --print-to-pdf` 出来的 PDF 中文、表格、分页都是印刷级。
 * 零新增依赖，还顺带把「markdown → 好看的排版」一起解决了。
 *
 * 注意：headless 打印必须给 --user-data-dir（否则会去抢用户日常浏览器的锁），而且同一
 * profile 不能并发跑两个实例 —— 这里用一个共享 profile + 串行队列。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
function browserPath() {
  for (const p of EDGE_CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return null;
}

let _queue = Promise.resolve();                        // 串行化：共享 profile 只能跑一个实例
let _seq = 0;

/** 把一段 HTML 打印成 PDF（Promise）。 */
function printHtmlToPdf(html, outPath, opts) {
  opts = opts || {};
  const exe = browserPath();
  if (!exe) return Promise.reject(new Error('找不到 Edge/Chrome，无法生成 PDF'));
  const run = () => new Promise((resolve, reject) => {
    const tmpDir = path.join(os.tmpdir(), 'lm-doc-pdf');
    const profile = path.join(os.tmpdir(), 'lm-doc-pdf-profile');
    try { fs.mkdirSync(tmpDir, { recursive: true }); fs.mkdirSync(profile, { recursive: true }); } catch (_) {}
    const stamp = Date.now().toString(36) + '-' + (++_seq);
    const htmlPath = path.join(tmpDir, 'doc-' + stamp + '.html');
    const pdfPath = path.resolve(outPath);
    try { fs.writeFileSync(htmlPath, html, 'utf8'); } catch (e) { return reject(e); }
    try { fs.mkdirSync(path.dirname(pdfPath), { recursive: true }); } catch (_) {}
    try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch (_) {}
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-pdf-header-footer', '--print-to-pdf=' + pdfPath,
      '--user-data-dir=' + profile,
      '--virtual-time-budget=8000',
      'file:///' + htmlPath.replace(/\\/g, '/').replace(/^\/+/, ''),
    ];
    const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(killT);
      try { fs.unlinkSync(htmlPath); } catch (_) {}
      if (err) return reject(err);
      let buf = null;
      for (let i = 0; i < 20 && !buf; i++) {           // 打印完到文件落盘偶有几十毫秒延迟
        try { const b = fs.readFileSync(pdfPath); if (b.length > 100 && b.toString('latin1', 0, 5) === '%PDF-') buf = b; } catch (_) {}
        if (!buf) { const t = Date.now() + 250; while (Date.now() < t); }
      }
      if (!buf) return reject(new Error('Edge 没有产出 PDF（可能被安全策略拦住）'));
      resolve({ ok: true, bytes: buf.length });
    };
    const killT = setTimeout(() => { try { child.kill(); } catch (_) {} finish(new Error('生成 PDF 超时（60 秒）')); }, opts.timeout || 60000);
    child.on('error', (e) => finish(e));
    child.on('exit', () => finish(null));
  });
  const p = _queue.then(run, run);
  _queue = p.catch(() => {});                          // 队列不被失败卡住
  return p;
}

module.exports = { browserPath, printHtmlToPdf };
