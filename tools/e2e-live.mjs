// End-to-end smoke for Local Model Studio: chat (SSE) + one real image generation.
// usage: node e2e-live.mjs [base] [--chat-only|--image-only]
const BASE = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'http://127.0.0.1:8891';
const only = process.argv.includes('--chat-only') ? 'chat' : process.argv.includes('--image-only') ? 'image' : 'both';
const t0 = Date.now();
const ms = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const log = (...a) => console.log('[' + ms() + ']', ...a);

async function jget(p, opt) {
  const r = await fetch(BASE + p, opt);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, json: j, text: t };
}

async function chat() {
  log('--- CHAT ---');
  const body = { messages: [{ role: 'user', content: '用一句话回答：2+3等于几？' }], search: false, tools: false };
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status !== 200) { log('CHAT HTTP ' + res.status); return { ok: false }; }
  let buf = '', text = '', err = null, done = false; const types = {};
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const s = line.slice(5).trim(); if (!s) continue;
        let o = null; try { o = JSON.parse(s); } catch (_) { continue; }
        types[o.type] = (types[o.type] || 0) + 1;
        if (o.type === 'delta') text += o.text || '';
        if (o.type === 'error') err = o.error;
        if (o.type === 'done') done = true;
      }
    }
  }
  log('CHAT done=' + done + ' err=' + (err || 'none') + ' textLen=' + text.length);
  log('CHAT types=' + JSON.stringify(types));
  log('CHAT text=' + JSON.stringify(text.slice(0, 240)));
  return { ok: done && !err && text.length > 0, text, types, err };
}

async function image() {
  log('--- IMAGE ---');
  const params = { prompt: 'a small red apple on a wooden table, soft daylight, photo', width: 1024, height: 1024, steps: 8, seed: 20261008 };
  const r = await jget('/api/generate-image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params }) });
  log('IMAGE http=' + r.status);
  if (!r.json) { log('IMAGE raw=' + r.text.slice(0, 300)); return { ok: false }; }
  const jb = r.json.job || {};
  log('IMAGE ok=' + r.json.ok + ' state=' + jb.state + ' images=' + JSON.stringify(jb.images || []));
  if (r.json.error) log('IMAGE error=' + r.json.error);
  return { ok: r.json.ok === true && jb.state === 'done', images: jb.images || [] };
}

log('base=' + BASE + ' only=' + only);
const st = await jget('/api/state');
const models = st.json && st.json.chat && st.json.chat.catalog ? st.json.chat.catalog.models.length : '?';
const presets = st.json && st.json.chat ? (st.json.chat.presets || []).length : '?';
log('STATE http=' + st.status + ' models=' + models + ' presets=' + presets);
const out = {};
if (only !== 'image') out.chat = await chat();
if (only !== 'chat') out.image = await image();
log('RESULT ' + JSON.stringify({ chat: out.chat && out.chat.ok, image: out.image && out.image.ok, images: out.image && out.image.images }));
