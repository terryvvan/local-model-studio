/**
 * Bonsai Studio backend -- zero-dependency Node HTTP server.
 *
 * Two responsibilities:
 *   1. own the llama-server child process (start / stop / restart, log tail, health)
 *   2. serve the single-page UI and proxy chat requests to llama-server
 *
 * Why proxy instead of pointing the browser straight at llama-server: the UI needs one
 * stable origin (llama-server binds a port that changes when settings change), and it
 * needs to attach image parts in the OpenAI format the fork expects.
 *
 * Everything here is ASCII on purpose -- the browser never sees this file, but keeping
 * sources ASCII avoids the PowerShell 5.1 / WSH encoding traps this project already hit.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const APP_DIR = __dirname;
const BONSAI_DIR = path.resolve(APP_DIR, '..');
const BIN_DIR = path.join(BONSAI_DIR, 'llamacpp', 'bin');
const MODELS_DIR = path.join(BONSAI_DIR, 'models');
const LORA_DIR = path.join(BONSAI_DIR, 'lora');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const LOG_DIR = path.join(APP_DIR, 'logs');
const UI_DIR = path.join(APP_DIR, 'ui');

fs.mkdirSync(LOG_DIR, { recursive: true });

/* ------------------------------------------------------------------ model catalog */

const CATALOG = {
  models: [
    {
      id: 'bonsai-ptq1_0',
      name: 'Ternary Bonsai 2 27B (PTQ1_0, 5.95 GB)',
      file: path.join(MODELS_DIR, 'Ternary-Bonsai-2-27B-PTQ1_0.gguf'),
      mmproj: path.join(MODELS_DIR, 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf'),
      note: 'Ada (RTX 4060) decode is fastest on this pack. Required for the 8 GB card.',
    },
  ],
  loras: [
    {
      id: 'none',
      name: 'None (published model)',
      file: null,
      note: 'Stock refusal behaviour.',
    },
    {
      id: 'orcabonsai',
      name: 'OrcaBonsai abliterate (9.68 MB)',
      file: path.join(LORA_DIR, 'bonsai-abliterate-lora.gguf'),
      note: 'Runtime behavioural ablation. scale 1 keeps refusing here; scale 2 complies.',
    },
  ],
};

/* ------------------------------------------------------------------ settings schema
 * `restart: true` means the value is read by llama-server at startup only, so applying
 * it needs a process restart. Soft settings are sent per request by the UI.
 * `estimate` holds the measured impact on THIS machine (RTX 4060 Laptop, 8 GB) so the
 * tooltip can promise something real instead of a generic guess.
 */

const DEFAULTS = {
  model: 'bonsai-ptq1_0',
  lora: 'none',
  loraScale: 1.0,
  vision: false,
  port: 8110,
  ctx: 16384,
  ngl: 99,
  flashAttn: 'on',
  cacheTypeK: 'f16',
  cacheTypeV: 'f16',
  mmap: false,
  batch: 2048,
  ubatch: 512,
  parallel: 1,
  cacheRam: 4096,
  threads: 0,
  reasoningEffort: 'medium',
  maxTokens: 2048,
  temperature: 0.7,
  topP: 0.95,
  topK: 20,
  minP: 0.05,
  repeatPenalty: 1.0,
  seed: -1,
  imageMinTokens: 1024,
  imageMaxEdge: 1280,
  systemPrompt: 'You are a helpful assistant.',
};

const SCHEMA = [
  {
    group: 'model', title: '模型与上下文', icon: 'box',
    items: [
      { key: 'model', type: 'select', optionsFrom: 'models', label: '权重', restart: true,
        help: 'PTQ1_0 = 1.75 bit 三值包，5.95 GB。官方说明 Ada 代（你的 4060）与 L4 上 decode 最快、最省显存的选择。PQ2_0（7.21 GB）只在 H100/A100/Blackwell 上更快。',
        estimate: '实测本机整份权重上卡后 VRAM ≈ 7.6 GB / 8.19 GB。' },
      { key: 'ctx', type: 'slider', min: 2048, max: 262144, step: 2048, unit: 'tokens', label: '上下文长度 -c', restart: true,
        help: 'KV 缓存容量。原生支持 262144，但 KV 随上下文线性吃显存。',
        estimate: '4k/8k/16k 生成速度一样（22.5–23.2 t/s）；再往上开始挤显存。16k 时 VRAM ≈ 7.6 GB。32k 起必须在「KV 量化」上做手脚，否则爆显存。' },
      { key: 'ngl', type: 'slider', min: 0, max: 999, step: 1, unit: 'layers', label: 'GPU 层数 -ngl', restart: true,
        help: '999 = 全部 65 层都放显存。',
        estimate: '99 在本机是「全上卡」；调低只会更慢，仅在与其它吃显存程序共存时才有意义。' },
      { key: 'batch', type: 'slider', min: 64, max: 8192, step: 64, unit: 'tokens', label: '逻辑批大小 -b', restart: true,
        help: '预填充时一次算多少 token。越大预填充越快，但瞬时显存更高。',
        estimate: '实测（识图）：-b 2048/-ub 512 让图片预填充从 41.5 t/s 升到 54.0 t/s，同一张图的等待从 98–134 秒缩到 83 秒；纯文本预填充 116–130 t/s。' },
      { key: 'ubatch', type: 'slider', min: 32, max: 4096, step: 32, unit: 'tokens', label: '物理批大小 -ub', restart: true,
        help: '真正送进 GPU 的微批。显存不够时先降这个。',
        estimate: '实测识图时 -ub 512 比默认更快；显存不够就降到 256。' },
      { key: 'threads', type: 'slider', min: 0, max: 32, step: 1, unit: 'threads', label: 'CPU 线程 -t', restart: true,
        help: '0 = 自动。仅影响跑在 CPU 上的部分（本机通常是 0 层）。',
        estimate: '全层上卡时可忽略。' },
    ],
  },
  {
    group: 'speed', title: '速度与显存优化', icon: 'bolt',
    items: [
      { key: 'flashAttn', type: 'select', options: [['auto', 'auto'], ['on', 'on'], ['off', 'off']], label: 'Flash Attention -fa', restart: true,
        help: '融合注意力内核，同时省 KV 显存、加速长上下文预填充。',
        estimate: '本机全程 on。开它才能配合量化 KV 缓存。' },
      { key: 'cacheTypeK', type: 'select', options: [['f16', 'f16 (最准)'], ['q8_0', 'q8_0 (省一半)'], ['q4_0', 'q4_0 (省 3/4)']], label: 'KV 缓存 K 类型 -ctk', restart: true,
        help: '把 KV 缓存本身也量化。这是长上下文能在 8 GB 卡上跑起来的关键开关，代价是极轻微的精度损失。',
        estimate: '16k f16 KV ≈ 1.2 GB；换 q8_0 省约 0.6 GB，q4_0 省约 0.9 GB ⇒ 能把上下文从 16k 拉到 32k。生成速度基本不变。' },
      { key: 'cacheTypeV', type: 'select', options: [['f16', 'f16 (最准)'], ['q8_0', 'q8_0 (省一半)'], ['q4_0', 'q4_0 (省 3/4)']], label: 'KV 缓存 V 类型 -ctv', restart: true,
        help: '同 -ctk，作用于 V。经验上 V 比 K 更耐量化。',
        estimate: '与 K 同时降到 q8_0，32k 上下文仍能塞进 8 GB。' },
      { key: 'mmap', type: 'select', options: [[false, 'no-mmap (权重常驻显存)'], [true, 'mmap (可换出)']], label: '内存映射', restart: true,
        help: 'mmap 让权重按需从磁盘映射，启动更快、物理内存占用更低；关闭则一次性读进内存常驻。',
        estimate: '本机用 no-mmap 时权重常驻、生成速度稳定（22–23 t/s），且实测不会被换页拖慢。' },
      { key: 'parallel', type: 'slider', min: 1, max: 8, step: 1, unit: 'slots', label: '并发槽位 -np', restart: true,
        help: '同一时刻能处理几个请求。KV 显存按槽位翻倍。',
        estimate: '单用户保持 1 最省显存，本机 8 GB 推荐 1。' },
      { key: 'cacheRam', type: 'slider', min: 0, max: 32768, step: 512, unit: 'MiB', label: '提示缓存 --cache-ram', restart: true,
        help: '把历史提示词缓存在系统内存里，重复前缀不用重算，聊天时首字更快。',
        estimate: '本机设 4096 MiB；内存只有 16 GB，别设太大。' },
    ],
  },
  {
    group: 'sampling', title: '采样与输出', icon: 'sliders',
    items: [
      { key: 'reasoningEffort', type: 'select', options: [['none', 'none (关思考)'], ['medium', 'medium (推荐)'], ['xhigh', 'xhigh (默认档位)'], ['high', 'high (本构建会 500)']], label: '思考档位', restart: false,
        help: '控制思维链长度。模型默认 xhigh。',
        estimate: 'medium 在精度几乎不变的前提下省大量 token；low 不受支持（行为接近 xhigh）；传 high 会 HTTP 500。' },
      { key: 'maxTokens', type: 'slider', min: 128, max: 32768, step: 128, unit: 'tokens', label: '最大输出 max_tokens', restart: false,
        help: '思考内容也吃这个预算，给小了会看到「空答/截断」。',
        estimate: '官方建议 16384 起步配 65536 上下文。实测 scale 2 消融版经常顶到 2048，看长回答请给 4096+。' },
      { key: 'temperature', type: 'slider', min: 0, max: 2, step: 0.05, label: '温度 temperature', restart: false,
        help: '越高越发散。思考模式官方推荐 1.0，非思考 0.7。',
        estimate: '0 = 贪心，同问题答案逐字节可复现（A/B 对比用这个）。' },
      { key: 'topP', type: 'slider', min: 0, max: 1, step: 0.01, label: 'top_p', restart: false,
        help: '核采样。思考模式 0.95，非思考 0.80。', estimate: '对本机输出速度没有影响。' },
      { key: 'topK', type: 'slider', min: 0, max: 200, step: 1, label: 'top_k', restart: false,
        help: '官方推荐 20。', estimate: '1 = 只取最高概率 token（贪心）。' },
      { key: 'minP', type: 'slider', min: 0, max: 1, step: 0.01, label: 'min_p', restart: false,
        help: '按概率阈值截断。GGUF 不带这个参数，llama.cpp 默认 0.05 正好是官方推荐值。',
        estimate: '思考模式 0.05，非思考 0.0。' },
      { key: 'repeatPenalty', type: 'slider', min: 0, max: 2, step: 0.01, label: '重复惩罚', restart: false,
        help: '重复惩罚。思考模式官方要求 1.0（即不惩罚）。', estimate: '调高会明显伤害推理质量，保持 1.0。' },
      { key: 'seed', type: 'number', min: -1, max: 2147483647, label: '随机种子 seed', restart: false,
        help: '-1 = 每次随机；固定值可复现同一回答。', estimate: '做对比实验时固定。' },
      { key: 'systemPrompt', type: 'text', label: '系统提示词', restart: false,
        help: '官方建议一句 "You are a helpful assistant." 即可。',
        estimate: '写太长会占用上下文并可能干扰行为。' },
    ],
  },
  {
    group: 'vision', title: '识图与消融', icon: 'eye',
    items: [
      { key: 'vision', type: 'checkbox', label: '启用视觉（--mmproj 视觉塔）', restart: true,
        help: '不加这个参数时，网页界面和 API 都无法发送图片——这就是「它明明是多模态却发不了图」的原因。打开后加载 629 MB 的 mmproj。',
        estimate: '实测：VRAM 从 ~7.6 GB 升到 7.73–7.79 GB（上限 8.19 GB）；启动多约 3 秒。识图一次的预填充很贵（一张 1920x1200 图 = 4145 prompt token），但配合下面的大批大小可以从 98 秒缩到 76 秒。' },
      { key: 'imageMinTokens', type: 'slider', min: 64, max: 4096, step: 64, unit: 'tokens', label: '图片最小 token --image-min-tokens', restart: true,
        help: '官方建议 1024 用于 grounding / 小图。注意：大图不会因为它而变少——本机实测 1024 与 256 都得到 4145 token。',
        estimate: '实测 1024 与 256 的图片 token 数完全一样（4145），只有加载时会多打一条 accuracy 警告。小图/定位任务才需要调回 1024。' },
      { key: 'imageMaxEdge', type: 'slider', min: 512, max: 2560, step: 128, unit: 'px', label: '发图前缩放长边', restart: false,
        help: '在浏览器里先把图片缩小再上传（只影响发送的副本，原文件不动）。图片 token 数随边长平方增长，这是识图提速最有效的一招。',
        estimate: '一张 1920x1200 照片不缩放 = 4145 prompt token（本机 3–5 分钟）。缩到 1280 长边约省一半 token；缩到 896 再省一半。文字截图建议 1280，看细节的照片建议 1600+。' },
      { key: 'lora', type: 'select', optionsFrom: 'loras', label: '消融适配器 (LoRA)', restart: true,
        help: 'OrcaBonsai 的运行时行为消融，权重一个字节都不改。',
        estimate: '实测代价仅 3.6%–5.0% 生成速度、显存 +34 MiB。' },
      { key: 'loraScale', type: 'slider', min: 0, max: 3, step: 0.1, label: 'LoRA 强度 scale', restart: false,
        help: '运行时通过 /lora-adapters 热切换，不用重启。',
        estimate: '本机题集实测：scale 0/1 仍 7/7 拒绝，scale 2 才 7/7 照做（与作者 README 说的 scale 1 即可矛盾）。注意 --lora-scaled 在 Windows 路径下不可用，所以这里走运行时接口。' },
    ],
  },
];

const PRESETS = [
  {
    id: 'balanced', name: '均衡日常（推荐）', icon: 'scale',
    desc: '纯文本聊天，速度与显存都留有余量。',
    values: { ctx: 16384, flashAttn: 'on', cacheTypeK: 'f16', cacheTypeV: 'f16', mmap: false, batch: 2048, ubatch: 512, parallel: 1, vision: false, reasoningEffort: 'medium', maxTokens: 2048, temperature: 0.7 },
    estimate: '≈22–23 t/s 生成（实测 22.5–23.2），VRAM ≈ 7.6 GB。注意绝对速度会随会话漂移约 20%，只适合同一会话内比较。',
  },
  {
    id: 'fast', name: '极速优先', icon: 'zap',
    desc: '最短上下文 + 量化 KV，把显存全留给速度。',
    values: { ctx: 8192, flashAttn: 'on', cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', mmap: false, batch: 2048, ubatch: 256, parallel: 1, vision: false, reasoningEffort: 'none', maxTokens: 1024, temperature: 0.6 },
    estimate: '生成最高约 23 t/s；关思考后首个 token 明显更快，VRAM ≈ 7.0 GB。',
  },
  {
    id: 'longctx', name: '长上下文', icon: 'scroll',
    desc: '量化 KV 换更长上下文，适合读长文档。',
    values: { ctx: 32768, flashAttn: 'on', cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', mmap: false, batch: 2048, ubatch: 512, parallel: 1, vision: false, reasoningEffort: 'medium', maxTokens: 4096, temperature: 0.7 },
    estimate: '32k 上下文 + q8_0 KV ⇒ VRAM 仍 ≈ 7.6–7.9 GB，生成速度不变。',
  },
  {
    id: 'uncensored', name: '无审查模式（scale 2）', icon: 'unlock',
    desc: '挂上 OrcaBonsai 适配器并在应用后自动拧到 scale 2。',
    values: { lora: 'orcabonsai', loraScale: 2.0, ctx: 16384, flashAttn: 'on', vision: false, reasoningEffort: 'medium', maxTokens: 4096, temperature: 0.7 },
    estimate: '代价 3.6%–5.0% 速度、显存 +34 MiB；scale 1 在本机实测仍会拒绝。',
  },
  {
    id: 'vision', name: '识图模式', icon: 'eye',
    desc: '打开视觉塔 + 大批大小，网页里就能贴图，速度损失最小。',
    values: { vision: true, imageMinTokens: 1024, imageMaxEdge: 1280, ctx: 16384, flashAttn: 'on', cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', mmap: false, batch: 2048, ubatch: 512, parallel: 1, reasoningEffort: 'medium', maxTokens: 1024, temperature: 0.3 },
    estimate: '实测这套组合：VRAM 7.73 GB；纯文本 18.0 t/s。图片先用浏览器缩到 1280 长边再发，token 数随边长平方下降——这是把「等几分钟」压到「等十几秒」的关键。',
  },
];

/* ------------------------------------------------------------------ settings store */

function readSettings() {
  const merged = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined) merged[k] = raw[k];
  } catch { /* first run */ }
  return merged;
}

function writeSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
  return s;
}

/** Which fields differ between two settings objects, and do any force a restart? */
function diffSettings(a, b) {
  const softKeys = new Set(['loraScale', 'reasoningEffort', 'maxTokens', 'temperature', 'topP', 'topK', 'minP', 'repeatPenalty', 'seed', 'systemPrompt']);
  const changed = [];
  for (const k of Object.keys(DEFAULTS)) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
  }
  return { changed, needsRestart: changed.some((k) => !softKeys.has(k)) };
}

/* ------------------------------------------------------------------ llama-server */

const proc = { child: null, port: null, startedAt: null, logStream: null, lastError: null, ready: false, logPath: null };
const PID_FILE = path.join(LOG_DIR, 'engine.pid');

/* On Windows a child process survives its parent, so a hard-killed UI would leave
 * llama-server holding ~7.6 GB of VRAM. The pid file lets the next launch reclaim it. */
function killStaleEngine() {
  let pid = null;
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch { return null; }
  if (!pid || Number.isNaN(pid)) return null;
  return new Promise((resolve) => {
    // Only kill it if that pid really is a llama-server, never an unrelated process.
    execFile('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { timeout: 8000 }, (err, stdout) => {
      const isOurs = !err && /llama-server/i.test(stdout || '');
      if (!isOurs) { try { fs.unlinkSync(PID_FILE); } catch { /* noop */ } return resolve(null); }
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000 }, () => {
        try { fs.unlinkSync(PID_FILE); } catch { /* noop */ }
        console.log('[bonsai-app] reclaimed orphaned engine pid ' + pid + ' from a previous run');
        resolve(pid);
      });
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  try { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000 }, () => {}); } catch { /* noop */ }
}

function buildArgs(s) {
  const model = CATALOG.models.find((m) => m.id === s.model);
  if (!model) throw new Error('unknown model: ' + s.model);
  if (!fs.existsSync(model.file)) throw new Error('model file missing: ' + model.file);

  const args = ['-m', model.file, '-ngl', String(s.ngl), '-c', String(s.ctx),
    '-fa', String(s.flashAttn), '-b', String(s.batch), '-ub', String(s.ubatch),
    '-np', String(s.parallel), '--host', '127.0.0.1', '--port', String(s.port),
    '--reasoning-effort', String(s.reasoningEffort)];

  // -ctk/-ctv only make sense with flash attention on.
  if (s.flashAttn !== 'off') {
    args.push('-ctk', String(s.cacheTypeK), '-ctv', String(s.cacheTypeV));
  }
  if (!s.mmap) args.push('--no-mmap');
  if (s.cacheRam > 0) args.push('--cache-ram', String(s.cacheRam));
  if (s.threads > 0) args.push('-t', String(s.threads));

  if (s.vision) {
    if (!model.mmproj || !fs.existsSync(model.mmproj)) throw new Error('mmproj file missing: ' + model.mmproj);
    args.push('--mmproj', model.mmproj, '--image-min-tokens', String(s.imageMinTokens));
  }

  const lora = CATALOG.loras.find((l) => l.id === s.lora);
  if (lora && lora.file) {
    if (!fs.existsSync(lora.file)) throw new Error('adapter file missing: ' + lora.file);
    // --lora-scaled cannot parse a Windows path (it splits on the last colon and finds
    // the drive letter), so a non-1 scale means: load unapplied, then POST the scale.
    if (Number(s.loraScale) !== 1) args.push('--lora-init-without-apply');
    args.push('--lora', lora.file);
  }
  return args;
}

function startServer(settings) {
  stopServer();
  const args = buildArgs(settings);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(LOG_DIR, 'llama-server-' + stamp + '.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write('# ' + path.join(BIN_DIR, 'llama-server.exe') + ' ' + args.join(' ') + '\n');

  const child = spawn(path.join(BIN_DIR, 'llama-server.exe'), args, {
    cwd: BIN_DIR,
    windowsHide: true,
    // The cudart DLLs live next to the exe; without this the spawn fails silently.
    env: { ...process.env, PATH: BIN_DIR + ';' + process.env.PATH },
  });
  proc.child = child;
  proc.port = settings.port;
  proc.startedAt = Date.now();
  proc.ready = false;
  proc.lastError = null;
  proc.logStream = logStream;
  proc.logPath = logPath;

  // llama-server logs to stderr; both go to the same file.
  child.stdout.on('data', (d) => logStream.write(d));
  child.stderr.on('data', (d) => logStream.write(d));
  child.on('exit', (code) => {
    logStream.write('# exited with code ' + code + '\n');
    logStream.end();
    if (proc.child === child) { proc.child = null; proc.ready = false; }
  });
  child.on('error', (err) => { proc.lastError = String(err.message); });
  try { fs.writeFileSync(PID_FILE, String(child.pid), 'utf8'); } catch { /* best effort */ }

  // A non-1 LoRA scale is applied through the runtime endpoint, so it has to wait for
  // the engine to come up. Without this, a scale != 1 saved in settings.json would be
  // silently dropped every time the app restarts (the adapter loads "without apply").
  void (async () => {
    const ok = await waitReady(settings.port, 120000);
    if (!ok || proc.child !== child) return;
    proc.ready = true;
    if (settings.lora !== 'none' && Number(settings.loraScale) !== 1) {
      try {
        const out = await setLoraScale(settings.port, settings.loraScale);
        logStream.write('# applied lora scale ' + settings.loraScale + ' -> ' + out.body + '\n');
      } catch (e) { logStream.write('# lora scale apply failed: ' + e.message + '\n'); }
    }
  })();
  return { pid: child.pid, args, logPath };
}

async function waitReady(port, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await health(port)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function stopServer() {
  if (proc.child) {
    const pid = proc.child.pid;
    try { proc.child.kill(); } catch { /* already gone */ }
    // The engine spawns no grandchildren today, but /T guarantees the whole tree dies
    // (a half-killed engine is what leaks VRAM and wedges the next launch).
    killTree(pid);
    if (proc.logStream) { try { proc.logStream.end(); } catch { /* noop */ } }
    proc.child = null;
    proc.ready = false;
    try { fs.unlinkSync(PID_FILE); } catch { /* noop */ }
  }
}

function tailLog(lines = 80) {
  if (!proc.logPath || !fs.existsSync(proc.logPath)) return [];
  const all = fs.readFileSync(proc.logPath, 'utf8').split(/\r?\n/);
  return all.slice(-lines);
}

async function health(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    return j.status === 'ok';
  } catch { return false; }
}

function gpuStats() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu,clocks.current.sm', '--format=csv,noheader,nounits'],
      { timeout: 8000 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const p = stdout.trim().split(',').map((x) => Number(x.trim()));
        resolve({ usedMiB: p[0], totalMiB: p[1], util: p[2], tempC: p[3], smClock: p[4] });
      });
  });
}

/** Set the LoRA scale at runtime. The GET shape is not stable (bare object vs {value:[]}),
 *  and a one-element array collapses in some clients, so build the POST body by hand. */
async function setLoraScale(port, scale) {
  const g = await fetch('http://127.0.0.1:' + port + '/lora-adapters', { signal: AbortSignal.timeout(10000) });
  const j = await g.json();
  const first = Array.isArray(j) ? j[0] : (j.value ? j.value[0] : j);
  const id = Number(first.id);
  const body = '[{"id":' + id + ',"scale":' + Number(scale) + '}]';
  const r = await fetch('http://127.0.0.1:' + port + '/lora-adapters', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
    signal: AbortSignal.timeout(20000),
  });
  return { ok: r.ok, body: await r.text(), adapterId: id };
}

/* ------------------------------------------------------------------ http plumbing */

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    if (p === '/api/state') {
      const s = readSettings();
      const gpu = await gpuStats();
      const up = proc.child ? await health(proc.port) : false;
      if (up && !proc.ready) proc.ready = true;
      let loraAdapters = null;
      if (up && s.lora !== 'none') {
        try {
          const r = await fetch('http://127.0.0.1:' + proc.port + '/lora-adapters', { signal: AbortSignal.timeout(5000) });
          loraAdapters = await r.json();
        } catch { /* optional */ }
      }
      return sendJson(res, 200, {
        settings: s, schema: SCHEMA, presets: PRESETS, catalog: CATALOG,
        server: { running: !!proc.child, ready: up, pid: proc.child ? proc.child.pid : null, port: proc.port, startedAt: proc.startedAt, lastError: proc.lastError, logPath: proc.logPath },
        gpu, loraAdapters,
      });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const incoming = JSON.parse((await readBody(req)).toString('utf8'));
      const current = readSettings();
      const next = { ...current };
      for (const [k, v] of Object.entries(incoming)) if (k in DEFAULTS) next[k] = v;
      const d = diffSettings(current, next);
      writeSettings(next);
      let restarted = false, lora = null, error = null;
      try {
        if (d.needsRestart) { startServer(next); restarted = true; }
        else if (d.changed.includes('loraScale') && proc.child && next.lora !== 'none') {
          // wait for readiness, then apply the scale
          for (let i = 0; i < 20; i++) { if (await health(next.port)) break; await new Promise((r) => setTimeout(r, 1000)); }
          lora = await setLoraScale(next.port, next.loraScale);
        }
      } catch (e) { error = String(e.message || e); }
      return sendJson(res, 200, { ok: !error, changed: d.changed, needsRestart: d.needsRestart, restarted, lora, error, settings: next });
    }

    if (p === '/api/preset' && req.method === 'POST') {
      const { id } = JSON.parse((await readBody(req)).toString('utf8'));
      const preset = PRESETS.find((x) => x.id === id);
      if (!preset) return sendJson(res, 404, { ok: false, error: 'unknown preset' });
      const current = readSettings();
      const next = { ...current, ...preset.values };
      const d = diffSettings(current, next);
      writeSettings(next);
      let restarted = false, lora = null, error = null;
      try {
        if (d.needsRestart) { startServer(next); restarted = true; }
        if (Number(next.loraScale) !== 1 && next.lora !== 'none') {
          for (let i = 0; i < 60; i++) { if (await health(next.port)) break; await new Promise((r) => setTimeout(r, 1000)); }
          lora = await setLoraScale(next.port, next.loraScale);
        }
      } catch (e) { error = String(e.message || e); }
      return sendJson(res, 200, { ok: !error, preset: preset.id, changed: d.changed, needsRestart: d.needsRestart, restarted, lora, error, settings: next });
    }

    if (p === '/api/apply-lora' && req.method === 'POST') {
      const { scale } = JSON.parse((await readBody(req)).toString('utf8'));
      const s = readSettings();
      const next = writeSettings({ ...s, loraScale: Number(scale) });
      try {
        const out = await setLoraScale(proc.port || s.port, Number(scale));
        return sendJson(res, 200, { ok: out.ok, out, settings: next });
      } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
    }

    if (p === '/api/server' && req.method === 'POST') {
      const { action } = JSON.parse((await readBody(req)).toString('utf8'));
      const s = readSettings();
      if (action === 'stop') { stopServer(); return sendJson(res, 200, { ok: true, running: false }); }
      if (action === 'start' || action === 'restart') {
        try {
          const info = startServer(s);
          return sendJson(res, 200, { ok: true, running: true, ...info });
        } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }
      }
      return sendJson(res, 400, { ok: false, error: 'unknown action' });
    }

    if (p === '/api/log') {
      return sendJson(res, 200, { lines: tailLog(Number(url.searchParams.get('lines')) || 100), path: proc.logPath });
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const s = readSettings();
      const port = proc.port || s.port;
      const payload = {
        messages: [{ role: 'system', content: s.systemPrompt }, ...(body.messages || [])],
        max_tokens: s.maxTokens, temperature: s.temperature, top_p: s.topP, top_k: s.topK,
        min_p: s.minP, repeat_penalty: s.repeatPenalty, stream: true,
      };
      if (Number(s.seed) >= 0) payload.seed = Number(s.seed);
      // reasoning_effort is a per-request field (the same one the ab-test scripts used):
      // the startup --reasoning-effort is only a default, so a soft change to this setting
      // would otherwise look applied in the UI while doing nothing.
      if (s.reasoningEffort === 'none') payload.chat_template_kwargs = { enable_thinking: false };
      else payload.reasoning_effort = String(s.reasoningEffort);

      const upstream = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!upstream.ok) {
        const text = await upstream.text();
        return sendJson(res, upstream.status, { error: text });
      }
      // Stream straight through; the browser parses SSE.
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
      return;
    }

    return serveStatic(req, res, p);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

const APP_PORT = Number(process.env.BONSAI_APP_PORT || 8788);
server.listen(APP_PORT, '127.0.0.1', async () => {
  const s = readSettings();
  console.log('[bonsai-app] UI on http://127.0.0.1:' + APP_PORT + '/');
  console.log('[bonsai-app] llama-server will bind port ' + s.port);
  await killStaleEngine();
  console.log('[bonsai-app] starting engine...');
  try { const info = startServer(s); console.log('[bonsai-app] engine pid ' + info.pid + ' args: ' + info.args.join(' ')); }
  catch (e) { console.log('[bonsai-app] engine start FAILED: ' + e.message); }
});

function shutdown() {
  console.log('[bonsai-app] shutting down, stopping engine');
  stopServer();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('uncaughtException', (e) => { console.log('[bonsai-app] uncaught: ' + e.message); });
