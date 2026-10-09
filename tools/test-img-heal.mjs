/* test-img-heal.mjs —— 生图「卡死的忙碌态」自愈逻辑离线回归测试
 *
 * 目的：把 app/ui/index.html 里的真实前端脚本抽出来，在 stub DOM 里跑，验证
 *       imgPoll() 的自愈分支在下面三种情况下确实会把按钮交回给用户：
 *         1) 提交那一次 fetch 永远不返回（后端重启/连接被判死）+ 后端状态为空闲
 *         2) 后端说 running，但 elapsed 彻底不动
 *         3) 后端说 done  ——  正常路径不能被自愈逻辑误伤
 *
 * 用法：  node tools/test-img-heal.mjs
 * 说明：  不联网、不起浏览器、不碰后端与用户数据（fetch 全部走 stub）。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'app', 'ui', 'index.html'), 'utf8');

/* ------------------------------------------------ 抽取 index.html 里的内联脚本 */
const m = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
if (!m.length) throw new Error('index.html 里没找到内联 <script>');
const src = m[m.length - 1][1];

/* ------------------------------------------------ stub DOM / fetch / 定时器 */
function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
    style: {}, dataset: {}, files: [], children: [],
    _h: {},
    addEventListener(k, fn) { (this._h[k] = this._h[k] || []).push(fn); },
    removeEventListener() {},
    querySelector() { return makeEl(id + ' >q'); },
    querySelectorAll() { return []; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {}, focus() {}, blur() {}, click() {}, select() {},
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    closest() { return null; }, contains() { return false; },
    scrollIntoView() {}, scrollTo() {}, setSelectionRange() {},
    getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 300, height: 100 }; },
  };
  /* classList 用最小实现即可（脚本里只用来开关样式） */
  el.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  return el;
}
const EL_CACHE = new Map();
function el(sel) {
  const k = String(sel);
  if (!EL_CACHE.has(k)) EL_CACHE.set(k, makeEl(k.replace(/^#/, '')));
  return EL_CACHE.get(k);
}
const doc = {
  readyState: 'complete',
  activeElement: null,
  documentElement: makeEl('html'),
  head: makeEl('head'),
  body: makeEl('body'),
  createElement: (t) => makeEl('<' + t + '>'),
  createTextNode: (s) => ({ textContent: String(s) }),
  getElementById: (id) => el('#' + id),
  querySelector: (s) => el(s),
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  execCommand() {}, exitFullscreen() {},
};
const win = {
  document: doc,
  __DSH_BOOT__: {},
  innerWidth: 1440, innerHeight: 900,
  devicePixelRatio: 1,
  location: { href: 'http://127.0.0.1:8890/', origin: 'http://127.0.0.1:8890', search: '', hash: '' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (fn) => { fn(0); return 1; }, cancelAnimationFrame() {},
  alert() {}, confirm: () => false, prompt: () => null, open() {},
  Notification: function () {}, navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
  history: { replaceState() {}, pushState() {} },
  scrollTo() {},
};
win.window = win; win.self = win; win.top = win; win.parent = win; win.globalThis = win;

const timers = new Map();
let TID = 1;
const fakeSetInterval = (fn, ms) => { const id = TID++; timers.set(id, fn); return id; };
const fakeClearInterval = (id) => { timers.delete(id); };
const fakeSetTimeout = (fn, ms) => { const id = TID++; timers.set(id, fn); return id; };
const fakeClearTimeout = (id) => { timers.delete(id); };
async function tick(times = 1, ms = 1500) {
  for (let i = 0; i < times; i++) {
    const snap = [...timers.values()];
    for (const fn of snap) { try { await fn(); } catch (_) {} }
    await new Promise((r) => setTimeout(r, ms));   // 让 await 链落定（真实时钟，毫秒级）
  }
}

/* ------------------------------------------------ fetch stub：由测试用例改写 */
let fetchPlan = { status: async () => ({ alive: true, job: null }), generate: null };
const calls = [];
async function stubFetch(url, opt = {}) {
  url = String(url);
  calls.push((opt.method || 'GET') + ' ' + url);
  if (url.includes('/api/image/status')) return { json: async () => fetchPlan.status() };
  if (url.includes('/api/image/generate')) {
    if (fetchPlan.generate) return fetchPlan.generate();
    return { json: async () => ({ ok: true, job: { state: 'done', images: [] } }) };
  }
  /* 其余端点（history / bootstrap / state / settings…）一律给空壳，别让 boot 抛错 */
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
}

/* 用普通对象当 global：vm 会自己补上所有内建（Map/Promise/Date…），
 * 所以这里只补浏览器专有的那些名字。注意 window 必须指回这个 global 对象本身。 */
const ctx = {};
Object.assign(ctx, win, {
  window: ctx, self: ctx, globalThis: ctx,
  document: doc, console,
  fetch: stubFetch, Headers: class {}, Request: class {}, Response: class {},
  setInterval: fakeSetInterval, clearInterval: fakeClearInterval,
  setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  performance: { now: () => Date.now() },
  AbortSignal: { timeout: () => ({}) },
  URL, URLSearchParams, TextEncoder, TextDecoder, Blob: class {}, File: class {}, FormData: class {},
  Event: class {}, CustomEvent: class {}, IntersectionObserver: class { observe() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame() {},
});
vm.createContext(ctx);

/* ------------------------------------------------ 跑真实脚本（语法错误会在这里炸） */
const API = vm.runInContext(
  '"use strict";\n' + src + '\n;({ IMG, imgPoll, imgGenerate, setImgBusy, setGenStatus, __status: () => GENSTATUS });',
  ctx, { filename: 'index.html:inline' });
await new Promise((r) => setTimeout(r, 120));

const { IMG, imgPoll, setImgBusy } = API;

/* ------------------------------------------------ 断言小工具 */
let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log('  ✔ ' + label); }
  else { fail++; console.log('  ✘ ' + label + (extra ? '  → ' + extra : '')); }
}
function resetBusy() {
  for (const k of [...timers.keys()]) timers.delete(k);
  IMG.busy = true;
  IMG.timer = fakeSetInterval(imgPoll, 1500);
  IMG.heal = { idle: 0, lost: false, stall: 0, lastElapsed: -1, sawDone: false };
  IMG.t0 = performance.now();
  IMG.job = { state: 'running', step: 0, total_steps: 8, images: [] };
}

/* ================================================ 用例 1：提交丢了 + 后端空闲 */
console.log('\n[1] 提交那一次 fetch 永远不返回，后端状态一直是空闲');
fetchPlan = {
  generate: () => new Promise(() => {}),                  // 永不 resolve：模拟连接被判死
  status: async () => ({ alive: true, job: null }),       // 后端：没有任务（空闲）
};
resetBusy();
IMG.heal.lost = true;                                     // imgGenerate 的 catch 分支会置这个
await tick(3);
ok(IMG.busy === false, '自愈后按钮交回用户（IMG.busy === false）', 'IMG.busy=' + IMG.busy);
ok(IMG.timer === null, '轮询定时器已停（IMG.timer === null）', String(IMG.timer));
ok(IMG.heal.idle === 0, 'idle 计数已清零', 'idle=' + IMG.heal.idle);

/* ================================================ 用例 2：内核在跑但进度不动 */
console.log('\n[2] 后端说 running，但 elapsed 45 秒没动');
const frozen = { alive: true, job: { state: 'running', elapsed: 12.5, started: Date.now() / 1000, step: 0, total_steps: 8, images: [] } };
fetchPlan = { status: async () => JSON.parse(JSON.stringify(frozen)), generate: null };
resetBusy();
await tick(5);
ok(IMG.busy === false, '连续 4 次采样没进度后按钮交回', 'IMG.busy=' + IMG.busy + ' stall=' + IMG.heal.stall);
ok(IMG.timer === null, '轮询定时器已停', String(IMG.timer));

/* ================================================ 用例 3：正常出图（自愈不能误伤） */
console.log('\n[3] 正常 done：不能被自愈逻辑误判成掉线');
let n = 0;
fetchPlan = {
  generate: async () => ({ json: async () => ({ ok: true, job: { state: 'done', elapsed: 21.4, images: [{ w: 1024, h: 1024, size: 1500000, url: '/img/x.png' }] } }) }),
  status: async () => ({
    alive: true,
    job: (++n < 3)
      ? { state: 'running', elapsed: 3 + n, started: Date.now() / 1000, step: n, total_steps: 8, images: [] }
      : { state: 'done', elapsed: 21.4, step: 8, total_steps: 8, images: [{ w: 1024, h: 1024, size: 1500000, url: '/img/x.png' }] },
  }),
};
resetBusy();
await tick(3);
ok(IMG.busy === false, 'done 之后按钮恢复', 'IMG.busy=' + IMG.busy);
ok((IMG.job.images || []).length === 1, '结果图已进入 IMG.job.images', JSON.stringify((IMG.job.images || []).length));
ok(IMG.heal.idle === 0 && IMG.heal.stall === 0, '正常路径没有触发自愈计数', JSON.stringify(IMG.heal));

/* ================================================ 用例 4：error 也要解锁 */
console.log('\n[4] 后端 error：必须解锁并显示失败原因');
fetchPlan = { generate: null, status: async () => ({ alive: true, job: { state: 'error', error: '显存不足', elapsed: 5, images: [] } }) };
resetBusy();
await tick(2);
ok(IMG.busy === false, 'error 之后按钮恢复', 'IMG.busy=' + IMG.busy);
ok(IMG.timer === null, '轮询定时器已停', String(IMG.timer));

/* ================================================ 用例 5：内核没起来时不能解锁 */
console.log('\n[5] alive=false（内核还在启动）：应当继续等，不能把按钮交回去');
fetchPlan = { generate: null, status: async () => ({ alive: false }) };
resetBusy();
await tick(3);
ok(IMG.busy === true, '内核启动中仍然保持忙碌（避免用户空按）', 'IMG.busy=' + IMG.busy);

console.log('\n============================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('watch 到的请求：' + (calls.length ? calls.slice(0, 4).join(' | ') + (calls.length > 4 ? ' …' : '') : '（无）'));
process.exit(fail ? 1 : 0);
