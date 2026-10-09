/**
 * Bonsai Studio desktop launcher.
 *
 * Starts the UI server (which in turn owns llama-server), then opens the UI in a
 * chrome-less Chromium app window so it behaves like a native desktop app. When the
 * window closes, the engine is stopped and this process exits.
 *
 * ASCII only -- see the notes in server.js.
 *
 * Usage:  node launch.js            (normal)
 *         node launch.js --browser  (print which browser would be used, then exit)
 */

const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const APP_PORT = Number(process.env.BONSAI_APP_PORT || 8788);
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

// Requiring server.js starts the HTTP listener and the engine child process.
require(path.join(__dirname, 'server.js'));

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
  const up = await waitForUi();
  if (!up) {
    console.log('[bonsai-app] UI never became ready; aborting');
    process.exit(1);
  }
  console.log('[bonsai-app] UI ready, opening app window');

  const browser = findBrowser();
  if (!browser) {
    // No Chromium browser: fall back to the default handler so the user still gets a window.
    console.log('[bonsai-app] no Chromium browser found, opening in the default browser');
    try { execFileSync('cmd', ['/c', 'start', '', URL], { windowsHide: true }); } catch { /* noop */ }
    return;
  }

  const profileDir = path.join(process.env.LOCALAPPDATA || __dirname, 'BonsaiStudio', 'browser-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    '--app=' + URL,
    '--user-data-dir=' + profileDir,
    '--window-size=1400,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-background-networking',
  ];

  const child = spawn(browser, args, { windowsHide: false, detached: false });
  console.log('[bonsai-app] window pid ' + child.pid + ' via ' + path.basename(browser));

  child.on('exit', () => {
    console.log('[bonsai-app] window closed, shutting down');
    process.kill(process.pid, 'SIGTERM');
  });
  child.on('error', (e) => console.log('[bonsai-app] browser spawn failed: ' + e.message));
}

void main();
