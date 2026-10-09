/* ============================================================================
 * local-model / server.js  --  unified backend for Bonsai Studio + Qwen Studio
 *
 * ONE zero-dependency Node process that fronts BOTH engines:
 *   - chat  : llama-server.exe (Ternary Bonsai 2 27B, PrismML fork)  port 8110
 *   - image : image/qwen_studio.py bridge (Python 3.13 portable) -> ComfyUI 8188
 *
 * The 8 GB card cannot hold both at once, so a promise-chain arbiter serialises
 * every switch: stop the other side -> wait for VRAM to actually come back
 * (WDDM releases lazily) -> start the side we need.
 * ==========================================================================*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const CHAT_CFG = CFG.chat || {};
const IMG_CFG = CFG.image || {};
const SEARCH_CFG = CFG.search || {};
const VRAM_CFG = CFG.vram || {};

const APP_PORT = Number(process.env.LOCALMODEL_APP_PORT || CFG.appPort || 8890);
const CHAT_PORT = Number(CHAT_CFG.enginePort || 8110);
const IMG_PORT = Number(IMG_CFG.bridgePort || 8802);
const COMFY_PORT = Number(IMG_CFG.comfyPort || 8188);

const BIN_DIR = path.join(ROOT, CHAT_CFG.binDir || 'chat/llamacpp/bin');
const MODELS_DIR = path.join(ROOT, CHAT_CFG.modelsDir || 'chat/models');
const LORA_DIR = path.join(ROOT, CHAT_CFG.loraDir || 'chat/lora');
const IMAGE_DIR = path.join(ROOT, 'image');
const BRIDGE_PY = path.join(IMAGE_DIR, 'qwen_studio.py');
const PY_EXE = path.join(IMG_CFG.portable || 'E:\\ComfyUI_windows_portable', 'python_embeded', 'python.exe');

/* ---------------------- PowerShell 解释器解析（pwsh 7 优先） ----------------------
 * 2026-10-09 起本机装了 PowerShell 7.6.6（C:\Program Files\PowerShell\7\pwsh.exe）。
 * 解析顺序与 DSH 内核一致、且只认存在的那一个：
 *   1. ps7FromRegistry() / 标准安装目录：Program Files\PowerShell\7\pwsh.exe
 *   2. PATH 里的 pwsh.exe（Store 版 / scoop / 手动装）
 *   3. %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe（5.1 兜底，它永远在）
 * 下面所有对外文案与命令执行都按 PS_SHELL.pwsh / .exe / .label 分流：
 * 5.1 的坑（只认带 BOM 的 UTF-8 脚本、不支持 && / ||、iwr 要 -UseBasicParsing、
 * -Command 会吞掉 native 退出码）只在回落时启用；跑在 7 上时不拦、不补 BOM、不写旧提示。 */
function ps7FromRegistry() {
  try {
    const out = require('child_process').execFileSync('reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\PowerShellCore\\InstalledVersions', '/s'],
      { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const dirs = [];
    const re = /InstallDir\s+REG_\w+\s+([^\r\n]+)/g;
    let m;
    while ((m = re.exec(out))) dirs.push(m[1].trim());
    return dirs.length ? dirs : null;
  } catch (_) { return null; }
}
function resolvePwshExe() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const roots = [path.join(pf, 'PowerShell', '7')];
  for (const d of (ps7FromRegistry() || [])) roots.push(d);
  for (const d of String(process.env.PATH || '').split(';')) {
    const t = d.trim().replace(/^"|"$/g, '');
    if (t) roots.push(t);
  }
  for (const r of roots) {
    const exe = path.join(r, 'pwsh.exe');
    try { if (fs.statSync(exe).isFile()) return exe; } catch (_) { /* 不存在就下一个 */ }
  }
  return null;
}
/** 一次解析、进程内固定：绝不在请求中途变（否则 system 提示变、llama-server 的 KV 前缀缓存整段作废）。 */
const PS_SHELL = (() => {
  const p = resolvePwshExe();
  if (p) return { exe: p, label: 'PowerShell 7 (pwsh)', pwsh: true };
  return { exe: 'powershell.exe', label: 'Windows PowerShell 5.1', pwsh: false };
})();

/** 脚本落成临时 .ps1、用 -File 跑（躲开命令行长度与转义，报错行号也能对上）。
 *  只有 5.1 需要补 UTF-8 BOM；7 默认就按 UTF-8 读脚本，补了反而给自己添乱。
 *  PS7 上刻意不传 -ExecutionPolicy Bypass（可选参数，省掉一个兼容面）。 */
function psScriptArgv(scriptFile) {
  return PS_SHELL.pwsh
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptFile]
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile];
}
function psInlineArgv(script) {
  return PS_SHELL.pwsh
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
}
/** 写 .ps1 用的脚本文本：5.1 要 BOM，7 不要（写了 BOM 的脚本 7 也照跑，但没必要）。 */
function psScriptText(lines) {
  return (PS_SHELL.pwsh ? '' : '\ufeff') + lines.join('\n') + '\n';
}

const APP_DIR = __dirname;
const UI_DIR = path.join(APP_DIR, 'ui');
const LOG_DIR = path.join(APP_DIR, 'logs');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const PID_FILE = path.join(LOG_DIR, 'engine.pid');
const BRIDGE_PID_FILE = path.join(LOG_DIR, 'bridge.pid');
const CHAT_LOG = path.join(LOG_DIR, 'engine.log');
const BRIDGE_LOG = path.join(LOG_DIR, 'bridge.log');
const LAUNCHER_LOG = path.join(LOG_DIR, 'launcher.log');
const SERVER_LOG = path.join(LOG_DIR, 'server.log');   // launcher.log 被启动器独占时的备用日志
const SESSIONS_FILE = path.join(APP_DIR, 'sessions.json');   // 会话列表 + 消息
const SESS_DIR = path.join(APP_DIR, 'session-files');        // 会话里贴过的图（data: URL 落盘）
const DOC_DIR = path.join(APP_DIR, 'doc-files');             // 用户上传的文档（同样是会话级临时文件）
const DOC = require('./doc');                                // 文档解析/生成（pdf/docx/xlsx/pptx/rtf/html/csv/…）
const VISION = require('./doc/vision');                      // 本地视觉模型识图（pdfjs 渲染 + llama.cpp mtmd）
let DOC_SEQ = 0;                                             // 上传文件序号（落盘名去重）

for (const d of [LOG_DIR, UI_DIR, SESS_DIR, DOC_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const RELEASE_TARGET = Number(VRAM_CFG.releaseTargetMiB || 1500);
const RELEASE_TIMEOUT = Number(VRAM_CFG.releaseTimeoutMs || 45000);

/* ------------------------------------------------------------------ utils */
function log(...a) {
  const line = '[' + new Date().toISOString() + '] ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  process.stdout.write(line + '\n');
  /* 启动器（app/launch.js）活着时会独占 launcher.log，这里的 append 会 EBUSY 失败；
   * 以前 catch 掉就没了——本轮实测「日志文件里查不到刚发生的事」正是这个原因。
   * 现在退到 server.log，保证后端日志一定落盘一份。 */
  try { fs.appendFileSync(LAUNCHER_LOG, line + '\n'); }
  catch (_) { try { fs.appendFileSync(SERVER_LOG, line + '\n'); } catch (_) {} }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function appendFile(p, s) { try { fs.appendFileSync(p, s); } catch (_) {} }
function tailFile(p, maxBytes) {
  try {
    const st = fs.statSync(p);
    const start = Math.max(0, st.size - (maxBytes || 200000));
    const fd = fs.openSync(p, 'r');
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) { return ''; }
}
function httpReq(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 30000, () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}
async function httpJson(port, p, method, body, timeout) {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { 'accept': 'application/json' };
  if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
  const r = await httpReq({ host: '127.0.0.1', port, path: p, method: method || 'GET', headers, timeout: timeout || 20000 }, data);
  const text = r.body.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}
async function fetchUrl(url, opts) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? require('https') : http;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: (opts && opts.method) || 'GET',
      headers: Object.assign({ 'user-agent': UA, 'accept': '*/*' }, (opts && opts.headers) || {}),
      timeout: (opts && opts.timeout) || 25000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && !(opts && opts.noRedirect)) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).toString(), opts));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

/* --------------------------------------------------------------- GPU/VRAM */
const NVSMI_CANDIDATES = ['nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'];
let NVSMI = null;
async function pickNvsmi() {
  if (NVSMI) return NVSMI;
  for (const c of NVSMI_CANDIDATES) {
    try {
      await new Promise((res, rej) => execFile(c, ['--query-gpu=name', '--format=csv,noheader'], { timeout: 6000 }, (e, o) => e ? rej(e) : res(o)));
      NVSMI = c; return c;
    } catch (_) {}
  }
  NVSMI = 'nvidia-smi'; return NVSMI;
}
let gpuCache = { at: 0, val: null };
async function gpuStats(force) {
  const now = Date.now();
  if (!force && gpuCache.val && now - gpuCache.at < 900) return gpuCache.val;
  const exe = await pickNvsmi();
  return new Promise(resolve => {
    execFile(exe, ['--query-gpu=name,memory.used,memory.total,temperature.gpu,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 6000 }, (err, stdout) => {
        if (err) return resolve(gpuCache.val || { error: String(err.message || err) });
        const p = String(stdout).trim().split('\n')[0].split(',').map(s => s.trim());
        const val = { name: p[0], used: Number(p[1]), total: Number(p[2]), temp: Number(p[3]), util: Number(p[4]) };
        gpuCache = { at: Date.now(), val };
        resolve(val);
      });
  });
}
async function waitVramBelow(target, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const g = await gpuStats(true);
    last = g && typeof g.used === 'number' ? g.used : null;
    if (last !== null && last <= target) return { ok: true, used: last, waited: Date.now() - t0 };
    await sleep(1000);
  }
  return { ok: false, used: last, waited: Date.now() - t0 };
}

/* ---------------------------------------------------------------- search */
function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}
function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}
function xmlTag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? m[1] : '';
}
async function searchWeb(query, count) {
  const ep = SEARCH_CFG.endpoint || 'https://www.bing.com/search';
  const n = count || SEARCH_CFG.count || 8;
  const url = ep + '?q=' + encodeURIComponent(query) + '&format=rss&count=' + n;
  const r = await fetchUrl(url, { timeout: 20000, headers: { 'accept': 'application/rss+xml,application/xml,text/xml,*/*' } });
  const xml = r.body.toString('utf8');
  const out = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && out.length < n) {
    const b = m[1];
    const title = stripTags(xmlTag(b, 'title'));
    const link = decodeEntities(xmlTag(b, 'link')).trim();
    const snippet = stripTags(xmlTag(b, 'description')).slice(0, 600);
    if (title || snippet) out.push({ title, link, snippet });
  }
  return { ok: out.length > 0, status: r.status, query, results: out };
}

/* ------------------------------------------------------------------ chat */
const CATALOG = {
  models: [{
    id: 'bonsai-ptq1_0',
    name: 'Ternary Bonsai 2 27B (PTQ1_0 · 5.5 GB)',
    file: 'Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    mmproj: 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
    note: 'Only the PrismML fork can load this; stock llama.cpp / Ollama load it but emit garbage.',
  }, {
    id: 'bonsai-abliterated',
    name: 'Ternary Bonsai 2 27B 消融版 (PTQ1_0 · 5.5 GB)',
    file: 'Ternary-Bonsai-2-27B-Abliterated-PTQ1_0.gguf',
    mmproj: 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
    skipLora: true,
    note: '权重级消融：与官方逐字节同尺寸（5,946,648,928 B），只改 98/851 张量、只动 block 15–63。拒答 83%→0%、过度拒答 1.6%→0、MMLU +0.12pp、HumanEval −3.0pp（都不显著）。已经无审查了，所以自动跳过 OrcaBonsai LoRA（叠上去反而可能变差）。注意：思考模式在有害提示上 24% 直接不给答案 ⇒ 用这个模型建议把「思考深度」设为「关闭思考」。',
  }, {
    id: 'ornith-1.5-9b',
    name: 'Ornith 1.5 9B 无审查·强 (CRACK · 5.6 GB)',
    file: 'Ornith-1.5-9B-CRACK-Q4_K_M.gguf',
    mmproj: 'Ornith-1.5-9B-uncensored-mmproj-Q8_0.gguf',
    skipEffort: true, skipLora: true, forceNoThink: true,
    note: '本机 A/B 实测的无审查赢家（2026-10-08）：12 条越界提问里只有「土制炸药配方」仍被挡，键盘记录器、汽车热接线、合成路线都照做。作者自报 HarmBench harm-ASR 99.6%（Q4_K_M），MMLU 只掉 1.76pp。9B 稠密 VLM（Qwen3.5 混合线性注意力，262K 上下文），本机约 2.5× Bonsai 速度。重复惩罚务必用 1.05 上下 —— 1.5 会让它输出乱码级代码块（实测踩过），温度也别调低。此模型不适用 OrcaBonsai LoRA，也不吃 --reasoning-effort。',
  }, {
    id: 'ornith-1.5-9b-think',
    name: 'Ornith 1.5 9B 无审查·思考版 (CRACK · 5.6 GB)',
    file: 'Ornith-1.5-9B-CRACK-Q4_K_M.gguf',
    mmproj: 'Ornith-1.5-9B-uncensored-mmproj-Q8_0.gguf',
    skipEffort: true, skipLora: true,
    note: '和「无审查·强」同一份权重（dealignai CRACK），区别只有一个：这个版本允许开思考 —— 把下面「思考深度」选成「中等」或「高」就是思考模式，选「关闭思考」仍然是直接出答案。实测（2026-10-08，6 条越界提问、rp 1.05）：思考模式下 6/6 都照做（比关思考还干净），但**它想得非常多** —— 单条思考 2500–7700 字，等于 2000–6000 token，很容易把「单次最多输出」全吃光、只剩思考没有答案（实测 6 条里 3 条撞上限）。用思考模式务必把「单次最多输出」提到 8192 以上（`Ornith 9B 思考版` 预设已经替你设成 12288），复杂问题慢一点是正常的。',
  }, {
    id: 'ornith-1.5-9b-heretic',
    name: 'Ornith 1.5 9B 无审查·稳 (heretic · 5.6 GB)',
    file: 'Ornith-1.5-9B-heretic-Q4_K_M.gguf',
    mmproj: 'Ornith-1.5-9B-uncensored-mmproj-Q8_0.gguf',
    skipEffort: true, skipLora: true, forceNoThink: true,
    note: '同一基座的另一种消融（Heretic/TPE 搜索，只改 43/760 张量，KL 0.0376、PPL 2.917，视觉塔与 embedding 逐位不变）。比 CRACK 稳：长文不会中途崩坏，但硬题仍会绕（本机实测：合成冰毒直接拒答、炸药配方转成写作建议；键盘记录器照做）。写代码、写长文，或不想被 CRACK「嘴上配合、内容跑偏」坑到时用它。',
  }],
  loras: [
    { id: 'none', name: '不使用（官方原版行为）', file: null },
    { id: 'orcabonsai', name: 'OrcaBonsai 无审查消融', file: 'bonsai-abliterate-lora.gguf' },
  ],
};

const DEFAULTS = {
  model: 'bonsai-ptq1_0', lora: 'none', loraScale: 1.0, vision: false,
  port: CHAT_PORT, ctx: 16384, ngl: 99, flashAttn: 'on', cacheTypeK: 'f16', cacheTypeV: 'f16',
  mmap: false, batch: 2048, ubatch: 512, parallel: 1, cacheRam: 4096, threads: 0,
  reasoningEffort: 'medium', maxTokens: 4096, temperature: 0.7, topP: 0.95, topK: 20,
  minP: 0.05, repeatPenalty: 1.0, seed: -1,
  imageMinTokens: 1024, imageMaxEdge: 1280,
  systemPrompt: 'You are a helpful assistant.',
  webSearch: false,
  agentRoot: 'F:\\v\\project', agentMode: 'build', agentPerm: 'workspace', agentMaxSteps: 16, agentPermWrite: 'ask', agentPermExec: 'ask',
  docAutoRead: true, docMaxChars: 12000, docVision: true, docVisionPages: 4,
};

const SCHEMA = [
  {
    id: 'model', title: '模型与上下文', icon: '📦', items: [
      { key: 'model', label: '对话模型', type: 'select', optionsFrom: 'models', restart: true, help: '五选一：① Bonsai 2 27B 官方版（1.75 bit / 5.5 GB，必须配 PrismML 版 llama.cpp，原版 llama.cpp / Ollama 能加载但输出乱码不报错）；② 同一份的消融版（同尺寸、拒答 83%→0%，建议配「关闭思考」）；③ Ornith 1.5 9B 无审查·强（CRACK，本机 A/B 里最配合，强制关思考、最快）；④ Ornith 1.5 9B 无审查·思考版（同一份 CRACK 权重，可开思考，思考很长、请把单次输出上限抬到 8192 以上）；⑤ Ornith 1.5 9B 无审查·稳（heretic，长文更稳但硬题会绕）。切模型会自动重启引擎（约 30–60 秒）；LoRA 只对 Bonsai 生效，思考深度对 Bonsai 与「Ornith 思考版」生效。', estimate: '5.5 GB 权重 → 8 GB 卡上约占 6.9 GB（含 KV 与计算缓冲）；Ornith 9B 约 6.4 GB' },
      { key: 'ctx', label: '上下文长度', type: 'select', options: [[4096, '4 K（省显存）'], [8192, '8 K'], [16384, '16 K（推荐）'], [32768, '32 K'], [40960, '40 K（配 q4_0 KV，实测 7443 MiB）'], [65536, '64 K（会很慢）']], restart: true, help: 'KV 缓存随上下文线性增长。f16 时 16 K 约 0.6 GB，64 K 约 2.4 GB —— 8 GB 卡放不下 64 K。', estimate: '16 K/f16 实测 22.5 tok/s；KV 换成 q8_0 可再省一半显存，速度基本不变；K/V 都换 q4_0 后 40 K 只要 7443 MiB' },
      { key: 'lora', label: 'LoRA 适配器', type: 'select', optionsFrom: 'loras', restart: true, help: 'OrcaBonsai 是运行时行为消融适配器（不改权重）。它在每个残差写入点插一对矩阵乘，所以恒定变慢。', estimate: '开启后生成 22.8 → 16.7 tok/s（−27%），显存只多 9 MB' },
      { key: 'loraScale', label: 'LoRA 强度', type: 'slider', min: 0, max: 3, step: 0.1, restart: false, help: '运行时生效、不用重启引擎。scale 1 在本机一批抽象基准题上一条都没翻（7/7 仍拒绝）；scale 2 才 7/7 照做。警告：scale ≠ 1 必须靠运行时接口设置，重启后由后端自动补设。', estimate: 'scale 1 → 16.7 tok/s；scale 2 实测 21.0–22.1 tok/s' },
      { key: 'vision', label: '识图（多模态）', type: 'select', options: [[false, '关闭'], [true, '开启（+0.15 GB 显存）']], restart: true, help: '加载 mmproj 视觉塔后模型才能收图。开启后 /props 的 modalities.vision 变 true。', estimate: '视觉塔额外占 0.12–0.19 GB 显存' },
      { key: 'systemPrompt', label: '系统提示词', type: 'text', restart: false, help: '每轮请求都会带上。官方建议一句话就够：You are a helpful assistant.', estimate: '' },
    ],
  },
  {
    id: 'speed', title: '速度与显存优化', icon: '⚡', items: [
      { key: 'ngl', label: 'GPU 层数 (-ngl)', type: 'slider', min: 0, max: 99, step: 1, restart: true, help: '99 = 全部卸载到 GPU。降到 0 会变成纯 CPU 推理，速度掉到 2 tok/s 以下。', estimate: '99：22.5 tok/s；0：约 1.5–2 tok/s' },
      { key: 'flashAttn', label: 'Flash Attention', type: 'select', options: [['on', '开启（推荐）'], ['off', '关闭']], restart: true, help: '关掉之后 KV 量化参数 -ctk/-ctv 会被后端自动略过（不关会启动失败）。', estimate: '开启时预填充 94.8 tok/s' },
      { key: 'cacheTypeK', label: 'KV 缓存 K 类型', type: 'select', options: [['f16', 'f16（最准）'], ['q8_0', 'q8_0（省一半）'], ['q4_0', 'q4_0（最省）']], restart: true, help: '注意：q5_0 在本模型上比其他类型慢好几倍，别选（后端里没列出来）。', estimate: 'q8_0 相对 f16 省约 50% KV 显存，精度影响在对话里基本看不出来' },
      { key: 'cacheTypeV', label: 'KV 缓存 V 类型', type: 'select', options: [['f16', 'f16（最准）'], ['q8_0', 'q8_0（省一半）'], ['q4_0', 'q4_0（最省）']], restart: true, help: '与 K 独立。V 用 q8_0 是性价比最高的省显存手段。', estimate: 'V=q8_0 在 16 K 下省约 0.3 GB' },
      { key: 'mmap', label: '内存映射 (-mmap)', type: 'select', options: [[false, '关闭（用 --no-mmap，推荐）'], [true, '开启']], restart: true, help: '关掉 mmap 让权重一次性读进内存/显存，避免运行中被换页拖慢。16 GB 内存装 5.5 GB 权重没问题。', estimate: '关掉可避免中途掉到 1.8 tok/s 那种抖动' },
      { key: 'batch', label: '批大小 (-b)', type: 'select', options: [[512, '512'], [1024, '1024'], [2048, '2048（推荐）'], [4096, '4096']], restart: true, help: '预填充的分块大小，直接决定首字延迟；对生成速度没影响。', estimate: '2048 时预填充 94.8 tok/s' },
      { key: 'ubatch', label: '微批大小 (-ub)', type: 'select', options: [[128, '128'], [256, '256'], [512, '512（推荐）'], [1024, '1024']], restart: true, help: '批中真正并行计算的块。太小会拖慢预填充，太大会吃显存。', estimate: '512 与 2048 搭配是识图提速的真开关' },
      { key: 'cacheRam', label: '内存缓存上限 (MB)', type: 'slider', min: 0, max: 24576, step: 1024, restart: true, help: '把历史提示词的 KV 放进内存做复用，多轮对话时省重复预填充。单用户建议 4096。', estimate: '4096 够 16 K 上下文的多轮复用' },
      { key: 'threads', label: 'CPU 线程', type: 'slider', min: 0, max: 32, step: 1, restart: true, help: '0 = 自动。本机 Ryzen 9 7945HX 有 32 线程，但 GPU 推理时线程只用于采样与预处理。', estimate: '0（自动）即可' },
    ],
  },
  {
    id: 'sampling', title: '采样与输出', icon: '🎲', items: [
      { key: 'reasoningEffort', label: '思考深度', type: 'select', options: [['none', '关闭思考（最快）'], ['medium', '中等（推荐）'], ['xhigh', '高（xhigh）']], restart: false, help: '热生效、逐请求发送。本模型的模板只认 xhigh / medium / low，传 high 会让服务端对每条消息回 500 —— 选项里已经没有它了，后端也会把非法值归一化。官方建议 medium：省 token 且精度与 xhigh 相当。选「关闭思考」会真的关掉（发 enable_thinking=false），不是少发一个参数。Ornith「无审查·强 / 无审查·稳」被强制关思考，这一项对它们无效；只有「Ornith 1.5 9B 无审查·思考版」跟着这里走 —— 选「中等」或「高」= 开思考，选「关闭」= 直出答案。Ornith 思考很长（实测单条 2500–7700 字），开思考时务必把「单次最多输出」提到 8192 以上，否则会出现「只有思考、没有答案」。', estimate: 'medium 下复杂题约 200–1000 字思考；none 直接出答案，实测同一问题 7.3 秒 → 2.0 秒' },
      { key: 'maxTokens', label: '单次最多输出', type: 'slider', min: 256, max: 32768, step: 256, restart: false, help: '一次回复的 token 总预算，思考（reasoning）与正文共用它，所以长文光靠调它不一定够。撞上限时消息末尾会标「已到单次输出上限」。', estimate: '5000 汉字约需 5000–7000 tokens；本机约 23 tok/s，8192 tokens ≈ 6 分钟' },
      { key: 'temperature', label: '温度', type: 'slider', min: 0, max: 2, step: 0.05, restart: false, help: '官方思考模式推荐 1.0，非思考模式推荐 0.7。', estimate: '' },
      { key: 'topP', label: 'top_p', type: 'slider', min: 0, max: 1, step: 0.01, restart: false, help: '官方：思考模式 0.95，非思考 0.80。', estimate: '' },
      { key: 'topK', label: 'top_k', type: 'slider', min: 0, max: 200, step: 1, restart: false, help: '官方推荐 20。', estimate: '' },
      { key: 'minP', label: 'min_p', type: 'slider', min: 0, max: 0.5, step: 0.01, restart: false, help: 'llama.cpp 默认 0.05，正好是官方推荐值；非思考模式建议 0。', estimate: '' },
      { key: 'repeatPenalty', label: '重复惩罚', type: 'slider', min: 0.5, max: 2, step: 0.05, restart: false, help: '长文复读的解药。字段名已修正（llama.cpp 只认 repeat_penalty，之前发的 repetition_penalty 被静默忽略、等于没生效），现在真正起作用，惩罚窗口也放宽到最近 512 个 token。设 1 = 关闭。', estimate: '写长文建议 1.05–1.15；**超过 1.2 会让无审查小模型崩坏**（实测 1.5 时 Ornith CRACK 输出的代码块是乱码、长文跑题），太高也会让中文用词变怪' },
      { key: 'seed', label: '随机种子', type: 'number', min: -1, max: 2147483647, step: 1, restart: false, help: '-1 = 每次随机。固定种子可用于复现同一个答案。', estimate: '' },
    ],
  },
  {
    id: 'vision', title: '识图与联网', icon: '🖼️', items: [
      { key: 'imageMaxEdge', label: '发图前缩放长边', type: 'slider', min: 512, max: 2560, step: 128, restart: false, help: '在浏览器里先把图缩小再发（原文件不动）。图片占的 token 数随边长平方增长，缩放是识图提速最有效的一招。', estimate: '1920×1200 → 缩到 1280 长边：4145 → 1108 prompt token' },
      { key: 'imageMinTokens', label: '图片最少 token 数', type: 'slider', min: 0, max: 4096, step: 128, restart: true, help: '只对小图生效；大图由视觉塔自己决定切多少块，这个值管不着。', estimate: '1024 即可' },
      { key: 'webSearch', label: '联网搜索', type: 'select', options: [[false, '关闭'], [true, '开启（Bing RSS）']], restart: false, help: '发消息前用 Bing RSS 检索，把标题/摘要/链接拼进系统提示。本机唯一能通的检索通道是 Bing RSS（DuckDuckGo、Brave、SearX、维基全部超时）。', estimate: '每次多花 1–3 秒；返回 8 条中文结果' },
    ],
  },
  {
    id: 'agent', title: 'Agent（工具执行）', icon: '🤖', items: [
      { key: 'agentMode', label: 'Agent 模式（默认执行）', type: 'select', options: [['off', '关闭（普通对话）'], ['build', '执行（可以调工具干活）']], restart: false, help: '总开关。默认「执行」：模型可以调工具干活（读文件、跑命令、出图、联网）。「关闭」＝普通对话，只回文字、不碰工具。以前这个开关还摆在输入框上方，现在只在这里控制（换个档立即生效，不用重启引擎）。能做什么由下面的「Agent 权限」三档决定（照 DeepSeek Harness 的沙箱档位设计）。老配置里的「只读」等于「执行 + 仅可查看」，程序会按新写法理解。', estimate: '默认「执行」；只想聊天或想更省 token 时切「关闭」' },
      { key: 'agentPerm', label: 'Agent 权限', type: 'select', options: [['readonly', '仅可查看'], ['workspace', '工作区内修改（推荐）'], ['full', '完全权限']], restart: false, help: '照 DeepSeek Harness 的三档沙箱：① 仅可查看＝任何路径都能读（包括系统目录），但一个文件也不能写，命令每次都要你点允许；② 工作区内修改＝读不受限，写只限「Agent 工作目录」里，写到外面会被挡下；③ 完全权限＝读写到哪都行、命令不再询问（风险自负）。三档都支持「被拒后申请一次性放行」：模型说明理由后你在卡片上点允许，它就原样重试那一次。', estimate: '推荐「工作区内修改」：读得开、写得稳、越界会被拦一次' },
      { key: 'agentRoot', label: 'Agent 工作目录', type: 'dir', restart: false, help: '「工作区内修改」档下唯一可写的地方，命令也在这里执行；「仅可查看」档下写一律被拒；「完全权限」档下只当命令的默认目录。读文件不受这个目录限制。', estimate: '默认 F:\\v\\project —— 你所有项目的父目录' },
      { key: 'agentMaxSteps', label: '单轮最多步数', type: 'slider', min: 2, max: 40, step: 1, restart: false, help: '一轮对话里允许 agent 调用工具的最大次数（opencode 的 steps）。用完预算会强制让它总结收尾、不再调工具。步数越多越慢：本地 9B 每步约 1–3 秒，出图一步 30–60 秒。', estimate: '16 步 ≈ 30–60 秒；研究型任务建议 24–30' },
      { key: 'agentPermWrite', label: '写 / 改文件权限', type: 'select', options: [['ask', '每次询问（推荐）'], ['allow', '直接允许'], ['deny', '禁止']], restart: false, help: '只在「工作区内修改」档生效：「每次询问」会在对话里弹一张确认卡，你点允许它才落地；点「本次会话都允许」后，同一个浏览器会话里不再问。「仅可查看」档一律不许写，「完全权限」档一律直接写、不再问。', estimate: '' },
      { key: 'agentPermExec', label: '执行命令权限', type: 'select', options: [['ask', '每次询问（推荐）'], ['allow', '直接允许'], ['deny', '禁止']], restart: false, help: '只在「工作区内修改」档生效：agent 通过 PowerShell 5.1 在「Agent 工作目录」里执行命令，超时 3 分钟、输出截断到 12 KB。「仅可查看」档下命令永远要你点允许（命令本身可能写文件），「完全权限」档下不再询问。', estimate: '' },
    ],
  },
  {
    id: 'doc', title: '文档（上传与解析）', icon: '📄', items: [
      { key: 'docAutoRead', label: '上传后自动把正文喂给模型', type: 'select', options: [[true, '开启（推荐）'], [false, '关闭（只给路径，让 agent 按需读）']], restart: false, help: '开启时：文档正文随消息一起发出去，任何模式（含普通对话）都能直接分析它。关闭时：只把文件名与路径告诉模型，需要读哪份、读哪段由 agent 用 read_document 决定 —— 文档很多、或想省上下文时用。', estimate: '一份 20 页 PDF ≈ 3–6 万字，开启后会占掉可观上下文' },
      { key: 'docMaxChars', label: '每份文档贴进对话的字数上限', type: 'slider', min: 2000, max: 60000, step: 1000, restart: false, help: '超出的部分不贴，但会告诉模型「还有多少字没贴」以及继续读的办法（read_document 带 offset）。调大能一次读进更多，代价是上下文被吃掉。', estimate: '12000 字 ≈ 9000 token，16 K 上下文里约占一半' },
      { key: 'docVision', label: '扫描件 / 图片交给本机视觉模型读', type: 'select', options: [[true, '开启（推荐）'], [false, '关闭（只提示需要 OCR）']], restart: false, help: '扫描件 PDF、纯图片、以及文字层坏掉的 PDF（方正/国标类）没有可用文字，开启后会把页面渲染成图交给本机带视觉塔的模型（Ornith mmproj）逐页识别。识别时若「识图」没开，程序会自动打开它并重启引擎（约 30–60 秒）。', estimate: '每页约 1000–1600 token、8–40 秒；一张图约 10–30 秒' },
      { key: 'docVisionPages', label: '识图一次最多读几页', type: 'slider', min: 1, max: 12, step: 1, restart: false, help: '扫描件/坏文字层 PDF 一次渲染并识别多少页。页数越多越慢、越吃上下文；剩下的可以用 read_document 带 page 参数接着读。', estimate: '4 页 ≈ 5000 token 上下文、约 40 秒' },
    ],
  },
];

const PRESETS = [
  { id: 'balanced', name: '均衡日常', desc: '16 K 上下文 / f16 KV / 思考中等 —— 日常对话的默认档。', settings: { ctx: 16384, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048, ubatch: 512, vision: false, reasoningEffort: 'medium', maxTokens: 4096, lora: 'none', loraScale: 1.0 } },
  { id: 'fast', name: '极速优先', desc: '8 K 上下文 / q8_0 KV / 关闭思考 —— 要的是响应快。', settings: { ctx: 8192, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', ubatch: 256, reasoningEffort: 'none', maxTokens: 1024, temperature: 0.6, lora: 'none', loraScale: 1.0 } },
  { id: 'longctx', name: '长上下文', desc: '32 K 上下文 / q8_0 KV —— 读长文档、长代码。', settings: { ctx: 32768, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', maxTokens: 8192, reasoningEffort: 'medium', lora: 'none', loraScale: 1.0 } },
  { id: 'lowmem40k', name: '省显存 40K', desc: 'K/V 都换 q4_0 → 40 K 上下文实测只要 7443 MiB，比 32 K/q8_0 还少 336 MiB，速度不变。', settings: { ctx: 40960, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batch: 2048, ubatch: 512, vision: false, reasoningEffort: 'medium', maxTokens: 8192 } },
  { id: 'ornith9b', name: 'Ornith 9B（快）', desc: '切到 Ornith 1.5 9B 无审查·强（CRACK）+ 官方采样参数 —— 快模型，重复惩罚别超过 1.1，温度别调低（低温和高惩罚都会让它崩）。', settings: { model: 'ornith-1.5-9b', ctx: 32768, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', batch: 2048, ubatch: 512, vision: false, reasoningEffort: 'none', lora: 'none', loraScale: 1.0, temperature: 1.0, topK: 20, topP: 0.95, minP: 0, repeatPenalty: 1.05, maxTokens: 4096 } },
  { id: 'ornith9b-think', name: 'Ornith 9B 思考版', desc: '切到 Ornith 1.5 9B 无审查·思考版（CRACK，能吃思考）+ 官方采样 —— 思考很长，所以单次输出上限抬到 12288，否则会出现「只有思考、没有答案」。', settings: { model: 'ornith-1.5-9b-think', ctx: 32768, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', batch: 2048, ubatch: 512, vision: false, reasoningEffort: 'medium', lora: 'none', loraScale: 1.0, temperature: 1.0, topK: 20, topP: 0.95, minP: 0, repeatPenalty: 1.05, maxTokens: 12288 } },
  { id: 'uncensored', name: '无审查', desc: 'OrcaBonsai 消融 + 强度 2 —— 本机实测只有 scale 2 才真正翻过拒绝。', settings: { lora: 'orcabonsai', loraScale: 2.0, ctx: 16384, cacheTypeK: 'f16', cacheTypeV: 'f16', reasoningEffort: 'medium', maxTokens: 4096 } },
  { id: 'vision', name: '识图', desc: '开视觉塔 + 发图缩放 —— 看图问答。', settings: { vision: true, imageMaxEdge: 1280, imageMinTokens: 1024, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', batch: 2048, ubatch: 512, temperature: 0.3, ctx: 16384, lora: 'none', loraScale: 1.0 } },
];

const SOFT_KEYS = new Set(['loraScale', 'reasoningEffort', 'maxTokens', 'temperature', 'topP', 'topK', 'minP', 'repeatPenalty', 'seed', 'systemPrompt', 'webSearch', 'imageMaxEdge', 'agentRoot', 'agentMode', 'agentPerm', 'agentMaxSteps', 'agentPermWrite', 'agentPermExec', 'docAutoRead', 'docMaxChars', 'docVision', 'docVisionPages']);

function modelInfo(id) { return CATALOG.models.find(x => x.id === id) || CATALOG.models[0]; }
function modelPath(id) { return path.join(MODELS_DIR, modelInfo(id).file); }
function mmprojPath(id) { const m = modelInfo(id); return m.mmproj ? path.join(MODELS_DIR, m.mmproj) : null; }
function loraPath(id) { const l = CATALOG.loras.find(x => x.id === id); return l && l.file ? path.join(LORA_DIR, l.file) : null; }

/* The Bonsai chat template accepts exactly xhigh / medium / low (on this model low
 * behaves like xhigh). Anything else -- "high" above all -- makes minja raise
 * "Unexpected reasoning effort high" and llama-server answers 500 to EVERY request,
 * which looks exactly like a broken install. Every writer of this key (settings file,
 * UI, launch args, request payload) goes through normEffort so a bad value can never
 * reach the engine again. */
function normEffort(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (s === 'none' || s === 'off' || s === 'false') return 'none';
  if (s === 'xhigh' || s === 'default' || s === 'high' || s === 'max' || s === 'low') return 'xhigh';
  return 'medium';
}
function readSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (_) {}
  const r = Object.assign({}, DEFAULTS, s);
  r.reasoningEffort = normEffort(r.reasoningEffort);   // self-heals a settings.json left on "high"
  return r;
}
function writeSettings(s) {
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) if (k in s) clean[k] = s[k];
  if ('reasoningEffort' in clean) clean.reasoningEffort = normEffort(clean.reasoningEffort);
  clean.port = CHAT_PORT;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2), 'utf8');
}
function diffSettings(before, after) {
  const changed = [], needRestart = [];
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    changed.push(k);
    if (!SOFT_KEYS.has(k)) needRestart.push(k);
  }
  return { changed, needRestart };
}
function buildArgs(s) {
  const a = [];
  const mi = modelInfo(s.model);
  a.push('-m', modelPath(s.model));
  a.push('-ngl', String(s.ngl));
  a.push('-c', String(s.ctx));
  a.push('-fa', String(s.flashAttn));
  a.push('-b', String(s.batch));
  a.push('-ub', String(s.ubatch));
  a.push('-np', String(s.parallel));
  a.push('--host', '127.0.0.1');
  a.push('--port', String(CHAT_PORT));
  const effArg = normEffort(s.reasoningEffort);
  // 「关闭思考」不能靠省略 --reasoning-effort：Qwen 系模板默认就是带思考（实测不传时仍产出 reasoning）。
  // 真正关掉要用模板开关 enable_thinking=false（实测 reasoning 长度 128→0、回答时间 7.3s→2.0s）。
  // 另外 forceNoThink 的模型（消融版 Ornith）无论用户选什么档位都强制关思考：
  // 实测同一批越界提问，思考开着时 ZeroFuse 消融版 7/8 拒答、关掉只有 1/8 —— 思考会把审查带回来。
  if (effArg === 'none' || mi.forceNoThink) a.push('--chat-template-kwargs', '{"enable_thinking":false}');
  else if (!mi.skipEffort) a.push('--reasoning-effort', effArg);
  if (s.flashAttn !== 'off') { a.push('-ctk', String(s.cacheTypeK)); a.push('-ctv', String(s.cacheTypeV)); }
  if (!s.mmap) a.push('--no-mmap');
  if (Number(s.cacheRam) > 0) a.push('--cache-ram', String(Number(s.cacheRam)));
  if (Number(s.threads) > 0) a.push('-t', String(Number(s.threads)));
  const mp = mmprojPath(s.model);
  if (s.vision && mp) { a.push('--mmproj', mp); a.push('--image-min-tokens', String(s.imageMinTokens)); }
  if (s.lora && s.lora !== 'none' && !mi.skipLora) {
    const lf = loraPath(s.lora);
    if (lf) { if (Number(s.loraScale) !== 1) a.push('--lora-init-without-apply'); a.push('--lora', lf); }
  }
  return a;
}

/* ------------------------------------------------------- process helpers */
function killTree(pid) {
  return new Promise(resolve => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000 }, () => resolve());
  });
}
function pidOnPort(port) {
  return new Promise(resolve => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { timeout: 12000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const re = new RegExp('^\\s*TCP\\s+\\S+:' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'mi');
      const m = String(stdout).match(re);
      resolve(m ? Number(m[1]) : null);
    });
  });
}
function procImageName(pid) {
  return new Promise(resolve => {
    execFile('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { timeout: 12000 }, (err, stdout) => {
      if (err) return resolve('');
      const m = String(stdout).match(/^"([^"]+)"/m);
      resolve(m ? m[1] : '');
    });
  });
}

/* ============================== CHAT ENGINE ============================== */
const chat = { proc: null, args: [], startedAt: 0, starting: false };

async function chatHealth() {
  try { const r = await httpJson(CHAT_PORT, '/health', 'GET', undefined, 4000); return r.status === 200 || r.status === 503 ? r.json : null; }
  catch (_) { return null; }
}
async function chatAlive() {
  const h = await chatHealth();
  return !!(h && (h.status === 'ok' || h.status === 'loading'));
}
async function chatReady() {
  const h = await chatHealth();
  return !!(h && h.status === 'ok');
}
async function killStaleChat() {
  const pid = await pidOnPort(CHAT_PORT);
  if (!pid) return false;
  const name = await procImageName(pid);
  if (!/llama-server/i.test(name)) { log('port ' + CHAT_PORT + ' held by ' + name + ' (' + pid + ') -- left alone'); return false; }
  log('killing stale llama-server pid ' + pid);
  await killTree(pid);
  return true;
}
async function startChat(s) {
  const mp = modelPath(s.model);
  if (!fs.existsSync(mp)) throw new Error('模型文件不存在（可能还在下载）：' + mp);
  if (s.vision) { const mm = mmprojPath(s.model); if (!mm) throw new Error('这个模型没有视觉塔文件，无法开启识图：' + s.model); if (!fs.existsSync(mm)) throw new Error('视觉塔文件不存在（可能还在下载）：' + mm); }
  await killStaleChat();
  const args = buildArgs(s);
  chat.args = args;
  log('starting llama-server: ' + args.join(' '));
  appendFile(CHAT_LOG, '\n===== ' + new Date().toISOString() + ' llama-server ' + args.join(' ') + '\n');
  const out = fs.openSync(CHAT_LOG, 'a');
  const proc = spawn(path.join(BIN_DIR, 'llama-server.exe'), args, { cwd: BIN_DIR, stdio: ['ignore', out, out], windowsHide: true });
  chat.proc = proc; chat.startedAt = Date.now();
  fs.writeFileSync(PID_FILE, String(proc.pid), 'utf8');
  proc.on('exit', (code, sig) => {
    log('llama-server exited code=' + code + ' sig=' + sig);
    if (chat.proc === proc) chat.proc = null;
  });
  return proc.pid;
}
async function stopChat() {
  const pid = chat.proc ? chat.proc.pid : null;
  if (pid) { log('stopping llama-server pid ' + pid); await killTree(pid); }
  else { const p = await pidOnPort(CHAT_PORT); if (p) { const n = await procImageName(p); if (/llama-server/i.test(n)) await killTree(p); } }
  chat.proc = null;
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
}
async function waitChatReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const h = await chatHealth();
    if (h && h.status === 'ok') return true;
    await sleep(500);
  }
  return false;
}
async function setLoraScale(port, scale) {
  const r0 = await httpJson(port, '/lora-adapters', 'GET', undefined, 8000);
  let list = r0.json;
  if (list && !Array.isArray(list) && Array.isArray(list.value)) list = list.value;
  if (list && !Array.isArray(list) && typeof list === 'object' && list.id !== undefined) list = [list];
  if (!Array.isArray(list) || !list.length) return { ok: false, error: 'no lora adapter mounted', raw: r0.text };
  const aid = Number(list[0].id || 0);
  const body = '[{"id":' + aid + ',"scale":' + Number(scale).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 3 }) + '}]';
  const r1 = await httpJson(port, '/lora-adapters', 'POST', JSON.parse(body), 8000);
  // httpJson re-serialises, which keeps the array shape; verify anyway
  const ok = !!(r1.json && (r1.json.success === true || r1.status === 200));
  return { ok, adapterId: aid, status: r1.status, raw: r1.text };
}

/* ============================== IMAGE BRIDGE ============================= */
const bridge = { proc: null, startedAt: 0 };

async function imageHealth() {
  try { const r = await httpJson(IMG_PORT, '/api/health', 'GET', undefined, 4000); return r.json; }
  catch (_) { return null; }
}
async function imageAlive() { return !!(await imageHealth()); }
async function killStaleBridge() {
  const pid = await pidOnPort(IMG_PORT);
  if (!pid) return false;
  const name = await procImageName(pid);
  if (!/python/i.test(name)) { log('port ' + IMG_PORT + ' held by ' + name + ' -- left alone'); return false; }
  log('killing stale bridge pid ' + pid);
  await killTree(pid);
  return true;
}
/* The bridge's HTTP server answers /api/health the instant it is listening, but the
 * ComfyUI process it supervises is still booting at that point. Until the bridge's
 * ENV_STATE flips to "ready", /api/generate answers
 *   {"ok":false,"error":"绘图内核还没就绪，等一下再点。","starting":true}
 * Reporting "image side is up" on the HTTP-200 signal alone makes the FIRST generate
 * after every switch fail -- this is exactly what broke the cross-modal tool call
 * (the model dutifully retried four times and got "still warming up" every time). */
async function waitBridgeReady(timeoutMs = 240000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    let h = null;
    try { h = (await httpJson(IMG_PORT, '/api/health', 'GET', undefined, 5000)).json; } catch (_) { h = null; }
    if (h) {
      last = h.state || h.message || null;
      if (h.state === 'ready') return { ok: true, waited: Date.now() - t0 };
      if (h.state === 'failed') throw new Error('绘图内核启动失败：' + (h.error || h.message || 'unknown'));
    }
    await sleep(1000);
  }
  throw new Error('绘图内核 ' + Math.round(timeoutMs / 1000) + 's 内没就绪（最后状态：' + last + '）');
}

async function startBridge() {
  await killStaleBridge();
  if (!fs.existsSync(PY_EXE)) throw new Error('python not found: ' + PY_EXE);
  if (!fs.existsSync(BRIDGE_PY)) throw new Error('bridge not found: ' + BRIDGE_PY);
  const env = Object.assign({}, process.env, {
    QWEN_STUDIO_PORT: String(IMG_PORT),
    QWEN_STUDIO_NO_WINDOW: '1',
    QWEN_STUDIO_CLEANUP: '1',
    PYTHONIOENCODING: 'utf-8',
  });
  appendFile(BRIDGE_LOG, '\n===== ' + new Date().toISOString() + ' bridge start (port ' + IMG_PORT + ')\n');
  const out = fs.openSync(BRIDGE_LOG, 'a');
  const proc = spawn(PY_EXE, ['-u', BRIDGE_PY], { cwd: IMAGE_DIR, env, stdio: ['ignore', out, out], windowsHide: true });
  bridge.proc = proc; bridge.startedAt = Date.now();
  fs.writeFileSync(BRIDGE_PID_FILE, String(proc.pid), 'utf8');
  proc.on('exit', (code) => { log('bridge exited code=' + code); if (bridge.proc === proc) bridge.proc = null; });
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    if (await imageAlive()) break;
    await sleep(700);
  }
  if (!(await imageAlive())) throw new Error('bridge did not become healthy in 40s (see app/logs/bridge.log)');
  await waitBridgeReady();
  return proc.pid;
}
async function stopBridge() {
  try { await httpJson(IMG_PORT, '/api/quit', 'POST', {}, 5000); } catch (_) {}
  const pid = bridge.proc ? bridge.proc.pid : await pidOnPort(IMG_PORT);
  const t0 = Date.now();
  while (pid && Date.now() - t0 < 8000) {
    const still = await pidOnPort(IMG_PORT);
    if (!still) break;
    await sleep(400);
  }
  if (await pidOnPort(IMG_PORT)) { if (pid) await killTree(pid); }
  bridge.proc = null;
  try { fs.unlinkSync(BRIDGE_PID_FILE); } catch (_) {}
}
async function comfyAlive() {
  try { const r = await httpJson(COMFY_PORT, '/system_stats', 'GET', undefined, 4000); return r.status === 200; }
  catch (_) { return false; }
}
async function comfyFree() {
  try {
    const r = await httpJson(COMFY_PORT, '/free', 'POST', { unload_models: true, free_memory: true }, 15000);
    return { ok: r.status === 200, status: r.status };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function imageProxy(p, method, body, timeout) {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { 'accept': '*/*' };
  if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
  return httpReq({ host: '127.0.0.1', port: IMG_PORT, path: p, method: method || 'GET', headers, timeout: timeout || 60000 }, data);
}

/* ================================ ARBITER ================================ */
let gate = Promise.resolve();
function withGate(fn) {
  const run = gate.then(fn, fn);
  gate = run.then(() => {}, () => {});
  return run;
}
const arb = { mode: 'idle', switching: null, lastError: null, chatMode: 'full' };

async function ensureChat(opts) {
  const o = opts || {};
  const s = readSettings();
  // LoRA strength or other soft settings that must be re-asserted after a start
  if (!o.force) {
    const alive = await chatAlive();
    if (alive) {
      if (arb.mode !== 'chat') { arb.mode = 'chat'; }
      if (s.lora && s.lora !== 'none' && Number(s.loraScale) !== 1) {
        // re-assert every time we (re)enter chat mode; cheap and idempotent
        if (!ensureChat._loraApplied || ensureChat._loraApplied !== s.lora + '@' + s.loraScale) {
          if (await chatReady()) {
            const r = await setLoraScale(CHAT_PORT, s.loraScale);
            appendFile(CHAT_LOG, '# applied lora scale ' + s.loraScale + ' -> ' + (r.raw || '') + '\n');
            if (r.ok) ensureChat._loraApplied = s.lora + '@' + s.loraScale;
          }
        }
      }
      return { started: false };
    }
  }
  // 强杀/重启我们自己的引擎时，必须先把进程停掉再等显存：否则下面 waitVramBelow
  // 监控的是我们自己占着的那 6-7 GB，只能一路等到 RELEASE_TIMEOUT（默认 45s）白等。
  if (await chatAlive()) {
    arb.switching = { target: 'chat', since: Date.now(), note: '正在重启对话引擎…' };
    try { await releaseChat(); } catch (_) { arb.switching = null; }
  }
  arb.switching = { target: 'chat', since: Date.now(), note: '正在释放显存…' };
  try {
    await releaseImage();
    const w = await waitVramBelow(RELEASE_TARGET, RELEASE_TIMEOUT);
    log('vram before chat start: ' + JSON.stringify(w));
    arb.switching.note = '正在加载对话模型…';
    await startChat(s);
    const ok = await waitChatReady(120000);
    if (!ok) throw new Error('llama-server did not become ready in 120s');
    arb.mode = 'chat';
    ensureChat._loraApplied = null;
    if (s.lora && s.lora !== 'none' && Number(s.loraScale) !== 1) {
      const r = await setLoraScale(CHAT_PORT, s.loraScale);
      appendFile(CHAT_LOG, '# applied lora scale ' + s.loraScale + ' -> ' + (r.raw || '') + '\n');
      if (r.ok) ensureChat._loraApplied = s.lora + '@' + s.loraScale;
    }
    return { started: true, waited: w };
  } finally { arb.switching = null; }
}

async function releaseChat() {
  if (await chatAlive()) { await stopChat(); }
  else { await killStaleChat(); }
  if (arb.mode === 'chat') arb.mode = 'idle';
}

async function releaseImage() {
  if (!(await imageAlive())) { arb.mode = arb.mode === 'image' ? 'idle' : arb.mode; return { stopped: false }; }
  // Preferred: let ComfyUI drop its weights without killing the process (fast reload later).
  if (await comfyAlive()) {
    const f = await comfyFree();
    log('comfy /free -> ' + JSON.stringify(f));
    const w = await waitVramBelow(RELEASE_TARGET, 20000);
    if (w.ok) { arb.mode = 'idle'; return { stopped: false, freed: true, used: w.used }; }
    log('comfy /free did not free enough (used=' + w.used + '), quitting bridge instead');
  }
  await stopBridge();
  arb.mode = 'idle';
  return { stopped: true };
}

async function ensureImage() {
  if (await imageAlive()) {
    arb.mode = 'image';
    // A live bridge is not necessarily a READY bridge (it may still be booting the
    // ComfyUI it supervises), so this path has to wait too.
    await waitBridgeReady();
    const env = await imageHealth();
    return { started: false, env };
  }
  arb.switching = { target: 'image', since: Date.now(), note: '正在停掉对话模型…' };
  try {
    await releaseChat();
    await waitVramBelow(RELEASE_TARGET, RELEASE_TIMEOUT);
    arb.switching.note = '正在启动绘图内核…（首次要加载 7 GB 权重，约 30–60 秒）';
    await startBridge();
    arb.mode = 'image';
    return { started: true, env: await imageHealth() };
  } finally { arb.switching = null; }
}

/* 桥没跑时自己弹 Windows 文件夹选择框：嵌入式 Python 没有 tkinter，桥用的是
 * PowerShell 的 WinForms FolderBrowserDialog，这里复刻同一套（必须 -STA，选择结果
 * 用 UTF-8 写进临时文件再读，中文路径经管道回来才不会变成乱码）。设完只落盘，
 * 不碰 ComfyUI —— 桥下次启动时会从 image/settings.json 读到新的 output_dir。 */
/* Agent 工作目录的选择框：只把选中的路径回给前端，落盘交给 /api/settings —— 跟出图目录
 * 不同，这里不写任何文件。带 path 进来就直接用（自动化测试走这条，不会在桌面上闪框）。 */
function pickFolderDialog(title, cur, tmpName) {
  return new Promise((resolve) => {
    const tmp = path.join(APP_DIR, tmpName || 'pick-agent-dir.tmp');
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null;',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
      '$d.Description = $env:LM_PICK_TITLE;',
      '$d.SelectedPath = $env:LM_PICK_CUR;',
      '$d.ShowNewFolderButton = $true;',
      "$r = '';",
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $r = $d.SelectedPath };',
      '[System.IO.File]::WriteAllText($env:LM_PICK_OUT, $r, [System.Text.Encoding]::UTF8)',
    ].join(' ');
    /* WinForms 在 pwsh 7 上可用（Add-Type -AssemblyName System.Windows.Forms），且 PS7 在
     * Windows 上默认就是 STA，不用再传 -STA；5.1 兜底时才补上。 */
    const pickArgs = PS_SHELL.pwsh
      ? ['-NoProfile', '-Command', ps]
      : ['-NoProfile', '-STA', '-Command', ps];
    execFile(PS_SHELL.exe, pickArgs, {
      timeout: 300000, windowsHide: true,
      env: Object.assign({}, process.env, { LM_PICK_TITLE: title, LM_PICK_CUR: cur || '', LM_PICK_OUT: tmp }),
    }, (err, stdout, stderr) => {
      let sel = '';
      try { sel = fs.readFileSync(tmp, 'utf8').replace(/^\uFEFF/, '').trim(); } catch (_) {}
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (!sel) {
        if (err) {
          const first = String(stderr || err.message || '').split(/\r?\n/)[0].slice(0, 200);
          return resolve({ ok: false, error: '文件夹选择框出错：' + first });
        }
        return resolve({ ok: true, cancelled: true, dir: cur || '' });
      }
      return resolve({ ok: true, dir: sel });
    });
  });
}
function pickOutputDirFallback(body) {
  return new Promise((resolve) => {
    const setFile = path.join(IMAGE_DIR, 'settings.json');
    const tmp = path.join(IMAGE_DIR, 'pick-dir.tmp');
    let cur = '';
    try { cur = String((JSON.parse(fs.readFileSync(setFile, 'utf8')) || {}).output_dir || ''); } catch (_) {}

    // 跟桥的 api_pick_output_dir 同一套契约：带 path 就直接用，不弹框
    // （自动化测试也走这条，免得在用户桌面上闪一个模态对话框）。
    const want = body && typeof body.path === 'string' ? body.path.trim() : '';
    const apply = (sel) => {
      let abs;
      try { abs = path.resolve(sel); } catch (_) { abs = sel; }
      // 跟桥一致：目录建不出来就报错、不落盘（别把配置改成写不进去的路径）
      try { fs.mkdirSync(abs, { recursive: true }); } catch (e) {
        return resolve({ ok: false, error: '建不了这个目录：' + String((e && e.message) || e) });
      }
      try {
        let st = {};
        try { st = JSON.parse(fs.readFileSync(setFile, 'utf8')); } catch (_) { st = {}; }
        if (!st || typeof st !== 'object') st = {};
        st.output_dir = abs;
        fs.writeFileSync(setFile, JSON.stringify(st, null, 2).replace(/\n/g, '\r\n'), 'utf8');
      } catch (e) {
        return resolve({ ok: false, error: '改不了这个目录：' + String((e && e.message) || e) });
      }
      log('output dir -> ' + abs + ' (bridge down; written to image/settings.json)');
      resolve({ ok: true, dir: abs });
    };
    if (want) { apply(want); return; }

    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null;',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
      "$d.Description = '选择出图的保存文件夹';",
      '$d.SelectedPath = $env:QWEN_OUT_DIR;',
      '$d.ShowNewFolderButton = $true;',
      "$r = '';",
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $r = $d.SelectedPath };',
      '[System.IO.File]::WriteAllText($env:QWEN_PICK_OUT, $r, [System.Text.Encoding]::UTF8)',
    ].join(' ');
    const pickArgs = PS_SHELL.pwsh
      ? ['-NoProfile', '-Command', ps]
      : ['-NoProfile', '-STA', '-Command', ps];
    execFile(PS_SHELL.exe, pickArgs, {
      timeout: 300000, windowsHide: true,
      env: Object.assign({}, process.env, { QWEN_OUT_DIR: cur, QWEN_PICK_OUT: tmp }),
    }, (err, stdout, stderr) => {
      let sel = '';
      try { sel = fs.readFileSync(tmp, 'utf8').replace(/^\uFEFF/, '').trim(); } catch (_) {}
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (!sel) {
        if (err) {
          const first = String(stderr || err.message || '').split(/\r?\n/)[0].slice(0, 200);
          return resolve({ ok: false, error: '文件夹选择框出错：' + first });
        }
        return resolve({ ok: true, cancelled: true, dir: cur });
      }
      apply(sel);
    });
  });
}

/* ------------------------------------------------- image job (poll based) */
/* 一张图的等待上限。以前这个 15 分钟写死在下面的 while 里，现在给它一个名字。
 * 也可以用环境变量 LOCALMODEL_IMAGE_TIMEOUT_MS 临时改（故障注入测试要的就是这个）。 */
const IMAGE_JOB_TIMEOUT_MS = Math.max(20000, Number(process.env.LOCALMODEL_IMAGE_TIMEOUT_MS) || 15 * 60 * 1000);
async function runImageJob(params, files, onProgress) {
  // The image bridge treats a MISSING (or null / "random") seed as "pick one for me".
  // It does NOT understand -1: that value goes straight into ComfyUI's KSampler, which
  // rejects the entire prompt with "Value -1 smaller than min of 0: seed" and answers
  // 400 with a bare traceback. -1 is exactly what the chat side uses for "random", so
  // strip it here rather than trusting every caller to remember.
  const p = Object.assign({}, params);
  if (p.seed !== undefined && p.seed !== null && p.seed !== '') {
    const n = Number(p.seed);
    if (!Number.isFinite(n) || n < 0) delete p.seed; else p.seed = Math.trunc(n);
  }
  const submit = await imageProxy('/api/generate', 'POST', { params: p, files: files || [] }, 30000);
  let j = null;
  try { j = JSON.parse(submit.body.toString('utf8')); } catch (_) {}
  if (!j || j.ok !== true) {
    if (j && j.busy) throw new Error('绘图内核正忙（上一张还没画完）');
    throw new Error((j && j.error) || ('submit failed: HTTP ' + submit.status));
  }
  log('submit -> engine ok: ' + (p.width || '?') + 'x' + (p.height || '?') + ' steps=' + (p.steps || '?') +
      ' ref=' + ((files || []).length) + ' prompt="' + String(p.prompt || '').slice(0, 60) + '"');
  const t0 = Date.now();
  let last = '';
  let lastBeat = 0;
  let dead = 0;
  while (Date.now() - t0 < IMAGE_JOB_TIMEOUT_MS) {
    await sleep(1200);
    let st = null;
    try {
      const r = await imageProxy('/api/status', 'GET', undefined, 10000);
      st = JSON.parse(r.body.toString('utf8'));
      dead = 0;
    } catch (_) {
      /* 桥掉线了。以前这里是 `continue` —— 于是对着一具尸体白轮询满 15 分钟，用户
       * 只看到界面沉默一刻钟然后报错。连不上十几次（≈15 秒）就直接收场。 */
      if (++dead >= 12) {
        throw new Error('绘图内核（端口 ' + IMG_PORT + '）掉线了，这张图没法再等下去。请重试一次；如果反复掉线，去「出图」页跑一次自检。');
      }
      continue;
    }
    const jb = st.job || st;
    const line = (jb.state || '') + ' ' + (jb.step || 0) + '/' + (jb.total_steps || 0) + ' ' + ((jb.images || []).length);
    if (line !== last) { last = line; lastBeat = Date.now(); if (onProgress) onProgress(jb, false); }
    /* 一大张图可能好几分钟都不动一步：每 20 秒也报一次心跳，界面别一直沉默。 */
    else if (Date.now() - lastBeat >= 20000) { lastBeat = Date.now(); if (onProgress) onProgress(jb, true); }
    if (jb.state === 'done') return { ok: true, job: jb };
    if (jb.state === 'error') throw new Error(jb.error || '生成失败');
  }
  /* 超时了：先让桥把这一张停掉（它转发 ComfyUI 的 /interrupt），否则 GPU 会继续烧很久。 */
  try { await imageProxy('/api/cancel', 'POST', {}, 8000); log('image job timed out -- asked the bridge to cancel it'); }
  catch (e) { log('cancel after timeout failed: ' + String(e.message || e)); }
  throw new Error('生成超时（' + Math.round(IMAGE_JOB_TIMEOUT_MS / 60000) + ' 分钟）：'
    + (p.width || 1024) + '×' + (p.height || 1024) + '、' + (p.steps || 8) + ' 步这张图本机画不完，已经让绘图内核停下了。'
    + '把尺寸降到 1024×1024、步数降到 8 会快很多（约半分钟）。');
}

/* ------------------------- native tool: generate_image ------------------- */
const IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Generate an image locally with the Qwen-Image-2.1 model. Use this whenever the user asks you to draw, paint, render or create a picture. Keep the size small: 1024x1024 at 8 steps takes about a minute in total (the GPU must unload the chat model first); anything bigger takes many minutes and a 4K-size request will be cut down automatically. If the user says "same size as the original" / 「按原图尺寸」, read that image with read_document first and use the pixel size it prints in 「图片尺寸」 — never parse image bytes yourself. Write no more than one short sentence before calling it.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed English or Chinese description of the image to generate.' },
        negative: { type: 'string', description: 'Things to avoid in the image.' },
        width: { type: 'integer', description: 'Image width in pixels, default 1024. This machine draws comfortably at 1024x1024; over 1536 on the long edge (or over ~2.4 megapixels) is scaled back automatically.' },
        height: { type: 'integer', description: 'Image height in pixels, default 1024.' },
        steps: { type: 'integer', description: 'Sampling steps, default 8 and capped at 20 (the installed Pruna LoRA is an 8-step one; more steps only makes it slower).' },
        seed: { type: 'integer', description: 'Random seed. Omit entirely for a random image; never pass -1.' },
      },
      required: ['prompt'],
    },
  },
};

/* ---------------------- agent 工具带（参考 opencode 的 primary agent） -----
 * Build = 全工具，Plan = 只读。工具集刻意保持小：看（list_files / read_file / grep）、
 * 改（write_file / edit_file / run_command）、外加联网（web_search / web_fetch）与出图。
 * 写文件与执行命令默认「每次询问」：9B 模型的参数偶尔会指向错的文件，让人先看一眼
 * 再落地，比事后回滚便宜。权限在设置里可改成直接允许 / 禁止。 */
const AGENT_READONLY = new Set(['list_files', 'read_file', 'read_document', 'grep', 'web_search', 'web_fetch']);
const AGENT_SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__pycache__', '.venv', 'venv', 'env', '.idea', '.vscode', 'edge-profile', 'edge-profile2', '.npm-cache', 'logs', 'session-files', 'doc-files', 'dist', 'build', '.next']);
const AGENT_MAX_ENTRIES = 400;
const AGENT_MAX_MATCHES = 60;
/* 条数之外再加一道字符闸：400 条目录项 / 60 条匹配能一次灌进去两三万字，32K 上下文会被吃掉大半。 */
const LIST_MAX_CHARS = 8000;
const GREP_MAX_CHARS = 8000;

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出目录里的文件和子目录（最多 400 条 / 8000 字，超了会截断并说明）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径（例如 C:\\Users\\LEGION\\Desktop）或相对工作目录的路径，省略表示工作目录本身。读操作不受沙箱档位限制。' },
          pattern: { type: 'string', description: '文件名通配符，例如 *.md 或 **/*.js；省略则只列一层。' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取一个文本文件或文档的内容。文本与代码带行号（offset 是行号，方便后续精确替换）；'
        + '.json/.csv/.html/PDF/Office 这类会交给文档解析器，那时 offset 是字符位置、返回值里也没有行号（会写明）。'
        + '同一个文件同一段范围重复读只会得到「没有变化」的提示。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径（可以是工作目录外的任何文件，例如 C:\\Windows\\Web\\Wallpaper\\ThemeC\\img28.jpg）或相对工作目录的路径。读操作不受沙箱档位限制。' },
          offset: { type: 'integer', description: '起始行号，从 1 开始。' },
          limit: { type: 'integer', description: '最多读多少行，默认 400、上限 600。' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: '在文本文件里搜正则，返回「文件:行号: 内容」（最多 60 条 / 8000 字，超了会截断；没扫完会明确说明）。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式，例如 repeat_penalty。' },
          path: { type: 'string', description: '限定搜索的目录或文件（可用工作目录外的绝对路径），省略表示工作目录。' },
          include: { type: 'string', description: '只看文件名匹配的，例如 *.js、*.md。' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写一个文本文件（已存在就整篇覆盖）。只在新建文件或整篇重写时用；改几行请用 edit_file。'
        + '写 .ps1/.psm1/.bat/.cmd 时会自动补上 PowerShell 5.1 需要的 UTF-8 BOM，写完直接 run_command 跑就行。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对于工作目录的文件路径。' },
          content: { type: 'string', description: '完整的文件内容。' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description: '读取一个文档（PDF / Word / Excel / PPT / RTF / HTML / CSV 等）或图片并返回纯文本。贴给对话的通常只是开头，需要后面的内容就用这个工具带 offset 继续读。图片、扫描件 PDF、以及文字层坏掉的 PDF（抽出来是乱码/问号的）没有可用文字，这里会自动把页面渲染成图、交给本机视觉模型逐页读出来（不需要 OCR，但会慢一些，一次读几页）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径或相对工作目录的文档路径（也可以是图片：jpg/png/webp）。读操作不受沙箱档位限制。' },
          offset: { type: 'integer', description: '从第几个字符开始读（默认 0）。返回值里会告诉下次该带多少。' },
          limit: { type: 'integer', description: '最多读多少字符，默认 8000、上限 20000。' },
          sheet: { type: 'integer', description: 'Excel 专用：只看第几个工作表（从 1 开始）。' },
          page: { type: 'integer', description: '扫描件 / 图片专用：从第几页开始读（默认 1）。一次会读设置里的那几页，返回值里会说后面还有多少页。' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_document',
      description: '把内容生成一个文档文件：.md / .txt / .csv / .json / .html / .docx（Word）/ .xlsx（Excel）/ .pdf 都能写。content 用 Markdown 写正文，Word 与 PDF 会自动排版。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标路径，扩展名决定格式。写操作受沙箱限制：只有「工作区内修改」档（限工作目录内）与「完全权限」档（任意路径）能写。' },
          content: { type: 'string', description: '文档内容（Markdown）。生成 Excel 时可以是 Markdown 表格或 CSV 文本。' },
          sheets: { type: 'array', description: 'xlsx 专用：多工作表。每项 {"name":"表名","rows":[["列1","列2"],["a","b"]]}。给了它就忽略 content。', items: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array' } } } } },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '把文件里的一段原文精确替换成新内容。old_string 必须与文件里的原文逐字一致（含空格缩进），并且唯一。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径：相对工作目录，或（在「完全权限」档下）任意绝对路径。写操作受沙箱限制。' },
          old_string: { type: 'string', description: '要被替换掉的原文。' },
          new_string: { type: 'string', description: '替换成的新内容。' },
          replace_all: { type: 'boolean', description: 'old_string 出现多次时是否全部替换，默认 false。' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '用 Windows PowerShell 5.1 执行一段（可以多行的）命令/脚本，返回退出码与输出。'
        + '注意：只有 PowerShell 5.1，不支持 && 与 ||（用 ; 分隔，条件继续用 if ($?) { … }）；不要用会等人输入的命令'
        + '（Read-Host / pause / more / Out-GridView / 不带 -m 的 git commit）——后台没有键盘，只会卡到超时；'
        + '输出最多 12000 字，先用 Select-Object -First 20 / Where-Object / -Filter 把结果收窄；'
        + '默认超时 60 秒，装依赖、构建这类慢命令传 timeoutMs（最多 600000）。'
        + '执行目录必须在工作目录内（「完全权限」档下不限）。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 PowerShell 5.1 脚本，可以多行。例如 Get-ChildItem -Name、node --version、Get-Item 文件 | Select-Object Length。' },
          cwd: { type: 'string', description: '执行目录：相对工作目录（必须落在工作目录内；「完全权限」档下也可以是绝对路径），省略表示工作目录本身。' },
          timeoutMs: { type: 'number', description: '超时毫秒数，默认 60000，最大 600000。只在装依赖、构建、跑长脚本时调大。' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_permission',
      description: '申请一次性放行。当你被沙箱拒绝（工具返回里带 [sandbox: file access denied under … mode]），'
        + '而你又确信这一步确实必须做时，调用本工具说明理由：用户在卡片上点「允许」后，你原样重试刚才那次调用一次，'
        + '这一次会以「完全权限」执行；只放行这一次。用户点「拒绝」就是最终决定，立刻停下并用中文说明卡在哪里。'
        + '不要用它试探边界，也不要被拒后换别的工具或命令绕过。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['write', 'exec'], description: 'write＝要写/改文件；exec＝要执行命令。' },
          target: { type: 'string', description: '要放行的目标：写文件时给绝对路径（或它所在的目录），执行命令时给命令本身。' },
          reason: { type: 'string', description: '为什么非做这一步不可（中文，一两句，给用户看的）。' },
        },
        required: ['action', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '用 Bing 搜一下互联网，返回标题、链接与摘要。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词。' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取一个网页并转成纯文本（最多 8000 字）。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http/https 链接。' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: IMAGE_TOOL.function.description,
      parameters: IMAGE_TOOL.function.parameters,
    },
  },
];
const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map(t => t.function.name));

function agentRootDir() {
  const s = readSettings();
  const raw = String(s.agentRoot || '').trim() || path.resolve(APP_DIR, '..');
  let abs = raw;
  try { abs = path.resolve(raw); } catch (_) { abs = raw; }
  /* 目录不存在就建出来：设置里填了一个还没建的路径时，第一个工具就报「路径不存在」
   * 会让模型一头雾水（它会去猜是不是要找别的目录）。建目录失败就原样返回，让工具去报错。 */
  try { fs.mkdirSync(abs, { recursive: true }); } catch (_) {}
  return abs;
}
/* ------------------------ 沙箱：照 DeepSeek Harness 的三档 ------------------------
 * 档位 key readonly / workspace / full ↔ DSH 沙箱模式 read-only / workspace-write /
 * danger-full-access，语义也照搬（读过 DSH 的 dsh-sandbox / dsh-fs-sandbox 源码）：
 *   · 读文件：三档都不限制 —— DSH 的 read-only 也只禁「写」，不禁「读」。
 *   · 写文件：readonly 一个字节也不许写；workspace 只许写工作目录内；full 不设栅栏。
 *   · 执行命令：readonly 每次都要用户点允许（命令可能写文件）；workspace 看 agentPermExec；
 *     full 直接放行。
 * 越界时抛的错误串照 DSH 的标记写（模型认得 [sandbox: …] 前缀，知道这是沙箱拒绝而不是
 * 路径写错），并附上「申请一次性放行」的指引：用户点允许后原样重试一次即放行。 */
const AGENT_PERM_KEYS = ['readonly', 'workspace', 'full'];
const AGENT_PERM_MODE = { readonly: 'read-only', workspace: 'workspace-write', full: 'danger-full-access' };
const AGENT_PERM_LABEL = { readonly: '仅可查看', workspace: '工作区内修改', full: '完全权限' };
function agentPermKey(s) {
  const raw = String((s && s.agentPerm) || '').trim();
  if (AGENT_PERM_KEYS.indexOf(raw) >= 0) return raw;
  return (s && s.agentMode === 'plan') ? 'readonly' : 'workspace';   // 老配置（只有 off/build/plan）的兼容写法
}
function agentSandbox(s, mode, perm) {
  const want = String(perm || '').trim();
  const key = mode === 'plan' ? 'readonly'
    : (AGENT_PERM_KEYS.indexOf(want) >= 0 ? want : agentPermKey(s));
  return { key: key, mode: AGENT_PERM_MODE[key], label: AGENT_PERM_LABEL[key] };
}
function sandboxHint(kind) {
  return '\n[sandbox: escalation available — 如果这一步确实必须做，调用 request_permission' +
    '（action: ' + (kind === 'exec' ? "'exec'" : "'write'") + '，写清 target 与 reason）申请一次性放行；' +
    '用户点「允许」后，原样重试刚才那次调用一次即可。不要换工具、也不要绕路。]';
}
function agentDeniedText(sandboxMode, detail, kind) {
  return '[sandbox: file access denied under ' + sandboxMode + ' mode] ' + detail + sandboxHint(kind);
}
function isUnderPath(abs, root) {
  const a = String(abs).toLowerCase().replace(/[\\/]+$/, '');
  const b = String(root).toLowerCase().replace(/[\\/]+$/, '');
  return a === b || a.indexOf(b + path.sep) === 0 || a.indexOf(b + '/') === 0;
}
/* 工具回给模型的路径显示：工作目录内给相对路径；在三档权限下读到目录外是常态，
 * 这时候给绝对路径 —— "../../../Windows/win.ini" 这种相对路径模型很容易看错自己在动哪里。 */
function agentShowPath(root, abs) {
  return isUnderPath(abs, root) ? (path.relative(root, abs).replace(/\\/g, '/') || '.') : String(abs);
}
/* 路径解析 + 栅栏。opts.kind：
 *   'read'   读：三档都放行整机
 *   'write'  写：按档位（readonly 一律拒 —— 工作目录里也不许写；workspace 只许工作目录内；full 不限）
 *   'inside' 必须是工作目录里的东西（命令的 cwd，以及不传 opts 时的老语义）
 * opts.sandbox：'read-only' | 'workspace-write' | 'danger-full-access'（不传按 workspace-write 保守处理）
 * opts.readAppDirs：额外放行程序自己的两个存储目录 —— 用户贴进对话的文件就存在那里
 *   （app\doc-files / app\session-files），它们天然在工作目录之外，但那是用户自己交进来的内容。
 * 不传 opts 的老调用点（/api/agent/reveal 之类）行为与从前完全一致：必须在工作目录内。 */
function agentAbs(rel, root, opts) {
  const o = opts || {};
  const kind = o.kind || 'inside';
  const sb = o.sandbox || 'workspace-write';
  const raw0 = String(rel === undefined || rel === null ? '' : rel).trim().replace(/^["']|["']$/g, '');
  /* %TEMP% / $env:TEMP 先展开：模型爱这么写，不展开就会在工作目录下真建一个「%TEMP%」目录。 */
  const ex = expandEnvInPath(raw0);
  if (ex.missing) throw new Error('路径里的环境变量 %' + ex.missing + '% 在这台机器上取不到值。可用的有 %TEMP% / %USERPROFILE% / %APPDATA%，或者直接写完整路径。');
  const abs = path.resolve(root, ex.path || '.');
  if (kind === 'read') return abs;                           // 读：整机放行（含 C:\ 这类绝对路径）
  /* 只读档先于「工作目录内」判定：DSH 的 read-only 连工作区里的文件也不许写。 */
  if (kind === 'write' && sb === 'read-only') throw new Error(agentDeniedText(sb, '当前是「仅可查看」档，不能写任何文件：' + abs, 'write'));
  if (sb === 'danger-full-access') return abs;               // 完全权限：写也不设栅栏
  if (isUnderPath(abs, root)) return abs;
  if (o.readAppDirs) {
    for (const dir of [DOC_DIR, SESS_DIR]) if (isUnderPath(abs, dir)) return abs;
  }
  throw new Error(agentDeniedText(sb, '路径不在工作目录内：' + abs + '（工作目录是 ' + path.resolve(root) + '）', 'write'));
}
function globToRe(pat) {
  const s = String(pat)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '.')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*');
  return new RegExp('^' + s + '$', 'i');
}
function agentWalk(base, cb, maxDepth) {
  const depth = maxDepth || 10;
  const stack = [{ d: base, n: 0 }];
  let seen = 0;
  while (stack.length && seen < AGENT_MAX_ENTRIES * 8) {
    const cur = stack.shift();
    let ents;
    try { ents = fs.readdirSync(cur.d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      seen++;
      if (e.isDirectory()) {
        const isDir = true;
        cb(path.join(cur.d, e.name), e.name, isDir);
        if (cur.n < depth && !AGENT_SKIP_DIRS.has(e.name.toLowerCase())) stack.push({ d: path.join(cur.d, e.name), n: cur.n + 1 });
      } else if (e.isFile()) {
        cb(path.join(cur.d, e.name), e.name, false);
      }
      if (seen >= AGENT_MAX_ENTRIES * 8) break;
    }
  }
  return seen >= AGENT_MAX_ENTRIES * 8;   // true = 撞上条目上限、没走完，调用方要如实说明
}
function toolListFiles(args, root, sb) {
  const base = agentAbs((args && args.path) || '.', root, { kind: 'read', sandbox: sb });
  let st; try { st = fs.statSync(base); } catch (_) { return { ok: false, text: '路径不存在：' + base }; }
  if (!st.isDirectory()) return { ok: true, text: base + ' 是文件，不是目录（要看内容请用 read_file）。' };
  const pat = String((args && args.pattern) || '').trim();
  const re = pat ? globToRe(pat) : null;
  const out = [];
  let walkCapped = false;
  const rel = (p) => agentShowPath(root, p) || '.';
  if (!pat || pat.indexOf('*') < 0) {
    let ents = [];
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return { ok: false, text: '读不了这个目录：' + e.message }; }
    ents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1)));
    for (const e of ents) {
      if (e.isDirectory() && AGENT_SKIP_DIRS.has(e.name.toLowerCase())) continue;
      if (out.length >= AGENT_MAX_ENTRIES) break;
      out.push(rel(path.join(base, e.name)) + (e.isDirectory() ? '/' : ''));
    }
  } else {
    walkCapped = agentWalk(base, (full, name, isDir) => {
      const r = rel(full);
      if (re.test(r) || re.test(name) || (isDir && re.test(name + '/'))) out.push(r + (isDir ? '/' : ''));
    });
  }
  const head = '目录：' + rel(base) + (pat ? '（匹配 ' + pat + '）' : '') + '\n';
  if (!out.length) return { ok: true, text: head + (pat ? '(没有匹配的条目)' : '(这个目录是空的)') };
  const uniq = Array.from(new Set(out)).slice(0, AGENT_MAX_ENTRIES);
  let text = head + uniq.join('\n') + (uniq.length >= AGENT_MAX_ENTRIES ? '\n…（条目太多，已截断，请用 pattern 缩小范围）' : '');
  if (text.length > LIST_MAX_CHARS) {
    text = clipText(text, LIST_MAX_CHARS) + '\n…（列表太长，已截断；用 pattern 收窄，或一次只看一个子目录）';
  }
  if (walkCapped) text += '\n（注意：文件太多，这次只列了一部分、没有列完）';
  return { ok: true, text };
}
/** 单次 read_file 最多回这么多字符（行数上限之外的第二道闸，防止挤爆上下文）。 */
const READ_MAX_CHARS = 14000;
function toolReadFile(args, root, sb) {
  const abs = agentAbs(args && args.path, root, { kind: 'read', sandbox: sb });
  let st; try { st = fs.statSync(abs); } catch (_) { return { ok: false, text: '文件不存在：' + abs }; }
  if (st.isDirectory()) return { ok: false, text: abs + ' 是目录，请用 list_files。' };
  /* 文档（PDF / Word / Excel / PPT / RTF / HTML/CSV…）交给文档解析器：模型不必先知道
     这是什么格式，read_file 也能读出正文；纯文本与代码仍旧走下面的「带行号」读取。 */
  const k0 = DOC.kindOf(path.basename(abs), null);
  if (k0 !== 'text' && k0 !== 'unknown') return toolReadDocument(args, root, sb);
  if (st.size > 8 * 1024 * 1024) return { ok: false, text: '文件太大（' + (st.size / 1048576).toFixed(1) + ' MB），请用 grep 定位，或分片读取。' };
  let buf; try { buf = fs.readFileSync(abs); } catch (e) { return { ok: false, text: '读不了：' + e.message }; }
  const dec = DOC.decodeBytes(buf);                 // 按 BOM / UTF-8 / GBK 猜编码，别再出乱码
  if (dec.binary) return { ok: false, text: '这是二进制文件，不读。' };
  const txt = dec.text;
  const encNote = dec.encoding && dec.encoding !== 'utf-8' ? '，编码 ' + dec.encoding : '';
  const all = txt.split(/\r?\n/);
  const off = Math.max(1, parseInt(args && args.offset, 10) || 1);
  const lim = Math.min(600, Math.max(1, parseInt(args && args.limit, 10) || 400));
  /* 同一个文件、同一段行范围、内容没变 ⇒ 别把整段再灌一遍（实测同一个文件被读过 9 次）。 */
  const mkey = 'rf|' + abs.toLowerCase() + '|' + off + '|' + lim;
  const hit = readMemoGet(mkey);
  if (hit) {
    hit.hits = (hit.hits || 0) + 1;
    if (hit.hits === 1 && hit.text.length > 800) {
      return { ok: true, text: '（' + agentShowPath(root, abs) + ' 刚刚已经读过、内容没有变化，和上面那次 read_file 的结果完全一样。开头是：\n' + hit.text.slice(0, 400) + '\n…）\n要看完整内容就再读一次（第二次会给全文），或者换 offset 读别的行。' };
    }
    return { ok: true, text: hit.text + '\n（同一个文件、同一段范围，内容没有变化。）' };
  }
  let slice = all.slice(off - 1, off - 1 + lim);
  const line = (l, i) => String(off + i).padStart(5) + '| ' + l.slice(0, 400);
  let body = slice.map(line).join('\n');
  /* 一次读回太多会把对话上下文挤爆（本机模型只有 32K，一挤爆这一轮就直接 400 报错）。
   * 所以除了行数上限，再加一道字符预算：超了就少读几行，并把「读到第几行」说准。 */
  if (body.length > READ_MAX_CHARS && slice.length > 20) {
    const keep = Math.max(20, Math.floor(slice.length * READ_MAX_CHARS / body.length));
    slice = slice.slice(0, keep);
    body = slice.map(line).join('\n');
  }
  const last = off - 1 + slice.length;
  const more = last < all.length ? '\n…（文件共 ' + all.length + ' 行，这里读到第 ' + last + ' 行；继续读请带 offset=' + (last + 1) + '）' : '';
  const rtext = agentShowPath(root, abs) + '（共 ' + all.length + ' 行' + encNote + '）\n' + body + more;
  readMemoSet(mkey, abs, rtext);
  return { ok: true, text: rtext };
}
/** 读文档：把 PDF / Office / RTF / HTML / CSV 等抽成文本返回（带字符偏移，方便分次读）。 */
/** 「图片尺寸：3840×2400 像素」这一行 —— 别让模型自己去解析图片字节猜尺寸（它猜错过：
 *  把 3840×2400 的壁纸读成 505×306）。r 是 DOC.extractPath 的返回（图片已经读过文件头），
 *  vr 是识图返回（拿不到 meta 时兜底）。非图片返回空串。 */
function imageSizeLine(r, vr, maxEdge) {
  const meta = (r && r.meta) || {};
  const sz = (meta.width && meta.height) ? { width: meta.width, height: meta.height }
    : ((vr && vr.size && vr.size.width && vr.size.height) ? vr.size : null);
  if (!sz) return '';
  const sent = (vr && vr.sent && vr.sent.width) ? '（模型看到的是缩到最长边 ' + (maxEdge || 1280) + ' 的 ' + vr.sent.width + '×' + vr.sent.height + '）' : '';
  return '\n图片尺寸：' + sz.width + '×' + sz.height + ' 像素' + sent + '；用户说「按原图尺寸」就用这个数，别自己解析字节。';
}
async function toolReadDocument(args, root, sb) {
  const abs = agentAbs(args && args.path, root, { kind: 'read', sandbox: sb, readAppDirs: true });
  let st; try { st = fs.statSync(abs); } catch (_) { return { ok: false, text: '文件不存在：' + abs }; }
  if (st.isDirectory()) return { ok: false, text: abs + ' 是目录，请用 list_files。' };
  let r;
  try { r = await DOC.extractPath(abs); } catch (e) { return { ok: false, text: '这份文档读不出来：' + String((e && e.message) || e) }; }
  const rel = agentShowPath(root, abs);
  const head = rel + '（' + DOC.formatNote(r) + '）' + (r.convertedFrom ? '；已用本机 Office 转成新格式后解析' : '');
  /* 图片 / 扫描件 / 文字层坏掉的 PDF：抽出来没有可用文字，交给本机视觉模型读图。
   * 不是 OCR —— 是把页面渲染成图让带视觉塔的模型自己看（需要在设置里开着「识图」，
   * 没开这里会自动打开并重启引擎一次）。 */
  if (docNeedsVision(r)) {
    const s = readSettings();
    if (s.docVision === false) {
      return { ok: false, text: head + '\n这份内容的文字层不可用（' + (r.note || '没有文字') + '），而设置里「扫描件 / 图片交给本机视觉模型读」是关的。请让用户打开它，或请用户直接把图片贴进对话。' };
    }
    try {
      await ensureVisionEngine();
      const cfg = visionCfg(s);
      const first = Math.max(1, parseInt(args && (args.page || args.first), 10) || 1);
      const vr = await VISION.readDocument(cfg, abs, {
        kind: r.kind === 'image' ? 'image' : 'pdf',
        first, maxPages: cfg.maxPages, maxEdge: cfg.maxEdge,
      });
      const t0 = String(vr.text || '').trim();
      const range = r.kind === 'image' ? '' : '第 ' + first + '–' + (first + vr.pages - 1) + ' 页，共 ' + vr.total + ' 页';
      if (!t0) return { ok: false, text: head + '\n（本机视觉模型也没读出内容；换一张更清楚的图，或把图片直接贴进对话再试）' };
      const off = Math.max(0, parseInt(args && args.offset, 10) || 0);
      const lim = Math.min(20000, Math.max(500, parseInt(args && args.limit, 10) || 8000));
      const body = t0.slice(off, off + lim);
      const more = first + vr.pages <= vr.total ? '；后面还有 ' + (vr.total - (first + vr.pages - 1)) + ' 页没读，接着读请带 page=' + (first + vr.pages) : '';
      const tail = off + body.length < t0.length ? '\n…（这次识别出 ' + t0.length + ' 字，读到第 ' + (off + body.length) + ' 字）' : '';
      return {
        ok: true,
        text: head + imageSizeLine(r, vr, cfg.maxEdge) + '\n识别方式：本机视觉模型读图（' + (vr.ms / 1000).toFixed(1) + ' 秒' + (range ? '，' + range : '') + more + '）\n---\n' + body + tail,
      };
    } catch (e) {
      return { ok: false, text: head + '\n识图失败：' + String((e && e.message) || e) };
    }
  }
  let t = String(r.text || '');
  if (!t.trim()) return { ok: false, text: head + '\n（没有抽到文字' + (r.note ? '：' + r.note : '，可能是扫描件或空文档') + '；别据此断定文件是空的，可以带 page 参数再试，或先确认这个文件确实有内容）' };
  /* Excel 可以只看某一个工作表 */
  const shIdx = parseInt(args && args.sheet, 10);
  let shNote = '';
  if (shIdx > 0 && Array.isArray(r.sheets) && r.sheets.length) {
    const sh = r.sheets[shIdx - 1];
    if (sh) {
      t = String(sh.text || (Array.isArray(sh.rows) ? require('./doc/text').rowsToText(sh.rows) : sh.tsv || ''));
      shNote = '\n只看了第 ' + shIdx + ' 个工作表「' + (sh.name || '') + '」；这份表共 ' + r.sheets.length + ' 个：' + r.sheets.map((x, i) => (i + 1) + '.' + (x.name || '')).join('、');
    } else shNote = '\n没有第 ' + shIdx + ' 个工作表（共 ' + r.sheets.length + ' 个）。';
  } else if (Array.isArray(r.sheets) && r.sheets.length > 1) {
    shNote = '\n工作表：' + r.sheets.map((x, i) => (i + 1) + '.' + (x.name || '')).join('、') + '（要看某一个用 sheet 参数）';
  }
  const off = Math.max(0, parseInt(args && args.offset, 10) || 0);
  const lim = Math.min(20000, Math.max(500, parseInt(args && args.limit, 10) || 8000));
  const body = t.slice(off, off + lim);
  const tail = off + body.length < t.length
    ? '\n…（全文 ' + t.length + ' 字，这里读到第 ' + (off + body.length) + ' 字；继续读请带 offset=' + (off + body.length) + '）'
    : '\n（已到全文末尾，共 ' + t.length + ' 字）';
  return { ok: true, text: head + shNote + '\n---\n' + body + tail };
}
function toolWriteFile(args, root, sb) {
  const abs = agentAbs(args && args.path, root, { kind: 'write', sandbox: sb });
  const content = String((args && args.content) === undefined || (args && args.content) === null ? '' : args.content);
  if (content.length > 2 * 1024 * 1024) return { ok: false, text: '一次写入太大（' + content.length + ' 字符），请分块写。' };
  const existed = fs.existsSync(abs);
  let before = ''; try { before = existed ? fs.readFileSync(abs, 'utf8') : ''; } catch (_) {}
  /* PowerShell 5.1 只认带 BOM 的 UTF-8 脚本：不带 BOM 的中文注释会被按 GBK 解，报出
   * 「Unexpected token '}'」这种看不出原因的错（踩过 3 次）。写脚本时直接补上。 */
  const scripty = /\.(ps1|psm1|psd1|bat|cmd)$/i.test(abs);
  const body0 = scripty ? ('\ufeff' + content) : content;
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body0, 'utf8'); }
  catch (e) { return { ok: false, text: '写不进去：' + e.message }; }
  READ_MEMO.clear();
  const lines = content.split(/\r?\n/).length;
  return {
    ok: true,
    text: (existed ? '已覆盖 ' : '已新建 ') + agentShowPath(root, abs) + '（' + lines + ' 行，' + Buffer.byteLength(body0, 'utf8') + ' 字节'
      + (scripty ? '；已按 PowerShell 5.1 的要求补上 UTF-8 BOM，可以直接 run_command 执行' : '') + '）' +
      (existed ? '；原来 ' + before.split(/\r?\n/).length + ' 行' : ''),
    files: [abs],
  };
}
/** 生成文档：md / txt / csv / json / html / docx / xlsx / pdf（PDF 用本机 Edge 无头打印）。 */
async function toolWriteDocument(args, root, sb) {
  const abs = agentAbs(args && args.path, root, { kind: 'write', sandbox: sb });
  const content = String((args && args.content) === undefined || (args && args.content) === null ? '' : args.content);
  if (content.length > 4 * 1024 * 1024) return { ok: false, text: '一次写入太大（' + content.length + ' 字符），请分块写。' };
  const ext = DOC.extOf(abs);
  if (!DOC.canWrite(abs)) {
    return { ok: false, text: '不能生成 .' + (ext || '（无扩展名）') + ' 这种格式。可写：.md .txt .csv .tsv .json .html .docx（Word） .xlsx（Excel） .pdf。' };
  }
  const existed = fs.existsSync(abs);
  let before = 0;
  try { if (existed && /^(md|markdown|txt|text|log|csv|tsv|json|html|htm|xml|yaml|yml)$/.test(ext)) before = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length; } catch (_) {}
  try {
    const r = await DOC.writeDocument(abs, content, {
      title: path.basename(abs, path.extname(abs)),
      sheets: Array.isArray(args && args.sheets) && args.sheets.length ? args.sheets.map(s => ({ name: String((s && s.name) || 'Sheet1'), rows: Array.isArray(s && s.rows) ? s.rows : [] })) : undefined,
      sheetName: (args && args.sheetName) || 'Sheet1',
    });
    return {
      ok: true,
      files: [abs],
      text: (existed ? '已覆盖 ' : '已生成 ') + agentShowPath(root, abs) + '（' + r.kind + '，' + (r.bytes / 1024).toFixed(1) + ' KB' + (r.note ? '；' + r.note : '') + '）' +
        (before ? '；原来 ' + before + ' 行' : ''),
      preview: { kind: r.kind, path: abs, ...(ext === 'docx' || ext === 'pdf' ? { text: content.slice(0, 1200) } : {}) },
    };
  } catch (e) {
    return { ok: false, text: '生成文档失败：' + String((e && e.message) || e) };
  }
}
function toolEditFile(args, root, sb) {
  const abs = agentAbs(args && args.path, root, { kind: 'write', sandbox: sb });
  const oldS = String((args && args.old_string) === undefined ? '' : args.old_string);
  const newS = String((args && args.new_string) === undefined ? '' : args.new_string);
  if (!oldS) return { ok: false, text: 'old_string 不能为空。' };
  if (oldS === newS) return { ok: false, text: 'old_string 与 new_string 一样，没有可改的。' };
  /* 先按 BOM / UTF-8 / GBK / UTF-16 判编码再读：以前硬按 utf8 读，GBK 文件在模型眼里是乱码
   * ⇒ 它照抄的 old_string 永远找不到（必失败并无脑重试）；写回也按原编码。 */
  let dec;
  try { dec = DOC.decodeBytes(fs.readFileSync(abs)); } catch (e) { return { ok: false, text: '读不了这个文件（先确认路径）：' + e.message }; }
  if (dec.binary) return { ok: false, text: '这是二进制文件，不能用 edit_file 改。' };
  const txt = dec.text;
  const enc = dec.encoding || 'utf-8';
  const cnt = txt.split(oldS).length - 1;
  if (!cnt) return { ok: false, text: '文件里找不到这段 old_string。先用 read_file 看清原文（空格与换行必须逐字一致），再改。' };
  if (cnt > 1 && !(args && args.replace_all)) {
    return { ok: false, text: '这段 old_string 在文件里出现了 ' + cnt + ' 次，直接改会改错地方。请多带几行上下文让它唯一，或加 replace_all: true 全部替换。' };
  }
  let out;
  if (args && args.replace_all) out = txt.split(oldS).join(newS);
  else { const i = txt.indexOf(oldS); out = txt.slice(0, i) + newS + txt.slice(i + oldS.length); }
  try { fs.writeFileSync(abs, encodeWithEncoding(out, enc)); } catch (e) { return { ok: false, text: '写不进去：' + e.message }; }
  READ_MEMO.clear();
  const encNote = (enc === 'gbk' || enc === 'latin1')
    ? '；注意：这个文件原来是 ' + enc + ' 编码，Node 写不了 ' + enc + '，已按 UTF-8 保存（内容没变，但用别的老工具打开可能显示乱码）'
    : (enc !== 'utf-8' ? '；编码保持 ' + enc : '');
  return {
    ok: true,
    text: '已修改 ' + agentShowPath(root, abs) + '（替换 ' + ((args && args.replace_all) ? cnt : 1) + ' 处' + encNote + '）\n- ' + oldS.slice(0, 300) + '\n+ ' + newS.slice(0, 300),
    files: [abs],
  };
}
function toolGrep(args, root, sb) {
  const pat = String((args && args.pattern) || '').trim();
  if (!pat) return { ok: false, text: 'pattern 不能为空。' };
  let re; try { re = new RegExp(pat, 'i'); } catch (e) { return { ok: false, text: '正则写错了：' + e.message }; }
  const base = agentAbs((args && args.path) || '.', root, { kind: 'read', sandbox: sb });
  const inc = String((args && args.include) || '').trim();
  const incRe = inc ? globToRe(inc) : null;
  const hits = [];
  let scanned = 0;
  const check = (full, name) => {
    if (hits.length >= AGENT_MAX_MATCHES || scanned >= 3000) return;
    if (incRe && !incRe.test(name)) return;
    let st; try { st = fs.statSync(full); } catch (_) { return; }
    if (st.size > 2 * 1024 * 1024) return;
    /* 按 BOM / UTF-8 / GBK / UTF-16 解码：以前硬按 utf8 读、见 \u0000 就跳过，于是 PowerShell
     * 的 > / Set-Content 产出的 UTF-16 文件被静默漏掉，模型拿到「没有匹配」的假结论。 */
    let dec; try { dec = DOC.decodeBytes(fs.readFileSync(full)); } catch (_) { return; }
    if (dec.binary) return;
    const txt = dec.text;
    if (!txt) return;
    scanned++;
    const lines = txt.split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < AGENT_MAX_MATCHES; i++) {
      if (re.test(lines[i])) hits.push(agentShowPath(root, full) + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 240));
    }
  };
  let st; try { st = fs.statSync(base); } catch (_) { return { ok: false, text: '路径不存在：' + base }; }
  let walkCapped = false;
  if (st.isFile()) check(base, path.basename(base));
  else walkCapped = agentWalk(base, (full, name, isDir) => { if (!isDir) check(full, name); });
  /* 「没找到」必须说清扫了多少、扫完没有：否则模型会把「只扫了一部分」当成「这东西不存在」。 */
  const capNote = (walkCapped || scanned >= 3000)
    ? '\n（注意：文件太多，这次只扫了一部分、**没有扫完**；把 path 指到更具体的子目录，或用 include 限定类型再搜一次，别据此断定「不存在」）'
    : '';
  if (!hits.length) return { ok: true, text: '没有匹配「' + pat + '」（扫了 ' + scanned + ' 个文本文件）' + capNote };
  let gtext = hits.join('\n') + (hits.length >= AGENT_MAX_MATCHES ? '\n…（只显示前 ' + AGENT_MAX_MATCHES + ' 条，pattern 写窄一点）' : '');
  if (gtext.length > GREP_MAX_CHARS) gtext = clipText(gtext, GREP_MAX_CHARS) + '\n…（结果太多，只保留了头尾；pattern 写窄一点，或用 include 限定文件类型）';
  return { ok: true, text: gtext + capNote };
}
function clipText(s, cap) {
  const t = String(s === undefined || s === null ? '' : s);
  if (t.length <= cap) return t;
  const head = Math.round(cap * 0.62), tail = cap - head;
  return t.slice(0, head) + '\n…（中间省略 ' + (t.length - cap) + ' 字符）…\n' + t.slice(-tail);
}
/* ----------------------- 命令执行（run_command） -----------------------
 * 让本机小模型跑 Windows PowerShell 更顺：少报错、别卡死、别烧 token。
 *  ① 脚本落成带 BOM 的临时 .ps1、用 -File 跑：彻底躲开 argv 转义与长度限制，报错行号也能对上；
 *  ② 退出码忠实回传（PS 5.1 的 -Command 会把 native 的退出码吞成 1，模型据此把失败当成功）；
 *  ③ 注定卡住 / 必定报错的写法先拦下（等人输入、编辑器、REPL、&&、pwsh…），不启动进程；
 *  ④ 同一条失败命令原样重试直接拒绝，把上次的输出再还给模型（烧 token 的主因）；
 *  ⑤ 输出清洗：GBK 兜底解码、去 ANSI/CLIXML/脱字符噪音、超长给「怎么收窄」的提示；
 *  ⑥ 超时杀整棵进程树；默认 60 秒，慢命令用 timeoutMs 放宽到 10 分钟。 */
const CMD_TIMEOUT_DEFAULT = 60000;
const CMD_TIMEOUT_MAX = 600000;
const CMD_PRELUDE = [
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$OutputEncoding = [Text.Encoding]::UTF8',
  'chcp 65001 > $null',
];
/* 结尾把退出码交出来：cmdlet 失败 $? 为假；native 程序失败看 $LASTEXITCODE。 */
const CMD_FOOTER = [
  '$__lm_ok = $?',
  '$__lm_code = $LASTEXITCODE',
  'if (-not $__lm_ok) { if ($__lm_code -is [int] -and $__lm_code -ne 0) { exit $__lm_code } else { exit 1 } }',
  'if ($__lm_code -is [int] -and $__lm_code -ne 0) { exit $__lm_code }',
  'exit 0',
];
/* 会卡死或必然失败的写法：直接拦下来，把「为什么 + 怎么改」讲清楚。 */
const CMD_BLOCKERS = [
  { re: /\bread-host\b|\breadkey\b|\[console\]::read|\$host\.ui\.rawui\.readkey/i, why: 'Read-Host / ReadKey 要等人敲键盘，而后台运行没有键盘，只会一直等到超时。', fix: '需要输入就停下来在回答里直接问用户；能当参数传的就用参数（例如 -Name 张三）。' },
  { re: /(^|[;&|]\s*)(pause|more)\b|cmd\s*\/[ck]\s+(pause|more)\b/i, why: 'pause / more 会等人按键，后台没有键盘。', fix: '去掉它；要看大段文本用 Get-Content -TotalCount 50，分页交给界面。' },
  { re: /out-gridview|waitevent|wait-event|get-content[^\n]*-wait\b|register-objectevent/i, why: '这条命令会一直等窗口/事件（Out-GridView、Wait-Event、Get-Content -Wait 都不会自己结束）。', fix: '改成一次性取数：Get-Content -TotalCount 100 或 Get-Content | Select-Object -Last 50。' },
  { re: /git\s+commit\b(?![^\n]*\s-m\b)(?![^\n]*--message)(?![^\n]*--no-edit)/i, why: 'git commit 不带 -m 会打开编辑器等人写提交信息，后台必然卡住。', fix: '带上 -m "提交说明"，例如 git commit -m "fix: 修正解析"（改上一个提交就加 --amend --no-edit）。' },
  /* ↓ 这两条只在回落到 5.1 时启用；跑在 pwsh 7 上时 && / || 是合法语法（实测 7.6.6 通过），
   *   而 pwsh 本身就存在、没有任何理由拦。 */
  ...(PS_SHELL.pwsh ? [] : [
    { re: /(^|[\s;&|])pwsh(\.exe)?\b/i, why: '本机没有 PowerShell 7（pwsh），只有 Windows PowerShell 5.1。', fix: '直接用 PowerShell 5.1 的语法写，或改用 powershell.exe。' },
    { re: /&&|\|\|/, bare: true, why: 'PowerShell 5.1 不支持 && 和 ||，会直接报语法错误。', fix: '用 ; 顺序执行；要「前一条成功才继续」写成 if ($?) { … }，要「失败才继续」写成 if (-not $?) { … }。' },
  ]),
  { re: /(^|\n)\s*(python|python3|node|powershell|cmd|pwsh)(\.exe)?\s*$/i, why: '不带参数的 python/node/powershell/cmd 会进入交互式 REPL，后台没人能跟它交互。', fix: '带参数运行，例如 node -e "console.log(1)"、python --version；文件脚本用 node 脚本.js。' },
  { re: /\bnpm\s+(init|create)\b(?![^\n]*\s-y\b)/i, why: 'npm init / npm create 会交互式提问。', fix: '加 -y（npm init -y），或改用 package.json 直接写文件。' },
  { re: /(^|\n|;|&&|\|)\s*(notepad|explorer|start)\b\s|(^|\n|;|&&|\|)\s*start-process\s+(?!.*-wait)/i, why: '会打开窗口/外部程序，命令本身立刻返回，没人知道它什么时候结束（还可能污染屏幕）。', fix: '要跑程序就直接跑（例如 & "C:\\路径\\程序.exe"），不要用 start/notepad/explorer。' },
  { re: /\b(shutdown|restart-computer|diskpart|bcdedit|reg\s+delete)\b|\bformat\s+[a-z]:/i, why: '这条命令会改系统/关机/格式化，属于危险操作。', fix: '这不适合由你自动执行；把命令写进回答里让用户自己决定。' },
  { re: /remove-item\b[^\n]*\b[a-z]:\\(\s*(["'])?\s*(-recurse|-force|\*)|\s*["']?\s*$)/i, why: '这条删除命令会清掉整个盘/根目录。', fix: '把范围收窄到明确的子目录，并先 Get-ChildItem 确认要删的东西。' },
];
function cmdPreflight(cmd) {
  /* 判 && / || 时先把引号里的内容挖掉：写在字符串里的 && 是数据、不是管道（误拦过）。 */
  const bare = String(cmd).replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  for (const r of CMD_BLOCKERS) {
    if (r.re.test(r.bare ? bare : cmd)) return '这条命令被拦下、没有执行：' + r.why + '\n改法：' + r.fix;
  }
  if (cmd.length > 8000) {
    return '这条命令被拦下、没有执行：太长了（' + cmd.length + ' 字符），命令行有长度上限。\n改法：用 write_file 把脚本写成 .ps1 文件，再 run_command 执行它（powershell -File 脚本.ps1 或直接 .\\脚本.ps1）。';
  }
  return '';
}
/* 不拦、但值得提醒的写法（结果里会带一句 [提示]）。 */
function cmdNotes(cmd) {
  const n = [];
  if (/-recurse/i.test(cmd) && /-path\s*(")?[a-z]:\\(\s|"|$)/i.test(cmd)) n.push('从盘根递归很慢，尽量指定子目录，或加 -Filter 收窄。');
  /* -UseBasicParsing 只是 5.1 的建议（不加会等 IE 首次配置）；pwsh 7 上这个开关是空操作，别再提。 */
  if (!PS_SHELL.pwsh && /invoke-webrequest|invoke-restmethod|iwr\b|irm\b/i.test(cmd) && !/-usebasicparsing/i.test(cmd)) n.push('PowerShell 5.1 里 Invoke-WebRequest 建议加 -UseBasicParsing（不加可能等 IE 首次配置）。');
  if (/(^|\s)(dir|copy|del|move|ren|type|find|findstr)\s+\/[a-z]/i.test(cmd)) n.push('这是 cmd 的命令行写法；PowerShell 里对应 Get-ChildItem / Copy-Item / Remove-Item / Move-Item / Rename-Item / Get-Content / Select-String。');
  if (/(^|[;&|]\s*)dir\s*($|[;&|])/i.test(cmd)) n.push('dir 在 PowerShell 里是 Get-ChildItem 的别名，能用，但输出格式不同（想只列名字用 Get-ChildItem -Name）。');
  return n;
}
/* PowerShell 写 stderr 的字节可能是系统码页（GBK）：按 utf8 解出替换字符就换 GBK 再试一次。 */
function decodePsBuf(buf) {
  if (!buf || !buf.length) return '';
  const u = buf.toString('utf8');
  const bad = (u.match(/\uFFFD/g) || []).length;
  /* 只有零星几个替换字符（多半是截断切在汉字中间）时**不要**整体换 GBK —— 那会把本来
   * 正确的中文全变成乱码。占比超过 0.5% 才认为整段是 GBK。 */
  if (bad * 200 <= u.length) return u;
  try {
    const g = new TextDecoder('gbk').decode(buf);
    const gbad = (g.match(/\uFFFD/g) || []).length;
    if (g && gbad < bad) return g;
  } catch (_) { /* 没有 ICU 就算了 */ }
  return u;
}
/* 去掉噪音、把内部临时路径与行号偏移藏起来、把 CLIXML 摊平。 */
function cleanPsOut(s, tmpDir, lineOffset) {
  let t = String(s || '');
  if (t.indexOf('#< CLIXML') >= 0) {
    const parts = [];
    const re = /<S S="Error">([\s\S]*?)<\/S>/g;
    let m;
    while ((m = re.exec(t))) parts.push(m[1]);
    if (parts.length) t = parts.join('');
    t = t.replace(/<[^>]*>/g, '');
  }
  t = t.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');                                  /* ANSI 颜色 */
  t = t.replace(/_x000D_/g, '').replace(/_x000A_/g, '\n');                          /* CLIXML 转义 */
  t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  t = t.replace(/\r\n?/g, '\n');
  if (tmpDir) t = t.split(tmpDir).join('');                                          /* 别让模型看见内部临时目录 */
  t = t.replace(/command\.ps1/g, '你的命令');
  if (lineOffset) {
    t = t.replace(/\\?你的命令:(\d+)/g, (m0, n) => '你的命令 第' + Math.max(1, Number(n) - lineOffset) + '行');
    t = t.replace(/行:(\d+)/g, (m0, n) => '行:' + Math.max(1, Number(n) - lineOffset));
  }
  t = t.split('\n').filter((l) => !/^\s*\+\s*~+\s*$/.test(l))                        /* 只留「+ 代码」，丢掉「+ ~~~」 */
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '');
  return t.trim();
}
/* 按报错特征给一句「怎么改」，让小模型不用自己猜。 */
function cmdFixHint(body, code, timedOut) {
  if (timedOut) return '\n[提示] 超时不是报错：这条命令本身太久。要么拆小（加 -First / -Filter / 限定子目录），要么传 timeoutMs（最多 600000）重跑，要么把结果先写到文件里再分次读。';
  const t = String(body || '');
  if (/ParserError|Unexpected token|意外的标记|缺少表达式|MissingExpression|Missing closing/i.test(t)) {
    if (!PS_SHELL.pwsh && /&&|\|\|/.test(t)) return '\n[提示] 语法错误：PowerShell 5.1 不支持 && 和 ||，用 ; 分隔，或写 if ($?) { … }。';
    return '\n[提示] 语法错误：检查引号/括号是否配对、here-string 的 @" 与 "@ 是否各占一行；拿不准就先写成一个 .ps1 文件再执行。';
  }
  if (/is not recognized|无法将.*识别为|CommandNotFound/i.test(t)) return '\n[提示] 命令不存在：先用 Get-Command <名字> -ErrorAction SilentlyContinue 确认（当前解释器是 ' + PS_SHELL.label + '）。别原样再试一次。';
  if (/拒绝访问|Access is denied|AccessDenied|UnauthorizedAccess/i.test(t)) return '\n[提示] 没有权限：换到有写权限的目录，或先确认这个路径是否可写（Test-Path / Get-Acl）。';
  if (/找不到路径|Cannot find path|PathNotFound|does not exist/i.test(t)) return '\n[提示] 路径不存在：先用 Test-Path 确认；带空格的路径要加引号，含通配符的用 -LiteralPath。';
  if (/A positional parameter cannot be found|找不到接受实际参数|无法绑定参数/i.test(t)) return '\n[提示] 参数写法不对：用 Get-Help <命令> -Examples 看正确用法，别靠猜。';
  if (code !== 0 && code !== null && code !== undefined) return '\n[提示] 命令以非零退出码结束：先看上面的输出定位是哪一步失败，改好再重试；不要原样重复同一条命令。';
  return '';
}
function toolRunCommand(args, root, sb, memo) {
  return new Promise((resolve) => {
    const cmd = String((args && args.command) || '').trim();
    if (!cmd) return resolve({ ok: false, text: '命令为空。' });
    let cwd;
    try { cwd = agentAbs((args && args.cwd) || '.', root, { kind: 'inside', sandbox: sb }); } catch (e) { return resolve({ ok: false, text: e.message }); }
    try { if (!fs.statSync(cwd).isDirectory()) throw new Error('not a dir'); } catch (_) { return resolve({ ok: false, text: '执行目录不存在：' + cwd }); }
    const bad = cmdPreflight(cmd);
    if (bad) { log('[agent] run_command 被前置拦下：' + cmd.replace(/\s+/g, ' ').slice(0, 160)); return resolve({ ok: false, text: bad }); }
    const notes = cmdNotes(cmd);
    /* 同一条命令本轮已经失败过：原样跑第二遍只会拿到同样的错误 —— 直接把上次结果还给模型。 */
    const memoKey = cwd.toLowerCase() + '\u0000' + cmd;
    if (memo && memo.has(memoKey)) {
      const p = memo.get(memoKey);
      return resolve({
        ok: false,
        text: '这条命令本轮已经跑过并且失败了（' + p.code + '），原样重试不会有不同结果，所以没有再执行。\n上次的输出：\n'
          + clipText(p.body, 1500) + '\n请按上面的错误信息改写法（换参数、换命令、或先确认路径/命令是否存在），不要原样提交同一条命令。',
      });
    }
    const timeoutMs = Math.min(CMD_TIMEOUT_MAX, Math.max(2000, Number(args && args.timeoutMs) || CMD_TIMEOUT_DEFAULT));
    const t0 = Date.now();
    /* 脚本走临时文件：-File 不受命令行长度与转义影响，语法错误也能报到正确的行号。 */
    let tmpDir = null, scriptFile = null, spawnArgs = null, lineOffset = CMD_PRELUDE.length;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-cmd-'));
      scriptFile = path.join(tmpDir, 'command.ps1');
      fs.writeFileSync(scriptFile, psScriptText(CMD_PRELUDE.concat([cmd], CMD_FOOTER)), 'utf8');
      spawnArgs = psScriptArgv(scriptFile);
    } catch (e) {
      tmpDir = null; scriptFile = null; lineOffset = 0;
      const oneLine = CMD_PRELUDE.join('; ') + '; ' + cmd + '\n' + CMD_FOOTER.join('\n');
      spawnArgs = psInlineArgv(oneLine);
    }
    const cleanup = () => { if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} } };
    const child = spawn(PS_SHELL.exe, spawnArgs, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const OUT_MAX = 2 * 1024 * 1024;
    const bufs = { out: [], err: [] };
    let over = false, timedOut = false, settled = false, spawnErr = '';
    const take = (which) => (d) => {
      const cur = bufs[which];
      const size = cur.reduce((a, b) => a + b.length, 0);
      if (size + d.length > OUT_MAX) { over = true; if (size < OUT_MAX) cur.push(d.slice(0, OUT_MAX - size)); return; }
      cur.push(d);
    };
    child.stdout.on('data', take('out'));
    child.stderr.on('data', take('err'));
    const killTree = () => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} };
    const timer = setTimeout(() => { timedOut = true; killTree(); setTimeout(() => finish(null), 5000); }, timeoutMs);
    const finish = (codeIn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const raw = decodePsBuf(Buffer.concat(bufs.out));
      const rawErr = decodePsBuf(Buffer.concat(bufs.err));
      const merged = (rawErr ? (raw ? raw.replace(/\s+$/, '') + '\n' : '') + '[stderr] ' + rawErr : raw);
      let body = cleanPsOut(merged, tmpDir, lineOffset);
      if (over) body = clipText(body, 12000) + '\n[…输出太大，只保留了头尾；下次用 Select-Object -First / Where-Object 收窄]';
      else if (body.length > 12000) body = clipText(body, 12000) + '\n[…输出超过 12000 字被截断；下次用 Select-Object -First 20 / -Last 20 / Where-Object 收窄]';
      const code = timedOut ? 'TIMEOUT' : (typeof codeIn === 'number' ? codeIn : (spawnErr ? 'SPAWNERR' : 1));
      /* robocopy 0–7、findstr 无匹配、git diff --quiet 有差异……这些非零码都是「正常完成」，
       * 以前一律算失败 ⇒ 进闩锁 ⇒ 模型被迫换写法重试（白烧好几步）。 */
      const benign = !timedOut && !spawnErr && benignExit(cmd, codeIn);
      const ok = !timedOut && !spawnErr && (code === 0 || benign);
      if (!ok && memo) memo.set(memoKey, { code, body: body || '(没有输出)' });
      let text = 'cwd ' + cwd + ' · 退出码 ' + (timedOut ? '(超时未结束)' : code)
        + (benign ? '（这条命令用非零码表示「没有匹配 / 有差异」，算正常完成）' : '')
        + ' · 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n'
        + (body || '(没有输出)');
      if (timedOut) text += '\n[命令超过 ' + Math.round(timeoutMs / 1000) + ' 秒还没结束，已连同子进程一起终止]';
      if (spawnErr) text += '\n[没能启动 ' + PS_SHELL.exe + '：' + spawnErr + ']';
      if (notes.length) text = '[提示] ' + notes.join(' ') + '\n' + text;
      text += cmdFixHint(body, benign ? 0 : (timedOut ? 1 : (typeof code === 'number' ? code : 1)), timedOut);
      log('[agent] run_command 退出码=' + code + ' 用时=' + ((Date.now() - t0) / 1000).toFixed(1) + 's 输出=' + (body || '').length + '字 ' + (ok ? 'ok' : 'FAIL'));
      resolve({ ok, text });
    };
    child.on('error', (e) => { spawnErr = String((e && e.message) || e); finish(1); });
    child.on('close', (code) => finish(code));
  });
}
function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t\u00a0]+/g, ' ').replace(/\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function toolWebFetch(args) {
  return new Promise((resolve) => {
    const url = String((args && args.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) return resolve({ ok: false, text: '只支持 http/https 链接。' });
    const go = (u, hops) => {
      let req;
      try {
        req = (u.startsWith('https:') ? https : http).get(u, { headers: { 'user-agent': 'Mozilla/5.0 (local-model-studio agent)' } }, (r) => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 4) {
            r.resume();
            const next = new URL(r.headers.location, u).toString();
            return go(next, hops + 1);
          }
          const chunks = []; let n = 0;
          r.on('data', (c) => { n += c.length; if (n <= 400 * 1024) chunks.push(c); });
          r.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const text = /<html|<!doctype html/i.test(raw) ? stripHtml(raw) : raw;
            resolve({ ok: r.statusCode < 400, text: 'HTTP ' + r.statusCode + ' · ' + u + '\n' + clipText(text, 8000) });
          });
        });
      } catch (e) { return resolve({ ok: false, text: '请求失败：' + e.message }); }
      req.on('error', (e) => resolve({ ok: false, text: '请求失败：' + e.message }));
      req.setTimeout(20000, () => { req.destroy(new Error('超时 20 秒')); });
    };
    go(url, 0);
  });
}
/* 本机（8 GB 的 4060 Laptop）能画得动的范围：1024×1024、8 步 ≈ 半分钟；再往上就是几分钟到
 * 十几分钟，超过 15 分钟会被判超时。而模型很爱把「壁纸」写成 2400×3840、40 步 —— 实测就是
 * 这么把整轮拖死的（等 15 分钟 → 超时 → 引擎没回切 → 下一轮直接 ECONNREFUSED）。所以这里
 * 夹紧，并把夹了什么如实告诉模型与用户，而不是硬着头皮画。 */
const IMAGE_MAX_EDGE = 1536;
const IMAGE_MAX_PIXELS = 1536 * 1536;
const IMAGE_MAX_STEPS = 20;
function clampImageParams(a) {
  const notes = [];
  let width = Math.round(Number(a.width || 1024));
  let height = Math.round(Number(a.height || 1024));
  if (!Number.isFinite(width) || width < 256) width = 1024;
  if (!Number.isFinite(height) || height < 256) height = 1024;
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height), Math.sqrt(IMAGE_MAX_PIXELS / (width * height)));
  if (scale < 1) {
    /* 保持比例，边长对齐到 32（ComfyUI 的 latent 网格要求）。 */
    const r32 = (n) => Math.max(256, Math.round(n * scale / 32) * 32);
    const w2 = r32(width), h2 = r32(height);
    if (w2 !== width || h2 !== height) {
      notes.push('尺寸 ' + width + '×' + height + ' 超出本机舒适区，已降到 ' + w2 + '×' + h2);
      width = w2; height = h2;
    }
  }
  let steps = Math.round(Number(a.steps || 8));
  if (!Number.isFinite(steps) || steps < 1) steps = 8;
  if (steps > IMAGE_MAX_STEPS) { notes.push('步数 ' + steps + ' 已降到 ' + IMAGE_MAX_STEPS); steps = IMAGE_MAX_STEPS; }
  return { width, height, steps, notes };
}
async function toolGenerateImage(args, ctx) {
  const a = args || {};
  const cl = clampImageParams(a);
  const params = {
    prompt: String(a.prompt || ''), negative: String(a.negative || ''),
    width: cl.width, height: cl.height, steps: cl.steps,
    batch_size: 1, prefix: 'qwen_out', use_lora: true, lora_strength: 1.0,
  };
  if (a.seed !== undefined && a.seed !== null && a.seed !== '') params.seed = Number(a.seed);
  if (cl.notes.length) {
    log('[image] params clamped: ' + cl.notes.join('; '));
    ctx.sse(ctx.res, { type: 'status', text: '参数已调整：' + cl.notes.join('；') + '（本机 8 GB 显存画大图会超时）' });
  }
  ctx.sse(ctx.res, { type: 'status', text: '正在切换到绘图引擎（会先卸载对话模型，约 30–60 秒）…' });
  const t0 = Date.now();
  let out = null, fail = null;
  try {
    out = await withGate(async () => {
      await ensureImage();
      return runImageJob(params, [], (jb, beat) => {
        ctx.sse(ctx.res, { type: 'progress', state: jb.state, step: jb.step, total: jb.total_steps, node: jb.node, elapsed: jb.elapsed });
        /* 心跳（约 20 秒一次）：让界面说句话，别对着不动的进度条沉默。 */
        if (beat) {
          ctx.sse(ctx.res, { type: 'status', text: '正在画图… 第 ' + (jb.step || 0) + '/' + (jb.total_steps || cl.steps) + ' 步 · 已用 ' + Math.round((Date.now() - t0) / 1000) + ' 秒' });
        }
      });
    });
  } catch (e) { fail = e; }
  /* 不管画成没画成，都必须把对话模型接回来：以前只有成功路径才回切，生图失败/超时之后
   * 8110 一直是死的，下一轮对话直接 connect ECONNREFUSED。 */
  ctx.sse(ctx.res, { type: 'status', text: '正在切回对话模型…' });
  try { await withGate(() => ensureChat({})); }
  catch (e) {
    log('re-ensure chat failed: ' + String(e.message || e));
    ctx.sse(ctx.res, { type: 'status', text: '对话模型没能自动起来，下一条消息可能会连不上引擎（再发一次会自动重启）。' });
  }
  if (fail) throw fail;
  const imgs = (out.job.images || []).map(x => ({ url: x.url, file: x.file, w: x.w, h: x.h, size: x.size }));
  ctx.sse(ctx.res, { type: 'image', images: imgs, prompt: params.prompt });
  return {
    ok: true, images: imgs, files: imgs.map(i => i.file || i.url),
    text: '图片已生成：' + imgs.map(i => i.file || i.url).join(', ')
      + '（实际参数 ' + params.width + '×' + params.height + '、' + params.steps + ' 步'
      + (cl.notes.length ? '；' + cl.notes.join('；') : '')
      + '。用一句话说明你画了什么；不要再调用这个工具。）',
  };
}
async function runAgentTool(name, args, ctx) {
  const root = ctx.root;
  const sb = ctx.sandbox || 'workspace-write';
  try {
    switch (name) {
      case 'list_files': return toolListFiles(args, root, sb);
      case 'read_file': return toolReadFile(args, root, sb);
      case 'read_document': return toolReadDocument(args, root, sb);
      case 'write_file': return toolWriteFile(args, root, sb);
      case 'write_document': return await toolWriteDocument(args, root, sb);
      case 'edit_file': return toolEditFile(args, root, sb);
      case 'grep': return toolGrep(args, root, sb);
      case 'run_command': return await toolRunCommand(args, root, sb, ctx.cmdMemo);
      case 'request_permission': return toolRequestPermission(args);
      case 'web_fetch': return await toolWebFetch(args);
      case 'web_search': {
        const r = await searchWeb(String((args && args.query) || ''), 8);
        if (!r.ok) return { ok: false, text: '搜索没有结果：' + (r.error || '') };
        return { ok: true, text: r.results.map((x, i) => (i + 1) + '. ' + x.title + '\n   ' + x.link + '\n   ' + x.snippet).join('\n') };
      }
      case 'generate_image': return await toolGenerateImage(args, ctx);
      default: return { ok: false, text: '没有这个工具：' + name };
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    /* 沙箱拒绝是「按规则挡下」，不是工具坏了：原样回给模型（DSH 的标记就在开头），
       加「工具执行出错：」前缀会让模型以为是自己参数写错，转头去换别的法子试。 */
    return { ok: false, text: msg.indexOf('[sandbox:') === 0 ? msg : ('工具执行出错：' + msg) };
  }
}
/* 申请一次性放行：模型被沙箱拦下、又确信这一步必须做时调它。
 * 它自己永远是「每次询问」—— 用户在卡片上点允许后，宿主把这次调用记成一次性放行，
 * 模型随后原样重试刚才被拒的那次调用，那一次以完全权限执行（只放行一次）。 */
function toolRequestPermission(args) {
  const a = args || {};
  const action = String(a.action || '').trim().toLowerCase() === 'exec' ? 'exec' : 'write';
  const target = String(a.target || '').trim();
  const reason = String(a.reason || '').trim();
  if (!reason) return { ok: false, text: 'reason 不能为空：必须用中文说清「为什么非做这一步不可」。' };
  return {
    ok: true,
    grant: { action: action, target: target, reason: reason, remaining: 1 },
    text: '用户已批准一次性放行：' + (action === 'exec' ? '执行命令' : '写文件') + (target ? '（' + target + '）' : '') +
      '。现在**原样重试**刚才被拒的那次调用 —— 这一次会放行；只放行这一次，做完就恢复原档位，不要重复申请。',
  };
}
/* 一次性放行只作用于「同一类操作」：exec 对应 run_command；write 对应写文件的三个工具。
 * target 留空或写 '*' 表示不限定目标；否则要求这次写的路径落在申请的路径（或它之下），
 * 或者与它同目录 —— 口径小而明确，免得一次批准变成长期通行证。 */
function oneShotMatches(grant, name, args, root) {
  if (!grant || grant.remaining <= 0) return false;
  if (grant.action === 'exec') return name === 'run_command';
  if (name !== 'write_file' && name !== 'write_document' && name !== 'edit_file') return false;
  const t = String(grant.target || '').trim();
  if (!t || t === '*' || t === '.') return true;
  let want, abs;
  try { want = path.resolve(root, t); abs = path.resolve(root, String((args && args.path) || '')); } catch (_) { return false; }
  return isUnderPath(abs, want) || path.dirname(abs) === path.dirname(want);
}
function agentPerm(s, name, mode, sandbox) {
  const sb = sandbox || agentSandbox(s, mode);
  if (name === 'generate_image') return 'allow';
  if (name === 'request_permission') return 'ask';       // 申请放行：永远要用户自己点一下
  if (AGENT_READONLY.has(name)) return 'allow';          // 读文件与联网：三档一律放行
  if (mode === 'off') return 'deny';
  if (name === 'run_command') {
    if (sb.key === 'full') return 'allow';
    if (sb.key === 'readonly') return 'ask';             // 命令可能顺手写文件，只读档也得问
    return String(s.agentPermExec || 'ask');
  }
  if (sb.key === 'full') return 'allow';
  if (sb.key === 'readonly') return 'deny';              // 写：只读档一律不做（可用 request_permission 申请一次）
  return String(s.agentPermWrite || 'ask');
}
function agentPreview(name, args) {
  const a = args || {};
  const cut = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);
  if (name === 'write_file') return { kind: 'write', path: String(a.path || ''), text: cut(a.content, 1500), bytes: Buffer.byteLength(String(a.content || ''), 'utf8') };
  if (name === 'write_document') return { kind: 'write', path: String(a.path || ''), doc: DOC.extOf(a.path) || '?', text: cut(a.content, 1500), sheets: Array.isArray(a.sheets) ? a.sheets.length : 0, bytes: Buffer.byteLength(String(a.content || ''), 'utf8') };
  if (name === 'edit_file') return { kind: 'edit', path: String(a.path || ''), old: cut(a.old_string, 800), fresh: cut(a.new_string, 800) };
  if (name === 'run_command') return { kind: 'exec', command: cut(a.command, 900), cwd: String(a.cwd || '.') };
  if (name === 'request_permission') return { kind: 'perm', action: String(a.action || 'write'), target: cut(a.target, 400), reason: cut(a.reason, 900) };
  return { kind: 'other', text: cut(JSON.stringify(a), 700) };
}
/* 待确认的权限请求：id -> {resolve, res, timer}。前端 POST /api/agent/approve 来决定；
 * SSE 连接断开或 10 分钟没人点，一律按「拒绝」处理（宁可不动手）。 */
const AGENT_PENDING = new Map();
function agentAskApproval(id, res) {
  return new Promise((resolve) => {
    /* 这个 finish 会被三条路调用：前端点按钮、DELETE 取消、10 分钟超时。
     * 三处都可能先一步把 map 里的条目删掉，所以**不能**用「条目还在不在」当守卫
     * —— 之前就是这里 `if (!it) return;` 让批准之后 promise 永远不 resolve，
     * 表现为「点了允许就卡死，工具既不执行也不回话」。用一个本地 done 标志去重即可。 */
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      const it = AGENT_PENDING.get(id);
      if (it) clearTimeout(it.timer);
      AGENT_PENDING.delete(id);
      resolve(d);
    };
    const timer = setTimeout(() => finish('timeout'), 10 * 60 * 1000);
    AGENT_PENDING.set(id, { resolve: finish, res, timer });
  });
}
function agentDenyPending(res) {
  for (const it of Array.from(AGENT_PENDING.values())) if (it.res === res) it.resolve('deny');
}
/* --------------- agent 调用链的通用件（前缀缓存 / 编码 / 上下文预算 / 重复读取） --------------- */
/** 把「本机时间」挂到最后一条用户消息的末尾。
 *  ⚠ 绝不能放进 system 提示：system 是 messages 的第一条，逐秒变化会让 llama-server 的
 *  KV 前缀缓存整段作废 —— 实测 agent 模式下每轮 4000+ token 全量重算（cached_n=0、
 *  单步 4.0s）；挪到最后一条用户消息之后命中率 99%，单步 1.8s。 */
function stampConvoTime(convo) {
  const stamp = '（本机时间：' + (process.env.LOCALMODEL_FROZEN_TIME || new Date().toLocaleString('zh-CN')) + '）';
  for (let i = convo.length - 1; i >= 0; i--) {
    const m = convo[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') m.content = m.content + '\n' + stamp;
    else if (Array.isArray(m.content)) m.content = m.content.concat([{ type: 'text', text: '\n' + stamp }]);
    else m.content = stamp;
    return;
  }
}
/** 按原来的编码写回。Node 只能写 utf-8 / utf-16，GBK 文件会被转成 UTF-8 ——
 *  这一点要如实告诉模型（否则它会以为文件没变），不能静默转码。 */
function encodeWithEncoding(text, encoding) {
  const t = String(text === undefined || text === null ? '' : text);
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]);
  if (encoding === 'utf-16be') { const b = Buffer.from(t, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), b]); }
  if (encoding === 'utf-8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t, 'utf8')]);
  return Buffer.from(t, 'utf8');
}
/** 展开路径里的 %TEMP% / $env:TEMP。模型很爱写 %TEMP%\x.ps1：不展开就会在工作目录里
 *  真的建出一个叫「%TEMP%」的目录（静默错位）。取不到值时报错，别让它悄悄换地方。 */
function expandEnvInPath(s) {
  let missing = '';
  const pick = (name) => process.env[name] || process.env[name.toUpperCase()] || process.env[name.toLowerCase()] || '';
  const out = String(s)
    .replace(/%([^%\\/]{1,40})%/g, (m0, name) => { const v = pick(name); if (v) return v; missing = name; return m0; })
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (m0, name) => { const v = pick(name); if (v) return v; missing = name; return m0; });
  return { path: out, missing };
}
/** robocopy 0–7 都是成功；findstr / Select-String 无匹配 = 1；git diff --quiet 有差异 = 1；
 *  fc 有差异 = 1。这些非零码以前一律算失败 ⇒ 进闩锁 ⇒ 逼着模型换写法重试。只看最后一行。 */
function benignExit(cmd, code) {
  if (typeof code !== 'number' || !code) return false;
  const lines = String(cmd || '').split('\n').map(x => x.trim()).filter(Boolean);
  const last = (lines[lines.length - 1] || '').replace(/^[&.]\s*/, '');
  if (/\brobocopy\b/i.test(last)) return code >= 0 && code <= 7;
  if (/\b(findstr|select-string|sls)\b/i.test(last)) return code === 1;
  if (/\bgit\s+(diff|status)\b[^\n]*--quiet/i.test(last)) return code === 1;
  if (/^\s*(&|\.)?\s*fc\b/i.test(last)) return code === 1;
  return false;
}
/* ---- 上下文预算 ----
 * 工具结果是原样进历史、每步全量重发的，本机模型只有 32K：一挤爆引擎就回 HTTP 400
 * （exceed_context_size_error），整轮报废（实测那次 34161 / 32768）。两道防线：
 *  ① 每步发送前粗算 token，超预算就把较早的工具结果截短；
 *  ② 真被引擎拒了，再狠裁一轮然后重试一次，而不是把这一轮丢掉。 */
function roughTokens(m) {
  const c = (m && m.content) === undefined || (m && m.content) === null ? ''
    : (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  const t = String(c);
  let cjk = 0, other = 0;
  for (const ch of t) { const cp = ch.codePointAt(0); if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xff00 && cp <= 0xffef)) cjk++; else other++; }
  /* 一个汉字在这个词表里约 0.65 token：实测 42265 个汉字 ≈ 26646 token。这里按 0.8 算，
   * 英文/数字按 3.2 字一个 token —— 都偏保守，宁可早裁一点也别被引擎拒（400 直接毁掉整轮）。 */
  return Math.ceil(cjk * 0.8) + Math.ceil(other / 3.2) + 8;
}
function estimateTokens(convo) { let n = 0; for (const m of convo) n += roughTokens(m); return n; }
function ctxBudget() { try { return Math.max(2048, Number(readSettings().ctx) || 16384); } catch (_) { return 16384; } }
/** 把最老的工具结果截短，直到估算 token 落进预算。keepTail = 最多保护最近几条；force = 连它们也裁。
 *  ⚠ 光按「条数」保护是不够的：本轮实测 4 条一万多 token 的大输出全落在「最近 6 条」里，
 *  结果一条都没裁、提示冲到 31101 / 32768（再多一条就 400 报废）。所以保护还要受份额约束：
 *  被保护的那些加起来不超过预算的 55%，最新的一条永远保。 */
function trimToolHistory(convo, budget, keepTail, force) {
  const keep = Math.max(0, keepTail === undefined ? 6 : keepTail);
  const idx = [];
  for (let i = 0; i < convo.length; i++) if (convo[i] && convo[i].role === 'tool') idx.push(i);
  const protect = new Set();
  if (!force && keep > 0) {
    const share = Math.max(1200, Math.floor(budget * 0.55));
    let acc = 0;
    for (let k = idx.length - 1; k >= 0 && protect.size < keep; k--) {
      const t = roughTokens(convo[idx[k]]);
      if (protect.size > 0 && acc + t > share) break;
      acc += t; protect.add(idx[k]);
    }
  }
  let total = estimateTokens(convo);
  let trimmed = 0;
  for (const i of idx) {
    if (total <= budget) break;
    if (protect.has(i)) continue;
    const m = convo[i];
    const t = String(m.content || '');
    if (t.length <= 400) continue;
    const short = t.slice(0, 400) + '\n…（这条工具结果太长，为了腾出上下文已经截断；需要细节请重新调用一次该工具，或用更窄的参数重读）';
    total += roughTokens({ content: short }) - roughTokens({ content: t });
    m.content = short;
    trimmed++;
  }
  return { tokens: total, trimmed };
}
/* ---- 重复读取的记忆 ----
 * 实测模型会把同一个 demo\hello.txt 读 9 次（跨 6 轮），每次都把整段内容再灌一遍。
 * 文件没变（mtime + size 相同）就只回一句「和上次一样」+ 开头预览；真要完整内容，
 * 它会再读一次（第二次给全文）。写操作后整表清掉。 */
const READ_MEMO = new Map();
const READ_MEMO_MAX = 200;
function readMemoGet(key) {
  const v = READ_MEMO.get(key);
  if (!v) return null;
  let st; try { st = fs.statSync(v.file); } catch (_) { READ_MEMO.delete(key); return null; }
  if (st.mtimeMs !== v.mtimeMs || st.size !== v.size) { READ_MEMO.delete(key); return null; }
  return v;
}
function readMemoSet(key, file, text) {
  let st; try { st = fs.statSync(file); } catch (_) { return; }
  if (READ_MEMO.size >= READ_MEMO_MAX) READ_MEMO.delete(READ_MEMO.keys().next().value);
  READ_MEMO.set(key, { file, mtimeMs: st.mtimeMs, size: st.size, text: String(text || ''), hits: 0 });
}
function agentSystemPrompt(s, mode, root, sandbox) {
  const sb = sandbox || agentSandbox(s, mode);
  const ro = mode === 'plan';
  const L = [];
  L.push('# 角色');
  L.push('你是运行在用户本机上的编码 agent（模型跑在本机显卡上，工具由宿主程序真实执行）。');
  L.push('工作目录：' + root);
  L.push('权限档位：' + sb.label + '（沙箱模式 ' + sb.mode + '）。');
  /* ⚠ 这里**不能**放「当前时间」这类逐秒变化的东西：system 提示是 messages 的第一条，
   * 它一变，llama-server 的 KV 前缀缓存就整段作废 —— 实测 agent 模式下每轮 4000+ token
   * 全量重算（cached_n=0、单步 4.0s），把时间挪到最后一条用户消息后命中率 99%、单步 1.8s。
   * 时间由 stampConvoTime() 挂到最后一条用户消息末尾。 */
  L.push('系统：Windows；可用的命令解释器是 ' + PS_SHELL.label + '（' + PS_SHELL.exe + '）。当前时间在最后一条用户消息末尾（「（本机时间：…）」）。');
  L.push('');
  L.push('# 工作方式');
  L.push('1. 先看再改：动手前用 list_files / read_file / grep 把事实查清楚，绝不凭记忆猜文件内容、路径或行号。');
  L.push('2. 互不依赖的调用请**放在同一条消息里一次发出来**（例如一次读三个文件、一次看两个目录）；一步能做完的别拆成好几步。只有后一步真的要等前一步的结果时才分步做。');
  L.push('3. 改已有文件优先用 edit_file（old_string 要带足上下文、逐字一致）；只有新建文件或整篇重写才用 write_file。');
  L.push('4. 工具报错时按错误信息修正做法，不要原样重试 —— 唯一的例外是沙箱拒绝（见下面「权限（沙箱）」一节：那种情况可以申请一次性放行后原样重试一次）。');
  L.push('5. 做完后用中文给最终答复：做了什么、改了哪些文件、结果如何。不要复述工具原始输出。');
  L.push('6. 别做无关探索：不要遍历整个磁盘、不要读几十 MB 的文件、不要为了确认而跑一堆命令。');
  L.push('7. 要执行命令（看目录、跑脚本、装依赖、调 CLI）就用 run_command 工具，不要试图用读写文件去模拟命令的效果。');
  L.push('8. 工具怎么用，看本提示与每个工具的参数说明就够：**不要为了搞清某个工具怎么用去 web_search**（搜不到，还白烧一轮）。');
  L.push('');
  L.push('# 命令怎么写（run_command）');
  L.push('· 当前解释器是 ' + PS_SHELL.label + '（' + (PS_SHELL.pwsh ? 'PowerShell 7 支持 && 和 ||，也支持 5.1 的老写法' : '没有 pwsh，**不支持 && 和 ||**') + '）：' + (PS_SHELL.pwsh ? '多条命令可以用 && 串起来，也可以用 ; 顺序执行。' : '多条命令用 ; 分隔；「前一条成功才继续」写成 if ($?) { … }。'));
  L.push('· command 是一段可以多行的脚本；路径带空格要加引号（"C:\\Program Files"），含通配符的路径用 -LiteralPath。');
  L.push('· 先窄后宽：能用 -Filter / Where-Object / Select-String / Select-Object -First 20 收窄，就别把成千上万行倒出来（输出超过 12000 字会被截断）。要总数用 (… | Measure-Object).Count，不要列全表。');
  L.push('· 不要下发会等人的命令（Read-Host / pause / more / Out-GridView / 不带 -m 的 git commit / 不带参数的 python、node）：后台没有键盘，只会卡到超时。需要用户输入就停下来直接问他。');
  L.push('· 默认超时 60 秒；装依赖、构建、跑长脚本时传 timeoutMs（最多 600000）。');
  L.push('· 报错就按报错改写法（工具会给你「[提示] 怎么改」）。**同一条命令原样重试会被直接拒绝**，它会把上次的输出再还给你。拿不准命令存不存在先 Get-Command，拿不准路径先 Test-Path。');
  L.push('· 别用 cmd 的写法（dir /b、del /q、copy /y）：PowerShell 里用 Get-ChildItem、Remove-Item、Copy-Item。');
  L.push('· 脚本比较长、或者要反复改，就用 write_file 写成 .ps1 再 run_command 执行（' + (PS_SHELL.pwsh ? 'PowerShell 7 默认按 UTF-8 读脚本，编码不用你操心' : '写 .ps1 时工具会自动补上 5.1 需要的 UTF-8 BOM，编码不用你操心') + '）。');
  L.push('');
  L.push('# 权限（沙箱）');
  L.push('当前档位：' + sb.label + '（' + sb.mode + '）。');
  L.push('· 读文件：三档都不限制。工作目录外的绝对路径可以直接读（例如 C:\\Windows\\Web\\Wallpaper\\ThemeC\\img28.jpg 或 C:\\Users\\LEGION\\Desktop），不必先复制进工作目录。');
  if (sb.key === 'readonly') {
    L.push('· 写文件：本档一律不允许。任何写 / 改都会返回 [sandbox: file access denied under read-only mode]。');
    L.push('· 执行命令：允许，但每次都要用户在卡片上点「允许」（命令可能顺手改文件，所以本档一律先问）。不要用命令去改文件 —— 那等于绕过用户。');
  } else if (sb.key === 'workspace') {
    L.push('· 写文件：只允许写工作目录（' + root + '）里面的文件；写到外面会返回 [sandbox: file access denied under workspace-write mode]。');
    L.push('· 执行命令：在工作目录里执行；要不要用户点「允许」由设置里的权限决定（本档下命令本身不受路径栅栏限制，所以更要如实说明你要做什么）。');
  } else {
    L.push('· 写文件：不限制，任何路径都能写。');
    L.push('· 执行命令：不限制，直接执行、不再询问用户。');
  }
  L.push('被沙箱拒绝时（工具返回里带 [sandbox: file access denied under … mode]）：**不要绕路** —— 换工具、换路径、写临时文件、用命令去改文件，都算绕过。如果你确信这一步确实必须做，调用 request_permission（action: write|exec，target，reason）说明理由；用户在卡片上点「允许」后，你原样重试刚才那次调用一次，这一次会按「完全权限」放行（只放行一次，之后照旧按档位判定）。');
  L.push('用户点「拒绝」就是最终决定：立刻停下，用中文说清楚你想做什么、为什么被拒、需要用户决定什么，不要换个办法再试同一件事。也不要为了试探边界去做明知会被拒的操作。');
  L.push('');
  L.push('# 文档');
  L.push('9. 用户上传的文档会以「【文档 N】文件名（类型 · 页数 · 字数）」+ 路径 + 正文的形式出现在对话里。超长时正文只贴了开头，并且会写明「还有多少字没贴」。');
  L.push('10. 要读没贴出来的部分，用 read_document（带 offset 继续读；Excel 可以用 sheet 指定第几个工作表，它会告诉你一共有哪些表）。read_file 也能读文档，两者等价。');
  L.push('11. 要产出文档（报告、表格、.docx、.xlsx、PDF）用 write_document：正文用 Markdown 写，Word/PDF 会自动排版；Excel 可以给 sheets 写多张表。只写纯文本/代码才用 write_file。');
  L.push('12. 图片、扫描件 PDF、以及文字层坏掉的 PDF（抽出来是乱码/问号的，比如国标那种）没有可用文字：read_document 会自动把页面渲染成图交给本机视觉模型逐页读（不是 OCR），给结果时说明「这是本机视觉模型读图得到的」。它一次读设置里的几页，剩下的带 page 参数接着读。');
  L.push('13. 用户说「按原图尺寸」「和这张一样大」时，**不要自己去解析图片字节猜宽高**（PowerShell 抠 JPEG 极易算错）。用 read_document / read_file 读那张图，返回里会明确写「图片尺寸：宽×高 像素」，照这个数传给 generate_image 的 width/height；超过 1536 会被自动缩小，工具会回报实际用的尺寸。');
  L.push('14. 用户消息里如果出现「（识图失败：…）」或「（这段内容的文字层不可用…）」，就照实告诉用户：要么打开设置里的「识图」，要么把图片直接贴进对话；不要假装读到了内容。');
  if (ro) {
    L.push('');
    L.push('# 只读档（Plan）');
    L.push('当前是只读档：你的工具**只有** list_files / read_file / read_document / grep / web_search / web_fetch / request_permission。');
    L.push('写文件、改文件、执行命令的工具此刻不存在；用别的办法绕（上网查工具用法、找替代工具、写脚本）同样不允许。');
    L.push('用户要你改文件或跑命令时，首选**不要动手**，直接在回答里给出「改动方案」：');
    L.push('① 要改的文件路径；② 现在的内容（关键几行原文）；③ 准备改成什么；④ 这么改的理由。');
    L.push('然后提醒用户：把输入框上方的权限档位从「仅可查看」切到「工作区内修改」或「完全权限」，你才能动手。只有用户明确要求你现在就做、且你确信非做不可时，才用 request_permission 申请一次性放行。');
  }
  const md = ['AGENTS.md', 'LOCALMODEL.md', '.localmodel.md'].map(f => {
    try {
      const t = fs.readFileSync(path.join(root, f), 'utf8').trim();
      return t ? ('## ' + f + '\n' + t.slice(0, 6000)) : '';
    } catch (_) { return ''; }
  }).filter(Boolean).join('\n\n');
  if (md) { L.push(''); L.push('# 工作目录里的项目约定（自动读入，务必遵守）'); L.push(md); }
  return L.join('\n');
}

/* ----------------------- 本地视觉模型（扫描件 / 图片） -----------------------
 * 图片、扫描件 PDF、以及文字层坏掉的 PDF（方正/国标类，抽出来是「犐犆犛」和问号）
 * 都没有可用文字，靠本机带视觉塔（mmproj）的模型看图 —— 不是 OCR，是让模型读页面。
 * 引擎就是对话引擎本身（同一个进程既能聊天又能看图），只要 /props 里
 * modalities.vision 为 true 就能用；没开就临时把设置里的「识图」打开并重启引擎。 */
let _visionProbe = { at: 0, ok: false };
async function engineVision(force) {
  const now = Date.now();
  if (!force && now - _visionProbe.at < 5000) return _visionProbe.ok;
  let ok = false;
  try {
    const r = await httpJson(CHAT_PORT, '/props', 'GET', undefined, 5000);
    ok = !!(r && r.json && r.json.modalities && r.json.modalities.vision);
  } catch (_) { ok = false; }
  _visionProbe = { at: now, ok };
  return ok;
}

/** 确认引擎带视觉塔；没有就打开「识图」并重启引擎（30–60 秒）。 */
async function ensureVisionEngine(onStatus) {
  const say = typeof onStatus === 'function' ? onStatus : () => {};
  const s0 = readSettings();
  if (await engineVision(true)) return { ok: true, restarted: false, model: s0.model };
  if (!mmprojPath(s0.model)) {
    throw new Error('当前模型「' + s0.model + '」没有视觉塔文件（mmproj），看不了图；换成 Ornith 系列再试。');
  }
  if (s0.vision !== true) {
    say('这段内容没有文字层，正在打开「识图」并重启对话引擎（约 30–60 秒，之后不用再等）…');
    writeSettings(Object.assign({}, s0, { vision: true }));
  } else {
    say('正在重启对话引擎加载视觉塔（约 30–60 秒）…');
  }
  await withGate(() => ensureChat({ force: true }));
  if (!(await engineVision(true))) throw new Error('引擎重启后仍然没有视觉能力：请确认模型带 mmproj，或把上下文调小一点（显存不够会加载失败）。');
  return { ok: true, restarted: true, model: readSettings().model };
}
function visionCfg(s) {
  return {
    port: CHAT_PORT,
    maxPages: Math.max(1, Math.min(12, Number(s.docVisionPages) || 4)),
    maxEdge: Math.max(320, Math.min(2400, Number(s.imageMaxEdge) || 1280)),
    maxTokens: 1600,
    timeoutMs: 300000,
  };
}
/** 这份文档有没有「可用的文字层」——没有就得让模型看图。 */
function docNeedsVision(r) {
  if (!r) return false;
  if (r.kind === 'image') return true;
  if (r.kind !== 'pdf') return false;
  return !!(r.meta && (r.meta.scanned || r.meta.warn));
}
/** 会话里的图存成 /session-file/<name> 这种相对 URL，引擎读不到 —— 换回 data: URL。 */
function sessionFileDataUrl(u) {
  const m = /^\/session-file\/([^/?#]+)$/.exec(String(u || ''));
  if (!m) return null;
  let name; try { name = decodeURIComponent(m[1]); } catch (_) { name = m[1]; }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  try { return 'data:' + mime + ';base64,' + fs.readFileSync(path.join(SESS_DIR, name)).toString('base64'); }
  catch (_) { return null; }
}

/* --------------------------- 文档 → 文本归一化 ----------------------------
 * 前端把上传的文档作为 content part {type:'doc', path, name} 发过来（图片走 image_url）。
 * 引擎只认 text / image_url，所以这里在发请求前把 doc part 换成贴好正文的文本块：
 * 「【文档 N】名字（类型 · 页数 · 字数）+ 路径 + 正文」，超长只贴前 docMaxChars 字，
 * 并写明还剩多少、怎么接着读（read_document 带 offset）。docAutoRead 关掉就只给路径。 */
async function inlineDocParts(messages, s, emit) {
  const cap = Math.max(1000, Math.min(200000, Number(s.docMaxChars) || 12000));
  const auto = s.docAutoRead !== false;
  const vOn = s.docVision !== false;
  const root = agentRootDir();
  const say = typeof emit === 'function' ? emit : () => {};
  /* 需要识图时只保证一次引擎（一轮里挂多份扫描件不会重复重启） */
  let visionP = null;
  const ensureV = () => {
    if (!visionP) visionP = ensureVisionEngine(t => say({ type: 'status', text: t }));
    return visionP;
  };
  let n = 0;
  const out = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m || !Array.isArray(m.content)) { out.push(m); continue; }
    const docs = [], texts = [], imgs = [];
    for (const p of m.content) {
      if (!p) continue;
      if (p.type === 'doc') docs.push(p);
      else if (p.type === 'image_url') imgs.push(p);
      else texts.push(String((p && p.text) || ''));
    }
    /* 图片 part 里的 /session-file/xxx.jpg 是重开会话后才有的相对地址，引擎读不到，
     * 这里换回 data: URL（新贴的图本来就是 data: URL，原样带过去）。 */
    const imgsOut = imgs.map(p => {
      const u = p && p.image_url && p.image_url.url;
      const d = sessionFileDataUrl(u);
      return d ? { type: 'image_url', image_url: Object.assign({}, p.image_url, { url: d }) } : p;
    });
    if (!docs.length) {
      out.push(imgsOut.length ? Object.assign({}, m, { content: [].concat(texts.map(t => ({ type: 'text', text: t })), imgsOut) }) : m);
      continue;
    }
    const blocks = [];
    for (const p of docs) {
      n++;
      const pth = String(p.path || '');
      const title = String(p.name || '') || path.basename(pth) || '文档';
      let head = '【文档 ' + n + '】' + title;
      let body = '';
      let r = null;
      try { r = await DOC.extractPath(pth); }
      catch (e) { blocks.push(head + '（读不出来：' + String((e && e.message) || e) + '）'); continue; }
      head += '（' + DOC.formatNote(r) + '）';
      const rel = agentShowPath(root, r.path || pth);
      head += '\n路径：' + rel;
      if (r.note) head += '\n解析说明：' + r.note;
      const t = String(r.text || '');
      const needV = docNeedsVision(r);
      if (needV && auto && vOn) {
        /* 没有文字层：把页面渲染成图，交给本机视觉模型（不是 OCR —— 模型自己读页面） */
        try {
          await ensureV();
          const cfg = visionCfg(s);
          const which = r.kind === 'image' ? '这张图片'
            : (r.meta && r.meta.scanned ? '这份扫描件' : '这份 PDF（文字层不可靠，按图读）');
          say({ type: 'status', text: '正在用本机视觉模型读' + which + '：' + title });
          const vr = await VISION.readDocument(cfg, r.path || pth, {
            kind: r.kind === 'image' ? 'image' : 'pdf',
            first: 1, maxPages: cfg.maxPages, maxEdge: cfg.maxEdge,
            onProgress: i => say({ type: 'status', text: '正在识别第 ' + i.page + '/' + i.total + ' 页…' }),
          });
          const more = vr.total > vr.pages ? '（模型只看了前 ' + vr.pages + ' 页，全文共 ' + vr.total + ' 页；要读后面的页，把模式切到「执行」后用 read_document 带 page 参数）' : '';
          head += imageSizeLine(r, vr, cfg.maxEdge);
          head += '\n识别方式：本机视觉模型逐页读图，' + (vr.ms / 1000).toFixed(1) + ' 秒' + more;
          const vt = String(vr.text || '');
          const useCap2 = Math.min(cap, 20000);
          if (vt.length > useCap2) {
            body = '\n--- 识别结果开始（共 ' + vt.length + ' 字，这里贴前 ' + useCap2 + ' 字）---\n' + vt.slice(0, useCap2) +
              '\n--- 识别结果结束（还剩 ' + (vt.length - useCap2) + ' 字没贴）---';
          } else {
            body = '\n--- 识别结果开始（共 ' + vt.length + ' 字）---\n' + vt + '\n--- 识别结果结束 ---';
          }
        } catch (e) {
          head += '\n（识图失败：' + String((e && e.message) || e) + '）' + (t.trim() ? '' : '\n（也没有文字层可用，暂时读不了）');
        }
      } else if (needV && auto && !vOn) {
        head += '\n（这段内容的文字层不可用；设置里「扫描件 / 图片交给本机视觉模型读」是关的，所以没识图。打开它就能读。）';
      } else if (!auto) {
        head += '\n（按设置没有自动贴正文：要读它就用 read_document 工具）';
      } else {
        const useCap = (r.meta && r.meta.warn) ? Math.min(cap, 1500) : cap;
        if (!t.trim()) head += '\n（这份文档没抽到文字，可能是扫描件或空文件）';
        else if (t.length > useCap) {
          body = '\n--- 正文开始（共 ' + t.length + ' 字，这里贴前 ' + useCap + ' 字）---\n' + t.slice(0, useCap) +
            '\n--- 正文结束（还剩 ' + (t.length - useCap) + ' 字没贴；要读后面的内容就用 read_document 工具，offset=' + useCap + '）---';
        } else {
          body = '\n--- 正文开始（共 ' + t.length + ' 字）---\n' + t + '\n--- 正文结束 ---';
        }
      }
      blocks.push(head + body);
    }
    const merged = blocks.concat(texts).filter(x => String(x || '').trim() !== '').join('\n\n');
    if (!imgsOut.length) out.push(Object.assign({}, m, { content: merged }));
    else out.push(Object.assign({}, m, { content: [{ type: 'text', text: merged }].concat(imgsOut) }));
  }
  return out;
}

/* ------------------------------- SSE helpers ---------------------------- */
function sseOpen(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
}
function sse(res, obj) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {} }

/* ------------------------ stream one chat completion -------------------- */
function streamCompletion(payload, handlers, _attempt, signal) {
  const attempt = _attempt || 0;
  let hadChunk = false;
  return new Promise((resolve, reject) => {
    /* 用户已经按过「停止」了：连引擎都不用惊动。 */
    if (signal && signal.aborted) return resolve();
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: CHAT_PORT, path: '/v1/chat/completions', method: 'POST',
      /* agent:false —— 每次请求都开新连接。agent 模式一轮要连打好几次引擎，
       * 复用 keep-alive 连接时会撞上「引擎已经把这根连接关了」⇒ socket hang up，
       * 表现就是工具跑完那一轮直接报错收场。本地连接很便宜，不值得复用。 */
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': body.length, 'accept': 'text/event-stream' },
    }, res => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => reject(new Error('engine HTTP ' + res.statusCode + ': ' + Buffer.concat(chunks).toString('utf8').slice(0, 600))));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let j = null;
          try { j = JSON.parse(data); } catch (_) { continue; }
          try { handlers.onChunk(j); hadChunk = true; } catch (e) { log('handler error: ' + e.message); }
        }
      });
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    /* 用户按了「停止」：把连到引擎的这根连接掐掉，让引擎立刻腾出它那唯一的槽位。
     * 不掐的话，引擎会继续把这一轮安安静静生完（本机思考版模型跑几百秒很正常），
     * 用户紧接着发的下一条只能在门外排队 —— 界面上就是「一直转圈、什么都不出来」。 */
    if (signal) signal.addEventListener('abort', () => {
      log('client stopped this turn; dropping the engine request');
      try { req.destroy(); } catch (_) {}
      resolve();
    }, { once: true });
    req.on('error', (e) => {
      /* 上面那根 destroy 也会触发 error —— 那是我们自己掐的，不算失败，更不该重试。 */
      if (signal && signal.aborted) return;
      const msg = String((e && e.message) || '');
      const refused = /ECONNREFUSED/i.test(msg);
      /* 一个字都没吐出来就断（多半是引擎关掉了一根复用的旧连接）：换新连接重试一次。 */
      if (attempt < 1 && !hadChunk && (/socket hang up|ECONNRESET|EPIPE|other side closed/i.test(msg) || refused)) {
        const next = () => streamCompletion(payload, handlers, attempt + 1, signal).then(resolve, reject);
        if (refused) {
          /* 端口上根本没人监听 = 引擎被判给绘图、或者被停掉之后没回来。重试之前必须先把
           * 它拉起来，否则用户等半天只等到一句裸的 connect ECONNREFUSED 127.0.0.1:8110。 */
          log('engine is not listening on ' + CHAT_PORT + '; bringing the chat model back up');
          Promise.resolve().then(() => withGate(() => ensureChat({}))).then(next, (e2) => reject(new Error(
            '对话引擎没有在运行（127.0.0.1:' + CHAT_PORT + ' 连不上），自动重启也没有成功：'
            + String((e2 && e2.message) || e2) + '。到「设置 → 对话」点一次重启引擎，或重启本程序。')));
          return;
        }
        log('engine reset before any token; retrying once');
        next();
        return;
      }
      if (refused) {
        reject(new Error('对话引擎没有在运行（127.0.0.1:' + CHAT_PORT + ' 连不上）。'
          + '再发一条消息会自动重启它；如果还不行就重启本程序。'));
        return;
      }
      reject(e);
    });
    req.setTimeout(20 * 60 * 1000, () => req.destroy(new Error('engine timeout')));
    req.write(body);
    req.end();
  });
}

function extractChunk(j) {
  const out = { content: '', reasoning: '', toolCalls: null, finish: null, usage: null, timings: null };
  // `usage` and the aggregate `timings` arrive in a FINAL chunk whose choices array
  // is EMPTY, so these must be read before the choices guard, not after it.
  if (j.usage) out.usage = j.usage;
  if (j.timings) out.timings = j.timings;
  const ch = j.choices && j.choices[0];
  if (!ch) return out;
  const d = ch.delta || {};
  if (typeof d.content === 'string') out.content = d.content;
  if (typeof d.reasoning_content === 'string') out.reasoning = d.reasoning_content;
  else if (typeof d.reasoning === 'string') out.reasoning = d.reasoning;
  if (Array.isArray(d.tool_calls)) out.toolCalls = d.tool_calls;
  if (ch.finish_reason) out.finish = ch.finish_reason;
  if (j.usage) out.usage = j.usage;
  return out;
}

/* ================================ ROUTES ================================ */
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > (limit || 64 * 1024 * 1024)) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch (e) { throw new Error('invalid JSON body'); }
}
function serveFile(res, p, type) {
  try {
    const b = fs.readFileSync(p);
    res.writeHead(200, { 'content-type': type, 'content-length': b.length, 'cache-control': 'no-store' });
    res.end(b); return true;
  } catch (_) { return false; }
}

/* ========================= 会话存储 (app/sessions.json) =========================
 * 对话历史以前完全活在前端内存里，刷新就没。现在由前端把「可持久化的消息数组」
 * PUT 上来，服务端落盘。贴图的 data: URL 会在这里解码成 app/session-files/ 下的
 * 文件并改写成 /session-file/<name>，否则 sessions.json 会被 base64 撑到几十 MB
 * （沿用 Qwen Studio history.json 的 tmp+rename 写法，避免半截 JSON）。 */
const SESS_MAX = 200;
const IMG_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function readSessions() {
  try {
    const d = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (d && Array.isArray(d.sessions)) return d;
  } catch (_) {}
  return { version: 1, activeId: null, sessions: [] };
}
function writeSessions(d) {
  try {
    const tmp = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 1), 'utf8');
    fs.renameSync(tmp, SESSIONS_FILE);       // 同目录改名：原子替换，读端永远看到完整 JSON
  } catch (e) { log('save sessions failed: ' + (e.message || e)); }
}
function newSessionId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function sessionTitle(msgs) {
  const u = (msgs || []).find(m => m && m.role === 'user' && String(m.text || '').trim());
  const t = u ? String(u.text).trim().split('\n')[0] : '';
  return t ? t.slice(0, 30) : '新会话';
}
function sessOverview(d) {
  return {
    activeId: d.activeId,
    sessions: d.sessions.map(s => ({ id: s.id, title: s.title, created: s.created, updated: s.updated, count: (s.messages || []).length })),
  };
}
function sessFind(id) { return readSessions().sessions.find(x => x.id === id); }
/* 只留渲染得出结果的字段；贴图落盘换 URL */
function persistMessages(sid, msgs) {
  let n = 0;
  return (Array.isArray(msgs) ? msgs : []).slice(0, 500).map(m => {
    if (!m || typeof m !== 'object') return null;
    const c = {
      id: Number(m.id) || 0, role: String(m.role || 'user'), text: String(m.text || ''),
      think: String(m.think || ''), err: !!m.err, done: true,
    };
    if (m.stats && typeof m.stats === 'object') c.stats = m.stats;
    if (m.tool && m.tool.name) c.tool = { name: String(m.tool.name), args: m.tool.args || {}, done: true };
    if (m.search && m.search.query) {
      c.search = {
        query: String(m.search.query),
        results: (Array.isArray(m.search.results) ? m.search.results : []).slice(0, 8)
          .map(r => ({ title: String(r.title || ''), link: String(r.link || ''), snippet: String(r.snippet || '') })),
        open: false,
      };
    }
    if (Array.isArray(m.images) && m.images.length) {
      c.images = m.images.map(im => {
        const url = String((im && im.url) || '');
        if (url.startsWith('data:')) {
          const mm = /^data:([^;,]+);base64,(.*)$/.exec(url);
          if (!mm) return null;
          const ext = IMG_EXT[mm[1].toLowerCase()] || 'jpg';
          const name = sid + '-' + c.id + '-' + (++n) + '.' + ext;
          try { fs.writeFileSync(path.join(SESS_DIR, name), Buffer.from(mm[2], 'base64')); } catch (_) { return null; }
          return { url: '/session-file/' + name, w: Number(im.w) || 0, h: Number(im.h) || 0, name: String(im.name || name) };
        }
        /* 这条是「已经有 URL」的图（用户上传后落过盘的，或模型生成的图）。
         * 以前这里丢掉 name、还硬塞 file:'' / size:0 ⇒ 每次重新保存会话，
         * 上传图的原始文件名就没了（alt / 悬浮提示只剩「图片」）。已有的字段照抄，
         * 没有的键就别写，这样来回保存不会越存越少。 */
        let out = url;
        /* 模型生成的图走的是 /img/…、/output/… —— 那些路径由绘图内核（8802）现算现给，
         * 内核一停，历史记录里的图就变成「图片打不开」。所以第一次保存时把文件复制进
         * 会话目录、换成自己的 /session-file/ 路线，以后不依赖绘图内核在不在。 */
        if (!out.startsWith('/session-file/') && /^\/(img|output)\//.test(out) && im.file) {
          try {
            const src = String(im.file);
            if (fs.existsSync(src)) {
              const ext = (path.extname(src).slice(1) || 'png').toLowerCase();
              const nm = sid + '-img-' + c.id + '-' + (++n) + '.' + ext;
              fs.copyFileSync(src, path.join(SESS_DIR, nm));
              out = '/session-file/' + nm;
            }
          } catch (_) { /* 复制不了就沿用原 URL，至少别把记录弄丢 */ }
        }
        const o = { url: out };
        if (im.file) o.file = String(im.file);
        o.w = Number(im.w) || 0;
        o.h = Number(im.h) || 0;
        if (im.size) o.size = Number(im.size) || 0;
        if (im.name) o.name = String(im.name);
        return o;
      }).filter(Boolean);
      if (!c.images.length) delete c.images;
    }
    /* 用户这轮上传的文档（PDF / Word / Excel / PPT / 文本…）：以前整个字段被丢掉，
     * 结果刷新页面 / 切会话后对话记录里就只剩文字，看不到自己传过的文件
     * （原文件其实还在 app/doc-files/，只是没人记住它）。这里按渲染需要的字段存下来，
     * chips 用的 url 是 /doc-file/<stored>，重开时照旧能点开原文件。 */
    if (Array.isArray(m.docs) && m.docs.length) {
      c.docs = m.docs.map(d => {
        if (!d || typeof d !== 'object') return null;
        const o = {
          name: String(d.name || ''), path: String(d.path || ''), kind: String(d.kind || ''),
          ext: String(d.ext || ''), note: String(d.note || ''), warn: String(d.warn || ''),
          chars: Number(d.chars) || 0, pages: Number(d.pages) || 0, slides: Number(d.slides) || 0,
          size: Number(d.size) || 0, stored: String(d.stored || ''), url: String(d.url || ''),
        };
        if (Array.isArray(d.sheets)) o.sheets = d.sheets.slice(0, 40).map(x => String(x));
        if (d.needVision) { o.needVision = true; o.visionOn = d.visionOn !== false; }
        if (!o.url && o.stored) o.url = '/doc-file/' + encodeURIComponent(o.stored);
        if (!o.stored && o.url.startsWith('/doc-file/')) { try { o.stored = decodeURIComponent(o.url.slice('/doc-file/'.length)); } catch (_) {} }
        return (o.name || o.path || o.stored) ? o : null;
      }).filter(Boolean);
      if (!c.docs.length) delete c.docs;
    }
    return c;
  }).filter(Boolean);
}
function dropSessionFiles(sid) {
  for (const dir of [SESS_DIR, DOC_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) if (f.startsWith(sid + '-')) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
    } catch (_) {}
  }
  /* 会话删了就把解析缓存也清掉，免得缓存里攒着已经不存在的文件 */
  try { DOC.clearCache(); } catch (_) {}
}
/* 上传文档的下载/预览：按扩展名给正确的内容类型（图片那套 /session-file/ 不认识 docx）。 */
const DOC_MIME = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rtf: 'application/rtf', csv: 'text/csv; charset=utf-8', tsv: 'text/tab-separated-values; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  xml: 'application/xml; charset=utf-8', yaml: 'text/yaml; charset=utf-8', yml: 'text/yaml; charset=utf-8',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip',
};
function docMime(name) { return DOC_MIME[DOC.extOf(name).toLowerCase()] || 'application/octet-stream'; }

async function buildState() {
  const s = readSettings();
  const g = await gpuStats(true);
  const [cAlive, cReady, iAlive, cAlive2] = await Promise.all([
    chatAlive(), chatReady(), imageAlive(), comfyAlive(),
  ]);
  let loraAdapters = null;
  if (cReady && s.lora && s.lora !== 'none') {
    try { const r = await httpJson(CHAT_PORT, '/lora-adapters', 'GET', undefined, 5000); loraAdapters = r.json; } catch (_) {}
  }
  let imgHealth = null, imgStatus = null;
  /* 系统级负面词存在桥的 image/settings.json 里。桥没跑时 /api/status 拿不到，所以直接
   * 读文件兜底 —— 界面上那个框永远有值可显示，不会因为「绘图内核没启动」而变空。 */
  let sysNeg = '';
  let outDir = '';
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(IMAGE_DIR, 'settings.json'), 'utf8'));
    sysNeg = String((raw || {}).sys_negative || '');
    outDir = String((raw || {}).output_dir || '');
  } catch (_) {}
  /* 没改过输出位置时，桥把图从 ComfyUI 自己的 output 搬过来 —— 界面上得能看见这条默认路径。 */
  const defaultOutDir = path.join(IMG_CFG.portable || 'E:\\ComfyUI_windows_portable', 'ComfyUI', 'output');
  if (iAlive) {
    try { imgHealth = (await httpJson(IMG_PORT, '/api/health', 'GET', undefined, 5000)).json; } catch (_) {}
    try { const r = await httpJson(IMG_PORT, '/api/status', 'GET', undefined, 8000); imgStatus = r.json; } catch (_) {}
  }
  return {
    app: { port: APP_PORT, root: ROOT, config: CFG, version: '2.0.0' },
    mode: arb.mode, switching: arb.switching, lastError: arb.lastError,
    gpu: g,
    chat: {
      settings: s, schema: SCHEMA, presets: PRESETS, catalog: CATALOG,
      port: CHAT_PORT, args: chat.args, alive: cAlive, ready: cReady,
      startedAt: chat.startedAt, loraAdapters,
    },
    image: {
      port: IMG_PORT, comfyPort: COMFY_PORT, alive: iAlive, comfyAlive: cAlive2,
      health: imgHealth, status: imgStatus, sysNegative: sysNeg,
      outDir: outDir || defaultOutDir, outDirDefault: defaultOutDir,
      outDirIsDefault: !outDir || outDir.toLowerCase() === defaultOutDir.toLowerCase(),
      workflowPatched: null,
    },
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  const M = req.method;
  try {
    /* ---------------------------------------------------------- static UI */
    if (M === 'GET' && (p === '/' || p === '/index.html')) {
      if (serveFile(res, path.join(UI_DIR, 'index.html'), 'text/html; charset=utf-8')) return;
      return json(res, 404, { error: 'ui/index.html missing' });
    }
    if (M === 'GET' && p === '/favicon.ico') {
      const ico = path.join(IMAGE_DIR, 'qwen-studio.ico');
      if (serveFile(res, ico, 'image/x-icon')) return;
      res.writeHead(204); return res.end();
    }
    /* ------------------------------------------- proxy image-side assets */
    if (M === 'GET' && (p.startsWith('/output/') || p.startsWith('/img/') || p === '/abs')) {
      if (!(await imageAlive())) { res.writeHead(404); return res.end('image engine not running'); }
      const r = await imageProxy(p + (u.search || ''), 'GET', undefined, 30000);
      res.writeHead(r.status, { 'content-type': r.headers['content-type'] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(r.body);
    }

    /* ------------------------------------------------------------ state */
    if (M === 'GET' && p === '/api/state') return json(res, 200, await buildState());
    if (M === 'GET' && p === '/api/gpu') return json(res, 200, await gpuStats(true));

    /* ----------------------------------------------------- chat settings */
    if (M === 'POST' && p === '/api/settings') {
      const body = await readJson(req);
      const before = readSettings();
      const after = Object.assign({}, before, body.settings || {});
      writeSettings(after);
      const d = diffSettings(before, after);
      let restarted = false;
      if (d.needRestart.length) {
        await withGate(async () => { await ensureChat({ force: true }); });
        restarted = true;
      } else if (cfg_loraTouch(before, after)) {
        await withGate(async () => {
          await ensureChat({});
          if (await chatReady()) await setLoraScale(CHAT_PORT, after.loraScale);
        });
      }
      return json(res, 200, { ok: true, changed: d.changed, needRestart: d.needRestart, restarted });
    }
    if (M === 'POST' && p === '/api/preset') {
      const body = await readJson(req);
      const preset = PRESETS.find(x => x.id === body.id);
      if (!preset) return json(res, 400, { error: 'unknown preset' });
      const before = readSettings();
      const after = Object.assign({}, before, preset.settings);
      writeSettings(after);
      const d = diffSettings(before, after);
      let lora = null;
      await withGate(async () => {
        if (d.needRestart.length || !(await chatAlive())) {
          await ensureChat({ force: true });
        } else {
          await ensureChat({});
        }
        const s2 = readSettings();
        if (s2.lora !== 'none' && Number(s2.loraScale) !== 1 && await chatReady()) {
          lora = await setLoraScale(CHAT_PORT, s2.loraScale);
          appendFile(CHAT_LOG, '# applied lora scale ' + s2.loraScale + ' -> ' + (lora.raw || '') + '\n');
        }
      });
      return json(res, 200, { ok: true, needRestart: d.needRestart, restarted: true, lora, settings: readSettings() });
    }
    if (M === 'POST' && p === '/api/apply-lora') {
      const body = await readJson(req);
      const s = readSettings();
      const scale = body.scale === undefined ? s.loraScale : body.scale;
      if (!(await chatAlive())) return json(res, 409, { error: 'chat engine not running' });
      const r = await setLoraScale(CHAT_PORT, scale);
      return json(res, r.ok ? 200 : 500, r);
    }
    if (M === 'POST' && p === '/api/server') {
      const body = await readJson(req);
      const act = body.action;
      if (act === 'stop') { await withGate(async () => { await releaseChat(); }); return json(res, 200, { ok: true, mode: arb.mode }); }
      if (act === 'start' || act === 'restart') {
        const r = await withGate(async () => ensureChat({ force: true }));
        return json(res, 200, { ok: true, mode: arb.mode, ...r });
      }
      return json(res, 400, { error: 'unknown action' });
    }
    if (M === 'GET' && p === '/api/log') {
      const n = Number(u.searchParams.get('lines') || 200);
      const target = u.searchParams.get('which') === 'bridge' ? BRIDGE_LOG : CHAT_LOG;
      const txt = tailFile(target, 400000).split(/\r?\n/).slice(-n).join('\n');
      return json(res, 200, { which: u.searchParams.get('which') || 'chat', text: txt });
    }

    /* ------------------------------------------------------ switch modes */
    if (M === 'POST' && p === '/api/switch') {
      const body = await readJson(req);
      if (body.target === 'chat') { const r = await withGate(() => ensureChat({})); return json(res, 200, { ok: true, mode: arb.mode, ...r }); }
      if (body.target === 'image') { const r = await withGate(() => ensureImage()); return json(res, 200, { ok: true, mode: arb.mode, ...r }); }
      if (body.target === 'none') { await withGate(async () => { await releaseChat(); await releaseImage(); }); return json(res, 200, { ok: true, mode: arb.mode }); }
      return json(res, 400, { error: 'unknown target' });
    }

    /* ------------------------------------------------------- web search */
    if (M === 'GET' && p === '/api/search') {
      const q = u.searchParams.get('q') || '';
      if (!q.trim()) return json(res, 400, { error: 'missing q' });
      const r = await searchWeb(q, Number(u.searchParams.get('count') || 0) || undefined);
      return json(res, 200, r);
    }

    /* --------------------------------------------------------- IMAGE API */
    if (p.startsWith('/api/image/')) {
      const sub = p.slice('/api/image/'.length);
      if (sub === 'status' || sub === 'health') {
        const alive = await imageAlive();
        if (!alive) return json(res, 200, { alive: false });
        const h = await httpJson(IMG_PORT, '/api/' + (sub === 'health' ? 'health' : 'status'), 'GET', undefined, 8000);
        return json(res, 200, { alive: true, ...(h.json || {}) });
      }
      if (sub === 'history') {
        if (!(await imageAlive())) return json(res, 200, []);
        const r = await imageProxy('/api/history', 'GET', undefined, 20000);
        res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(r.body);
      }
      if (sub === 'boot') { const r = await withGate(() => ensureImage()); return json(res, 200, { ok: true, mode: arb.mode, ...r }); }
      if (sub === 'stop') { await withGate(async () => { await stopBridge(); }); return json(res, 200, { ok: true }); }
      if (sub === 'free') {
        if (!(await comfyAlive())) return json(res, 200, { ok: false, error: 'comfy not running' });
        const f = await comfyFree();
        const w = await waitVramBelow(RELEASE_TARGET, 20000);
        return json(res, 200, { ok: f.ok, free: f, vram: w, gpu: await gpuStats(true) });
      }
      if (sub === 'quit') {
        await withGate(async () => { await stopBridge(); });
        return json(res, 200, { ok: true, gpu: await gpuStats(true) });
      }
      /* 系统级负面词是「设置」，不是画图任务：桥在跑就交给桥存（它会顺手更新内存里的
       * SYS_NEG），桥没跑就直接写它的 image/settings.json —— 绝不能为了存一个设置项
       * 走进下面的 ensureImage()，那会把 ComfyUI 拉起来（首次 30–60 秒、吃满显存）。 */
      if (sub === 'sys-negative') {
        const sbody = (M === 'POST') ? await readBody(req) : undefined;
        let sparsed = undefined;
        if (sbody && sbody.length) { try { sparsed = JSON.parse(sbody.toString('utf8')); } catch (_) { sparsed = undefined; } }
        const val = String((sparsed || {}).sys_negative || '').slice(0, 16000);
        if (await imageAlive()) {
          const r = await imageProxy('/api/sys-negative', 'POST', { sys_negative: val }, 15000);
          res.writeHead(r.status, { 'content-type': r.headers['content-type'] || 'application/json; charset=utf-8' });
          return res.end(r.body);
        }
        try {
          const f = path.join(IMAGE_DIR, 'settings.json');
          let st = {};
          try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { st = {}; }
          if (!st || typeof st !== 'object') st = {};
          st.sys_negative = val;
          /* 行尾跟桥保持一致（Python 文本模式写出来是 CRLF），免得同一份文件被两边来回改写时字节反复变。 */
          fs.writeFileSync(f, JSON.stringify(st, null, 2).replace(/\n/g, '\r\n'), 'utf8');
          log('sys negative -> ' + val.length + ' chars (bridge down; written to image/settings.json)');
          return json(res, 200, { ok: true, sys_negative: val, saved: 'file' });
        } catch (e) {
          return json(res, 500, { ok: false, error: String((e && e.message) || e) });
        }
      }
      /* 换输出位置：桥在跑就交给桥弹框（它能顺手更新内存里的 OUT_DIR）；桥没跑时自己弹，
       * 同样不能为了改一个设置项走进下面的 ensureImage()（那会把 ComfyUI 拉起来）。 */
      if (sub === 'pick-output-dir') {
        // 这个分支在通用分支之前，得自己把 body 读出来（readBody 一个请求只能读一次）
        const rawBody = (M === 'POST') ? await readBody(req) : undefined;
        let sel = undefined;
        if (rawBody && rawBody.length) { try { sel = JSON.parse(rawBody.toString('utf8')); } catch (_) { sel = undefined; } }
        if (await imageAlive()) {
          const r = await imageProxy('/api/pick-output-dir', 'POST', sel || {}, 300000);
          res.writeHead(r.status, { 'content-type': r.headers['content-type'] || 'application/json; charset=utf-8' });
          return res.end(r.body);
        }
        return json(res, 200, await pickOutputDirFallback(sel));
      }
      // everything else: ensure the image side is up, then forward verbatim
      const body = (M === 'POST') ? await readBody(req) : undefined;
      /* 每次生图请求落一行。起因：2026-10-10 那次「点了生成半天不出图」，日志里
       * 没有任何一行能说明请求到底有没有到后端 —— 前端卡在「正在画 · 0/8」、
       * 桥在空转，谁也分不清是没发出去还是发出去被丢了。有这行一眼能分辨。 */
      if (sub !== 'status' && sub !== 'health') {
        log('image api ' + M + ' /api/image/' + sub + (body && body.length ? ' body=' + body.length + 'B' : ''));
      }
      await withGate(() => ensureImage());
      let parsed = undefined;
      if (body && body.length) { try { parsed = JSON.parse(body.toString('utf8')); } catch (_) { parsed = undefined; } }
      const r = await imageProxy('/api/' + sub, M, parsed, 120000);
      res.writeHead(r.status, { 'content-type': r.headers['content-type'] || 'application/json; charset=utf-8' });
      return res.end(r.body);
    }

    /* ------------------------------------------------ cross-modal generate */
    if (M === 'POST' && p === '/api/generate-image') {
      const body = await readJson(req);
      const params = body.params || body;
      const files = body.files || [];
      let out = null, fail = null;
      try {
        out = await withGate(async () => {
          await ensureImage();
          return runImageJob(params, files, body.onProgress);
        });
      } catch (e) { fail = e; }
      // hand the GPU back to chat afterwards unless told otherwise —— 失败/超时也要还：
      // 以前只有成功路径才回切，生图一失败对话引擎就被留在「已卸载」状态，
      // 下一轮对话直接 connect ECONNREFUSED 127.0.0.1:8110。
      if (body.keepImage !== true) {
        try { await withGate(() => ensureChat({})); } catch (e) { log('re-ensure chat failed: ' + e.message); }
      }
      if (fail) return json(res, 500, { ok: false, error: String(fail.message || fail) });
      return json(res, 200, out);
    }

    /* ------------------------------------------------------- agent 控制面 */
    /* 选 Agent 工作目录：只回路径，落盘走 /api/settings（跟出图目录不同，不碰文件）。 */
    if (M === 'POST' && p === '/api/agent/pick-dir') {
      const body = await readJson(req);
      const want = body && typeof body.path === 'string' ? body.path.trim() : '';
      if (want) {
        let abs = want;
        try { abs = path.resolve(want); } catch (_) {}
        try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { return json(res, 200, { ok: false, error: '建不了这个目录：' + String((e && e.message) || e) }); }
        return json(res, 200, { ok: true, dir: abs });
      }
      return json(res, 200, await pickFolderDialog('选择 Agent 工作目录（它只能在这里读写文件、执行命令）', String(body.current || ''), 'pick-agent-dir.tmp'));
    }
    /* 界面上点「允许 / 拒绝 / 本次会话都允许」时打这里；也可以 DELETE 掉挂着的确认。 */
    if (p === '/api/agent/approve') {
      if (M === 'DELETE') {
        const q2 = new URL(req.url, 'http://x').searchParams;
        const d = AGENT_PENDING.get(String(q2.get('id') || ''));
        if (d) { clearTimeout(d.timer); d.resolve('deny'); AGENT_PENDING.delete(String(q2.get('id') || '')); }
        return json(res, 200, { ok: true, cancelled: !!d });
      }
      const body = await readJson(req);
      const id = String(body.id || '');
      const d = AGENT_PENDING.get(id);
      if (!d) return json(res, 200, { ok: false, error: '没有等待中的确认（可能已经超时）' });
      clearTimeout(d.timer);
      AGENT_PENDING.delete(id);
      const decision = body.decision === 'allow' || body.decision === 'allow_always' ? 'allow' : 'deny';
      d.resolve(decision);
      return json(res, 200, { ok: true, decision: decision, always: body.decision === 'allow_always' });
    }
    /* 在资源管理器里定位一个文件（工具卡片上的「在文件夹里显示」）。只允许 Agent
       工作目录内的路径，防止界面被当成任意文件的打开器。 */
    if (M === 'POST' && p === '/api/agent/reveal') {
      const body = await readJson(req);
      let abs = '';
      try { abs = agentAbs(String(body.path || ''), agentRootDir()); }
      catch (e) { return json(res, 200, { ok: false, error: String((e && e.message) || e) }); }
      if (!fs.existsSync(abs)) return json(res, 200, { ok: false, error: '文件已经不在了：' + abs });
      try { spawn('explorer.exe', ['/select,' + abs], { detached: true, stdio: 'ignore' }).unref(); }
      catch (e) { return json(res, 200, { ok: false, error: String((e && e.message) || e) }); }
      return json(res, 200, { ok: true, path: abs });
    }

    /* ------------------------------------------------------------ 文档上传 */
    /* 前端把文件原样 POST 上来（二进制体），文件名走 query：
       POST /api/upload?name=<encodeURIComponent(原名)>&sid=<会话 id>
       落盘到 app/doc-files/<sid>-doc-<n>-<原名>，顺手解析一次拿类型/页数/字数，
       正文不在这一步发给模型 —— 真正的贴正文在 /api/chat 里做（见 inlineDocParts）。 */
    if (M === 'POST' && p.startsWith('/api/upload')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const rawName = String(q.get('name') || '').trim() || 'upload.bin';
      const sid = (String(q.get('sid') || 'tmp').replace(/[^A-Za-z0-9_-]/g, '') || 'tmp').slice(0, 40);
      let buf;
      try { buf = await readBody(req, 64 * 1024 * 1024); }
      catch (e) { return json(res, 413, { ok: false, error: '文件太大（上限 64 MB）或上传中断：' + String((e && e.message) || e) }); }
      if (!buf.length) return json(res, 400, { ok: false, error: '空文件' });
      const base = path.basename(rawName).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60) || 'file';
      const seq = (DOC_SEQ = DOC_SEQ + 1);
      const name = sid + '-doc-' + seq + '-' + base;
      const abs = path.join(DOC_DIR, name);
      try { fs.writeFileSync(abs, buf); } catch (e) { return json(res, 500, { ok: false, error: '存不进临时目录：' + String((e && e.message) || e) }); }
      const info = {
        ok: true, name: base, stored: name, size: buf.length, url: '/doc-file/' + encodeURIComponent(name),
        path: abs, ext: DOC.extOf(base).toLowerCase(),
      };
      try {
        const r = await DOC.extractPath(abs);
        info.kind = r.kind;
        info.chars = String(r.text || '').length;
        info.note = DOC.formatNote(r);
        info.pages = r.pages ? r.pages.length : 0;
        info.sheets = Array.isArray(r.sheets) ? r.sheets.map(x => x.name || '') : [];
        info.slides = Array.isArray(r.slides) ? r.slides.length : 0;
        info.rows = (r.meta && r.meta.rows) || 0;
        info.encoding = (r.meta && r.meta.encoding) || '';
        if (r.note) info.warn = r.note;
        /* 没有可用文字层（图片 / 扫描件 / 方正那种坏文字层）：界面据此显示「需识图」 */
        info.needVision = docNeedsVision(r);
        info.visionOn = readSettings().docVision !== false;
        if (r.convertedFrom) info.converted = '已用本机 Office 转成 OOXML 后解析';
        info.preview = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      } catch (e) {
        info.warn = '这个文件没能解析出文本：' + String((e && e.message) || e);
      }
      log('[doc] upload ' + base + ' → ' + name + ' (' + (buf.length / 1024).toFixed(1) + ' KB, kind=' + (info.kind || '?') + ', chars=' + (info.chars || 0) + ')');
      return json(res, 200, info);
    }
    /* 从输入框里移除附件时删掉临时文件（只允许删 doc-files 里自己那一个）。 */
    if (M === 'DELETE' && p.startsWith('/api/upload')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const name = path.basename(String(q.get('stored') || ''));
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return json(res, 400, { ok: false, error: 'bad name' });
      try { fs.unlinkSync(path.join(DOC_DIR, name)); } catch (_) {}
      return json(res, 200, { ok: true });
    }

    /* --------------------------------------------------------------- chat */
    if (M === 'POST' && p === '/api/chat') {
      const body = await readJson(req);
      const s = readSettings();
      const messages0 = Array.isArray(body.messages) ? body.messages.slice() : [];
      const useSearch = body.search !== undefined ? !!body.search : !!s.webSearch;
      const allowTools = body.tools !== false;
      /* agent 模式：off（普通对话，只有出图工具）/ build（全工具）/ plan（只读）。
       * 「本次会话都允许」由前端记着，跟着请求一起发回来，所以服务端不需要会话状态。 */
      const agentMode = (body.agent === 'build' || body.agent === 'plan') ? body.agent : 'off';
      const autoAllow = new Set(Array.isArray(body.autoAllow) ? body.autoAllow.map(String) : []);
      const agRoot = agentMode === 'off' ? null : agentRootDir();
      /* 沙箱档位（照 DeepSeek Harness 的三档）：开关只决定「开不开 agent」，
       * 能做什么由这一档决定 —— 仅可查看 / 工作区内修改 / 完全权限。 */
      const agSandbox = agentSandbox(s, agentMode, body.perm);
      /* 一次性放行：模型被沙箱拒绝后调 request_permission，用户在卡片上点「允许」，
       * 这里记一笔；它随后原样重试的那次调用按「完全权限」执行（只放行一次）。 */
      let oneShot = null;
      /* 同一条命令本轮失败过就记在这儿：模型原样重提时直接拒绝并把上次输出还给它（省时间也省 token）。 */
      const cmdMemo = new Map();
      const maxIters = agentMode === 'off' ? 4 : Math.max(2, Math.min(40, Number(s.agentMaxSteps) || 16));
      sseOpen(res);
      const t0 = Date.now();
      /* 前端按了「停止」= fetch 被 abort = 这条 SSE 断开。断了就别再往下跑工具了，
       * 尤其是等待确认的那一步：直接按拒绝收场。 */
      let clientGone = false;
      /* 「停止」= 这条 SSE 断了。除了不再往下跑工具，还要把连到引擎的请求一起掐掉：
       * 只置一个标志位是不够的 —— 引擎会继续把这一轮生完（本机只有一个槽位），用户紧接着
       * 发的下一条就一直排队，界面表现为「一直转圈、连思考过程都看不到」。 */
      const turnAbort = new AbortController();
      res.on('close', () => {
        /* 正常收尾时 res.end() 也会触发 close —— 那不算「用户按了停止」，别去掐引擎。 */
        if (res.writableEnded) return;
        clientGone = true;
        agentDenyPending(res);
        try { turnAbort.abort(); } catch (_) {}
      });

      try {
        await withGate(() => ensureChat({}));
      } catch (e) {
        sse(res, { type: 'error', error: '对话引擎启动失败：' + (e.message || e) });
        sse(res, { type: 'done' }); return res.end();
      }
      sse(res, { type: 'mode', mode: arb.mode, port: CHAT_PORT });

      /* 文档归一化（doc part → 文本）本来在 SSE 之前做，现在挪到这儿：扫描件/图片要现场
       * 让本机视觉模型读图，可能要几十秒到几分钟，期间必须能把「正在识别第 n/m 页」推给
       * 界面，不能让它干等着什么都不显示。 */
      let messages;
      try {
        messages = await inlineDocParts(messages0, s, o => sse(res, o));
      } catch (e) {
        sse(res, { type: 'error', error: '整理文档失败：' + ((e && e.message) || e) });
        sse(res, { type: 'done' }); return res.end();
      }
      /* 贴了图（image_url）也一样：引擎没带视觉塔就先装上，否则图等于没发出去。 */
      if (messages.some(m => Array.isArray(m && m.content) && m.content.some(p => p && p.type === 'image_url'))) {
        try { await ensureVisionEngine(t => sse(res, { type: 'status', text: t })); }
        catch (e) { sse(res, { type: 'status', text: '看图失败：' + ((e && e.message) || e) + '（会当普通文字继续回答）' }); }
      }
      const lastUserPeek = () => {
        const u = [...messages].reverse().find(m => m && m.role === 'user');
        return u ? (typeof u.content === 'string' ? u.content : (Array.isArray(u.content) ? u.content.filter(p => p && p.type === 'text').map(p => p.text).join(' ') : '')) : '';
      };

      // ---- optional web search on the latest user turn
      let sysExtra = '';
      if (useSearch) {
        const q = lastUserPeek().slice(0, 400);
        if (q.trim()) {
          sse(res, { type: 'status', text: '正在联网搜索：' + q.slice(0, 60) + '…' });
          try {
            const sr = await searchWeb(q);
            if (sr.ok) {
              sse(res, { type: 'search', query: q, results: sr.results });
              sysExtra = '\n\n以下是刚刚联网检索到的结果（Bing 实时检索）。请优先依据这些内容回答；如果它们与问题无关，就说明没搜到有用信息并照常回答。引用时给出链接：\n' +
                sr.results.map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.link + '\n   ' + r.snippet).join('\n');
            } else {
              sse(res, { type: 'status', text: '联网搜索没有返回结果，将直接回答。' });
            }
          } catch (e) {
            sse(res, { type: 'status', text: '联网搜索失败（' + (e.message || e) + '），将直接回答。' });
          }
        }
      }

      let sys = String(s.systemPrompt || 'You are a helpful assistant.');
      if (agentMode !== 'off') sys = agentSystemPrompt(s, agentMode, agRoot, agSandbox) + '\n\n' + sys;
      const convo = [{ role: 'system', content: sys + sysExtra }].concat(messages.filter(m => m.role !== 'system'));
      /* 时间戳挂到最后一条用户消息上，**不放进 system**（否则每轮都把 KV 前缀缓存打穿，见 stampConvoTime）。 */
      if (agentMode !== 'off') stampConvoTime(convo);

      /* 普通对话只挂出图工具（行为与以前完全一致）；agent 模式挂工具带，
       * plan / 仅可查看只挂只读那几个 + request_permission（工具不在列表里，模型就没法
       * 「不小心」改东西；真需要写的时候它只能来申请一次性放行）。 */
      const tools = agentMode === 'build' ? AGENT_TOOLS
        : agentMode === 'plan' ? AGENT_TOOLS.filter(t => AGENT_READONLY.has(t.function.name) || t.function.name === 'request_permission')
        : (allowTools ? [IMAGE_TOOL] : undefined);
      let iter = 0;
      let toolImages = null;
      let stats = null;
      let timings = null;
      let lastFinish = null;   // 最后一轮的 finish_reason（stop / length / tool_calls…），要回传给前端
      /* 最后一轮的正文/思考（用于识别「thinking 模型把输出预算全烧在思考上、正文为空」这
       * 种最常见的一类「模型没回话」）——实测 ornith-1.5-9b-think + 推理强度 xhigh +
       * maxTokens 12288 时，一张图的问题能思考 800 多秒、正文一个字都没有。 */
      let lastContent = '', lastReasoning = '';
      let hitCap = false;
      let stopDeny = false;
      let denies = 0;

      /* 每轮请求体都走这里：采样参数、思考开关、工具开关集中一处，收尾那次「总结」
       * 只要 noTools=true 就能复用同一套参数。 */
      const mkPayload = (noTools) => {
        const payload = {
          messages: convo, stream: true, stream_options: { include_usage: true },
          timings_per_token: true,
          max_tokens: Number(s.maxTokens), temperature: Number(s.temperature),
          top_p: Number(s.topP), top_k: Number(s.topK), min_p: Number(s.minP),
        };
        /* 字段名很关键：llama.cpp 的 OAI 端点认的是 repeat_penalty（不是 HF 风格的 repetition_penalty）。
         * 实测 build 10743：传 repetition_penalty 时输出与完全不传一字不差 —— 参数被静默忽略，
         * 界面上「重复惩罚」滑条因此长期是摆设，长文生成退化成一味复读。
         * 另外 repeat_last_n 默认只有 64 个 token，压不住成段的复读，这里放宽到 512。 */
        if (Number(s.repeatPenalty) !== 1) {
          payload.repeat_penalty = Number(s.repeatPenalty);
          payload.repeat_last_n = 512;
        }
        if (Number(s.seed) >= 0) payload.seed = Number(s.seed);
        const effReq = normEffort(s.reasoningEffort);
        const miReq = modelInfo(s.model);
        if (effReq === 'none' || miReq.forceNoThink) payload.chat_template_kwargs = { enable_thinking: false };
        else if (!miReq.skipEffort) payload.reasoning_effort = effReq;
        if (tools && !noTools) { payload.tools = tools; payload.tool_choice = 'auto'; }
        return payload;
      };
      /* 跑一次完整生成（一次 assistant 消息），把流式增量转成 SSE。 */
      const genOnce = async (payload) => {
        let content = '', reasoning = '';
        const tcAcc = {};
        let finish = null;
        let speedMark = 0;
        await streamCompletion(payload, {
          onChunk: j => {
            const c = extractChunk(j);
            if (c.reasoning) { reasoning += c.reasoning; sse(res, { type: 'reasoning', text: c.reasoning }); }
            if (c.content) { content += c.content; sse(res, { type: 'delta', text: c.content }); }
            if (c.toolCalls) {
              for (const tc of c.toolCalls) {
                const i = tc.index === undefined ? 0 : tc.index;
                tcAcc[i] = tcAcc[i] || { id: '', name: '', args: '' };
                if (tc.id) tcAcc[i].id = tc.id;
                if (tc.function && tc.function.name) tcAcc[i].name = tc.function.name;
                if (tc.function && tc.function.arguments) tcAcc[i].args += tc.function.arguments;
              }
            }
            if (c.finish) finish = c.finish;
            if (c.usage) stats = { prompt_tokens: c.usage.prompt_tokens, gen_tokens: c.usage.completion_tokens };
            if (c.timings && c.timings.predicted_n) {
              timings = c.timings;
              if (c.timings.predicted_n - speedMark >= 16) {
                speedMark = c.timings.predicted_n;
                sse(res, {
                  type: 'speed', n: c.timings.predicted_n,
                  tps: Number((c.timings.predicted_per_second || 0).toFixed(2)),
                  prompt_tps: Number((c.timings.prompt_per_second || 0).toFixed(2)),
                });
              }
            }
          },
        }, 0, turnAbort.signal);
        lastFinish = finish;
        lastContent = content; lastReasoning = reasoning;
        return { content, reasoning, finish, calls: Object.values(tcAcc).filter(x => x.name) };
      };
      /* 每一步都从这里发出去，顺带做两件以前没有的事：
       *  ① 发送前按上下文预算裁掉较早的工具结果（本机只有 32K，工具输出一多就会被引擎拒）；
       *  ② 真被拒（exceed_context_size_error / HTTP 400）时狠裁一轮再重试一次，而不是整轮丢掉。 */
      let overflowRetried = false;
      const genStep = async (noTools) => {
        try {
          const pre = trimToolHistory(convo, Math.floor(ctxBudget() * 0.8));
          if (pre.trimmed) log('[agent] 预算裁剪：截短 ' + pre.trimmed + ' 条较早的工具结果（现在约 ' + pre.tokens + ' token）');
          return await genOnce(mkPayload(noTools));
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (overflowRetried || !/exceed_context_size_error|exceeds the available context size|HTTP 400/i.test(msg)) throw e;
          overflowRetried = true;
          const cut = trimToolHistory(convo, Math.max(1200, Math.floor(ctxBudget() * 0.45)), 1, true);
          log('[agent] 上下文超限（' + msg.slice(0, 140) + '）；裁短 ' + cut.trimmed + ' 条工具结果后重试一次（约 ' + cut.tokens + ' token）');
          sse(res, { type: 'status', text: '这一步超出了引擎的上下文上限，已裁掉较早的工具输出，重试一次…' });
          return await genOnce(mkPayload(noTools));
        }
      };
      /* 同一个工具连续失败了几次：连着 3 次就把「别再原样重试」写进工具结果里。 */
      const failStreak = new Map();

      try {
        while (iter < maxIters) {
          if (clientGone) break;
          iter++;
          const g1 = await genStep(false);
          const content = g1.content, calls = g1.calls;
          /* 模型既写了正文又带了工具调用时，以前会把工具**静默丢掉**（等于骗它说已经调过），
           * 现在只要带了调用就照做。 */
          if (!calls.length) break;

          /* ---- 要调工具：逐个裁决权限、执行、把结果喂回去 ---- */
          sse(res, { type: 'step', n: iter, max: maxIters });
          /* 一条消息里多个没带 id 的调用要各自有唯一 id，否则前端卡片会互相覆盖。 */
          const callIds = calls.map((c, i) => c.id || ('call_' + iter + '_' + i));
          convo.push({ role: 'assistant', content: content || '', tool_calls: calls.map((c, i) => ({ id: callIds[i], type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
          /* 老的前端只认一个 {type:'tool'}；现在统一走工具卡片（tool_call / tool_start /
           * tool_result），所以这里不再额外发那条老事件。 */
          for (let ci = 0; ci < calls.length; ci++) {
            const call = calls[ci];
            if (clientGone) break;
            const id = callIds[ci];
            let args = {};
            try { args = JSON.parse(call.args || '{}'); } catch (_) { args = {}; }
            const tt0 = Date.now();
            if (agentMode === 'off') {
              /* 老行为原样保留：普通对话只挂出图工具，不需要确认，失败也温和地告诉模型。 */
              sse(res, { type: 'tool_call', id, name: call.name, args, perm: 'allow', mode: 'off', preview: agentPreview(call.name, args) });
              sse(res, { type: 'tool_start', id });
              const r0 = call.name === 'generate_image'
                ? await runAgentTool(call.name, args, { root: agRoot, mode: 'off', res, sse })
                : { ok: false, text: 'Unknown tool.' };
              if (r0.images) toolImages = (toolImages || []).concat(r0.images);
              /* 对话模式也要留一行日志：以前这里什么都不写，出图那次调用在 launcher.log 里
               * 完全看不到，只能靠猜。 */
              log('[tool:off] ' + call.name + ' ok=' + !!r0.ok + ' ms=' + (Date.now() - tt0) + ' ' + String(r0.text || '').replace(/\s+/g, ' ').slice(0, 200));
              sse(res, { type: 'tool_result', id, ok: !!r0.ok, output: r0.text, ms: Date.now() - tt0, files: r0.files || null });
              convo.push({ role: 'tool', tool_call_id: id, content: r0.text || (r0.ok ? '(done)' : 'Tool failed.') });
              continue;
            }
            const known = AGENT_TOOL_NAMES.has(call.name);
            /* 沙箱档位决定这次能不能做；上一次 request_permission 获批的一次性放行
             * 在这里消费掉 —— 匹配的那一次按「完全权限」跑，跑完即失效。 */
            let callSandbox = agSandbox.mode;
            let perm = agentPerm(s, call.name, agentMode, agSandbox);
            const oneshot = !!(oneShot && oneShot.remaining > 0 && known && oneShotMatches(oneShot, call.name, args, agRoot));
            if (oneshot) { oneShot.remaining = 0; callSandbox = 'danger-full-access'; perm = 'allow'; }
            log('[agent] step ' + iter + '/' + maxIters + ' ' + call.name + ' perm=' + perm + ' sandbox=' + callSandbox + (oneshot ? ' oneshot' : '') + ' args=' + JSON.stringify(args).slice(0, 300));
            sse(res, { type: 'tool_call', id, name: call.name, args, perm, mode: agentMode, sandbox: agSandbox, oneshot, preview: agentPreview(call.name, args) });
            let decision = 'allow';
            if (!known) decision = 'unknown';
            else if (perm === 'deny') decision = 'denied';
            else if (perm === 'ask' && !autoAllow.has(call.name)) {
              sse(res, { type: 'tool_wait', id });
              decision = await agentAskApproval(id, res);
            }
            if (decision !== 'allow') {
              const why = decision === 'unknown' ? ('没有这个工具：' + call.name)
                : decision === 'denied' ? ((agentMode === 'plan' || agSandbox.key === 'readonly')
                  ? '当前是「仅可查看」档（' + agSandbox.mode + '），写文件与执行命令一律不允许。如果你确信这一步必须做，调用 request_permission 说明 action / target / reason 申请一次性放行；否则把要改的东西讲清楚，让用户切到「工作区内修改」或「完全权限」档。'
                  : '当前档位或设置禁止了这类操作（写文件 / 执行命令）。换一种不需要它的做法，或告诉用户你需要开权限。')
                : decision === 'timeout' ? '用户 10 分钟内没有确认，按拒绝处理。'
                : '用户拒绝了这次操作。【这是最终决定】不要再用别的工具、别的命令、写临时文件或任何绕路方式去做同一件事 —— 那等于绕过用户。注意：这次操作**没有执行**，文件/系统没有任何变化，**不要对用户说已经完成**。现在就用中文说清楚：你想做什么、为什么被拒、需要用户决定什么，然后结束这一轮。';
              denies++;
              sse(res, { type: 'tool_result', id, ok: false, output: why, ms: 0, denied: true });
              convo.push({ role: 'tool', tool_call_id: id, content: why });
              continue;
            }
            sse(res, { type: 'tool_start', id });
            const r = await runAgentTool(call.name, args, { root: agRoot, mode: agentMode, sandbox: callSandbox, res, sse, cmdMemo });
            /* request_permission 获批：把它记成一次性放行，模型下一步原样重试那次被拒的调用。 */
            if (r && r.grant && r.grant.remaining > 0) {
              oneShot = r.grant;
              log('[agent] one-shot granted: ' + r.grant.action + ' ' + String(r.grant.target || ''));
            }
            if (r.images) toolImages = (toolImages || []).concat(r.images);
            /* 文件被改写后，「同一条命令」已经不再是同一次尝试：清掉命令去重闩锁。
             * 否则「改好脚本再跑一次」会被误判成原样重试而拒掉（实测踩过）。 */
            if (r && r.ok && /^(write_file|write_document|edit_file)$/.test(call.name)) { cmdMemo.clear(); READ_MEMO.clear(); }
            /* 同一个工具连续失败 3 次：光靠提示词劝不住小模型，直接把提醒写进工具结果里。 */
            if (r && r.ok) failStreak.delete(call.name);
            else {
              const streak = (failStreak.get(call.name) || 0) + 1;
              failStreak.set(call.name, streak);
              if (streak >= 3) r.text = String(r.text || '') + '\n\n[系统提醒] ' + call.name + ' 已经连续失败 ' + streak + ' 次：停下来换做法 —— 先用 read_file / list_files / grep 把事实看清楚，或者换一个工具；不要再用同样的参数重试。';
            }
            log('[agent] result ' + call.name + ' ok=' + !!r.ok + ' ms=' + (Date.now() - tt0) + ' ' + String(r.text || '').replace(/\s+/g, ' ').slice(0, 200));
            sse(res, { type: 'tool_result', id, ok: !!r.ok, output: r.text, ms: Date.now() - tt0, files: r.files || null });
            convo.push({ role: 'tool', tool_call_id: id, content: r.text || (r.ok ? '(done)' : '(failed)') });
          }
          if (iter >= maxIters) hitCap = true;
          /* 被拒两次就收手：小模型会一路「换个工具再来一遍」，问到第 9 次还在试。
           * 用户已经否决过了，再问只是骚扰 —— 直接进收尾，让它说清楚情况。 */
          if (denies >= 2) { stopDeny = true; break; }
        }
        /* 轮次用尽 / 连续被拒：让模型自己收个尾，别把会话停在半截的工具调用上 */
        if ((hitCap || stopDeny) && !clientGone) {
          try {
            sse(res, { type: 'status', text: stopDeny
              ? '用户已拒绝，正在收尾…'
              : '已达单次回合计步上限（' + maxIters + ' 步），正在收尾…' });
            /* 注意：这里**不能**用 {role:'system'} —— Qwen 的 chat 模板会抛
             * 「System message must be at the beginning.」（HTTP 500，被下面的 catch 吞掉，
             * 表现为「收尾那一步什么都没发生」）。中途插话只能用 user。 */
            convo.push({ role: 'user', content: stopDeny
              ? '【系统提示】用户已经拒绝了你的操作（' + denies + ' 次）。不要再调用任何工具，直接用中文说明：你想做什么、为什么需要它、现在卡在哪里、需要用户做什么决定。'
              : '【系统提示】你已达到本次回合的工具调用上限（' + maxIters + ' 步）。不要再调用任何工具，直接用中文总结：已经完成了什么、还差什么、下一步建议怎么做。' });
            const g2 = await genStep(true);
            if (g2.finish) lastFinish = g2.finish;
          } catch (e) { log('[agent] wrap-up failed: ' + (e && e.message)); }
        }
        const wall = (Date.now() - t0) / 1000;
        /* 正文一个字都没有、但思考了一大堆 ⇒ 输出预算被思考吃光了。别让用户对着空气发呆。 */
        if (!clientGone && !lastContent.trim() && lastReasoning.trim()) {
          sse(res, {
            type: 'status',
            text: '这次没有正式回答：模型把输出预算（最大输出 ' + Number(s.maxTokens) + ' 个 token）全用在「思考」上了'
              + (lastFinish === 'length' ? '（被上限截断）' : '') + '。把「最大输出」调大，或把「推理强度」调低一档再试。',
          });
        }
        sse(res, {
          type: 'stats', wall_s: Number(wall.toFixed(2)),
          gen_tokens: stats ? stats.gen_tokens : (timings ? timings.predicted_n : null),
          prompt_tokens: stats ? stats.prompt_tokens : (timings ? timings.prompt_n : null),
          gen_tps: timings ? Number((timings.predicted_per_second || 0).toFixed(2))
                           : (stats && stats.gen_tokens ? Number((stats.gen_tokens / wall).toFixed(2)) : null),
          prompt_tps: timings ? Number((timings.prompt_per_second || 0).toFixed(2)) : null,
          cached_n: timings ? timings.cache_n : null,
          images: toolImages,
          finish: lastFinish,
        });
        sse(res, { type: 'done' });
        res.end();
      } catch (e) {
        sse(res, { type: 'error', error: String(e.message || e) });
        sse(res, { type: 'done' });
        res.end();
      }
      return;
    }

    /* ------------------------------------------------------- sessions */
    if (p === '/api/sessions' && M === 'GET') return json(res, 200, sessOverview(readSessions()));
    if (p === '/api/sessions' && M === 'POST') {
      const d = readSessions();
      const s = { id: newSessionId(), title: '新会话', created: Date.now(), updated: Date.now(), messages: [] };
      d.sessions.unshift(s);
      d.activeId = s.id;
      while (d.sessions.length > SESS_MAX) { const gone = d.sessions.pop(); dropSessionFiles(gone.id); }
      writeSessions(d);
      return json(res, 200, { ok: true, session: { id: s.id, title: s.title, created: s.created, updated: s.updated, count: 0 }, sessions: sessOverview(d).sessions });
    }
    if (p === '/api/sessions/active' && M === 'POST') {
      const body = await readJson(req);
      const d = readSessions();
      if (d.sessions.some(x => x.id === body.id)) { d.activeId = String(body.id); writeSessions(d); }
      return json(res, 200, { ok: true, activeId: d.activeId });
    }
    if (M === 'GET' && p.startsWith('/session-file/')) {
      const name = p.slice('/session-file/'.length);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return json(res, 400, { error: 'bad name' });
      const type = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : /\.gif$/i.test(name) ? 'image/gif' : 'image/jpeg';
      if (serveFile(res, path.join(SESS_DIR, name), type)) return;
      return json(res, 404, { error: 'no such session file' });
    }
    /* 上传的文档：文件名可能带中文，所以用 decodeURIComponent + 「不许带路径分隔符」校验。 */
    if (M === 'GET' && p.startsWith('/doc-file/')) {
      let name = p.slice('/doc-file/'.length);
      try { name = decodeURIComponent(name); } catch (_) {}
      if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return json(res, 400, { error: 'bad name' });
      const abs = path.join(DOC_DIR, path.basename(name));
      const mime = docMime(name);
      if (serveFile(res, abs, mime)) return;
      return json(res, 404, { error: 'no such doc file' });
    }
    const sessM = /^\/api\/sessions\/([A-Za-z0-9_-]+)$/.exec(p);
    if (sessM) {
      const id = sessM[1];
      const d = readSessions();
      const s = d.sessions.find(x => x.id === id);
      if (!s) return json(res, 404, { error: 'no such session' });
      if (M === 'GET') return json(res, 200, { id: s.id, title: s.title, created: s.created, updated: s.updated, messages: s.messages || [] });
      if (M === 'PUT') {
        const body = await readJson(req);
        s.messages = persistMessages(s.id, body.messages);
        if (body.title !== undefined) s.title = String(body.title).slice(0, 60) || '新会话';
        else if (body.autotitle !== false) s.title = sessionTitle(s.messages);
        s.updated = Date.now();
        writeSessions(d);
        return json(res, 200, { ok: true, id: s.id, title: s.title, updated: s.updated, count: s.messages.length });
      }
      if (M === 'DELETE') {
        d.sessions = d.sessions.filter(x => x.id !== id);
        dropSessionFiles(id);
        if (d.activeId === id) d.activeId = d.sessions.length ? d.sessions[0].id : null;
        writeSessions(d);
        return json(res, 200, { ok: true, activeId: d.activeId, sessions: sessOverview(d).sessions });
      }
    }

    json(res, 404, { error: 'not found', path: p });
  } catch (e) {
    log('route error ' + p + ': ' + (e.stack || e.message || e));
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    else try { res.end(); } catch (_) {}
  }
});

function cfg_loraTouch(before, after) {
  return (before.lora !== after.lora) || (Number(before.loraScale) !== Number(after.loraScale));
}

/* ================================= MAIN ================================= */
async function boot() {
  log('local-model backend starting; root=' + ROOT + ' appPort=' + APP_PORT);
  await pickNvsmi();
  const g = await gpuStats(true);
  log('gpu: ' + JSON.stringify(g));
  const r = readSettings();
  writeSettings(r);
  try {
    const pid = await pidOnPort(CHAT_PORT);
    if (pid) { const n = await procImageName(pid); if (/llama-server/i.test(n)) { log('killing orphan llama-server ' + pid); await killTree(pid); } }
    const bpid = await pidOnPort(IMG_PORT);
    if (bpid) { const n = await procImageName(bpid); if (/python/i.test(n)) { log('killing orphan bridge ' + bpid); await killTree(bpid); } }
  } catch (_) {}
  // Engines are normally started on demand by the arbiter. With
  // config.chat.autoStartChat (default on) the chat engine is also warmed up right
  // after the UI is up, so double-clicking the desktop icon is the only click needed.
  const AUTO_START_CHAT = !(CFG.chat && CFG.chat.autoStartChat === false);
  server.on('error', (e) => {
    // Without this handler a taken port surfaces only as a generic "uncaught: listen
    // EADDRINUSE" log line while the process keeps running, so the launcher polls
    // forever against a backend that never came up.
    if (e && e.code === 'EADDRINUSE') {
      log('port ' + APP_PORT + ' is already in use -- another Local Model Studio instance?');
      process.stdout.write('local-model: port ' + APP_PORT + ' already in use\n');
    } else {
      log('server error: ' + ((e && e.stack) || e));
    }
    process.exit(2);
  });
  server.listen(APP_PORT, '127.0.0.1', () => {
    log('listening http://127.0.0.1:' + APP_PORT + '/');
    process.stdout.write('local-model ready: http://127.0.0.1:' + APP_PORT + '/\n');
    if (AUTO_START_CHAT) {
      log('auto-start chat engine (config chat.autoStartChat != false)');
      withGate(() => ensureChat({}))
        .then(r => log('auto-start chat done: ' + JSON.stringify(r)))
        .catch(e => log('auto-start chat failed: ' + ((e && e.stack) || e)));
    }
  });
}

async function shutdown(sig) {
  log('shutdown (' + sig + ')');
  try { await stopChat(); } catch (_) {}
  try { await stopBridge(); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', e => log('uncaught: ' + (e.stack || e.message || e)));
process.on('unhandledRejection', e => log('unhandled rejection: ' + ((e && e.stack) || e)));

/* Exported for launch.js: on Windows process.kill(self, 'SIGTERM') is a bare
 * TerminateProcess that runs no handlers, so the launcher must call shutdown()
 * directly or the engines are orphaned holding VRAM and their ports. */
module.exports = { shutdown, stopChat, stopBridge, chatAlive, imageAlive };

boot();
