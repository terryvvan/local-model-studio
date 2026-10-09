/**
 * Local Model Studio -- desktop launcher.
 *
 * Starts the unified backend (which in turn owns llama-server, the Python image
 * bridge and ComfyUI), then opens the UI in a chrome-less Chromium app window so
 * it behaves like a native desktop program. When that window closes, the whole
 * stack is torn down and this process exits.
 *
 * ASCII only -- see the notes in server.js.
 *
 * Usage:  node launch.js            (normal)
 *         node launch.js --browser  (print which browser would be used, then exit)
 */

const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let APP_PORT = 8890;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  if (cfg.appPort) APP_PORT = Number(cfg.appPort);
} catch { /* config.json missing: fall back to the default port */ }
APP_PORT = Number(process.env.LOCALMODEL_APP_PORT || APP_PORT);
const URL = 'http://127.0.0.1:' + APP_PORT + '/';

/* Candidate Chromium browsers, best first. A chrome-less "--app" window is what makes
 * this feel like a desktop program instead of a browser tab. */
const BROWSERS = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

function findBrowser() {
  return BROWSERS.find((p) => p && fs.existsSync(p)) || null;
}

if (process.argv.includes('--browser')) {
  console.log('browser: ' + (findBrowser() || 'NONE FOUND'));
  console.log('url: ' + URL);
  process.exit(0);
}

/* ---------------------------------------------------------------- 1. UI server */

/* Probe BEFORE requiring server.js. Requiring it starts the HTTP listener, and a
 * second listener on the same port would die with EADDRINUSE -- leaving a window
 * pointing at a dead backend. If an instance is already serving the port, attach to
 * it instead: the user just gets another window onto the running app. */
async function existingInstance() {
  try {
    const r = await fetch(URL + 'api/state', { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.app && j.app.root) ? j.app : null;
  } catch { return null; }
}

/* ---------------------------------------------------------------- 2. app window */

async function waitForUi(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(URL, { signal: AbortSignal.timeout(2500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const existing = await existingInstance();
  let weOwnTheServer = false;
  let srv = null;
  if (existing) {
    console.log('[local-model] already running (root ' + existing.root + '), attaching to it');
  } else {
    // Engines are started lazily by the arbiter on first use, so requiring server.js
    // loads nothing heavy just to show the window.
    srv = require(path.join(__dirname, 'server.js'));
    weOwnTheServer = true;
  }

  const up = await waitForUi();
  if (!up) {
    console.log('[local-model] UI never became ready; aborting');
    process.exit(1);
  }
  console.log('[local-model] UI ready, opening app window');

  const browser = findBrowser();
  if (!browser) {
    // No Chromium browser: fall back to the default handler so the user still gets a window.
    console.log('[local-model] no Chromium browser found, opening in the default browser');
    try { execFileSync('cmd', ['/c', 'start', '', URL], { windowsHide: true }); } catch { /* noop */ }
    return;
  }

  const profileDir = path.join(process.env.LOCALAPPDATA || __dirname, 'LocalModelStudio', 'browser-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    '--app=' + URL,
    '--user-data-dir=' + profileDir,
    '--window-size=1440,920',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-background-networking',
  ];

  const child = spawn(browser, args, { windowsHide: false, detached: false });
  console.log('[local-model] window pid ' + child.pid + ' via ' + path.basename(browser));

  child.on('exit', async () => {
    console.log('[local-model] window closed, shutting down');
    // Only tear down a stack this process actually started. When we merely attached to
    // a running instance, its own window keeps owning the engines.
    if (!weOwnTheServer) return process.exit(0);
    // Do NOT use process.kill(process.pid, 'SIGTERM') here: on Windows that is a bare
    // TerminateProcess, no JS handler runs, and llama-server / ComfyUI would be left
    // orphaned holding ~6 GB of VRAM and their ports.
    const hardExit = setTimeout(() => {
      console.log('[local-model] shutdown timed out, exiting anyway');
      process.exit(0);
    }, 20000);
    try {
      if (srv && typeof srv.shutdown === 'function') await srv.shutdown('window-closed');
    } catch (e) {
      console.log('[local-model] shutdown error: ' + (e && e.message));
    }
    clearTimeout(hardExit);
    process.exit(0);
  });
  child.on('error', (e) => console.log('[local-model] browser spawn failed: ' + e.message));
}

void main();
