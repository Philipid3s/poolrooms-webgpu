/**
 * Headless smoke check: serve the production build, load the page with
 * ?renderer=webgl, assert no page errors, and write smoke.png.
 *
 * Not a project dependency. Uses Playwright from the environment
 * (npx cache / a global install) and the system Chrome if present.
 *
 * Usage (from the repo root, after `npm run build`):
 *   node scripts/smoke.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = path.join(root, 'dist', 'index.html');
const screenshotPath = path.join(root, 'smoke.png');
const previewPort = Number(process.env.SMOKE_PORT || 4173);
const previewUrl = `http://127.0.0.1:${previewPort}/?renderer=webgl&seed=42`;

await access(distIndex).catch(() => {
  console.error('dist/ is missing. Run `npm run build` first.');
  process.exit(1);
});

const playwright = await loadPlaywright();
const server = await startPreview(previewPort);

const errors = [];
const pageErrors = [];
const failedRequests = [];
let browser;

try {
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
    ],
  };
  if (await exists('/usr/bin/google-chrome')) {
    launchOptions.executablePath = '/usr/bin/google-chrome';
  }

  browser = await playwright.chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (isIgnorableAsset(url)) return;
    failedRequests.push(`${url} ${req.failure()?.errorText || ''}`.trim());
  });

  const response = await page.goto(previewUrl, { waitUntil: 'networkidle', timeout: 30000 });
  if (!response || !response.ok()) {
    throw new Error(`Page load failed: ${response && response.status()}`);
  }

  await page.waitForTimeout(2000);

  // Hide the click-to-enter gate so the screenshot shows the 3D scene.
  await page.evaluate(() => {
    document.getElementById('blocker')?.classList.add('hidden');
  });

  const status = await page.evaluate(() => {
    const overlay = document.getElementById('overlay')?.textContent || '';
    const canvas = document.querySelector('canvas');
    return {
      overlay,
      hasCanvas: Boolean(canvas),
      canvasWidth: canvas ? canvas.width : 0,
      canvasHeight: canvas ? canvas.height : 0,
    };
  });

  await page.screenshot({ path: screenshotPath, fullPage: true });

  const relevantConsole = errors.filter((text) => !isIgnorableConsole(text));
  const problems = [];
  if (pageErrors.length) problems.push(`pageerror: ${pageErrors.join(' | ')}`);
  if (relevantConsole.length) problems.push(`console.error: ${relevantConsole.join(' | ')}`);
  if (failedRequests.length) problems.push(`requestfailed: ${failedRequests.join(' | ')}`);
  if (!status.hasCanvas) problems.push('no canvas element');
  if (status.canvasWidth < 64 || status.canvasHeight < 64) {
    problems.push(`canvas too small: ${status.canvasWidth}x${status.canvasHeight}`);
  }
  if (!/Renderer:\s*WebGL/i.test(status.overlay)) {
    problems.push(`overlay did not report WebGL:\n${status.overlay}`);
  }
  if (/Failed to start/i.test(status.overlay)) {
    problems.push(`overlay reports failure:\n${status.overlay}`);
  }

  console.log('URL:', previewUrl);
  console.log('Overlay:\n' + status.overlay);
  console.log('Canvas:', status.canvasWidth, 'x', status.canvasHeight);
  console.log('Screenshot:', screenshotPath);

  if (problems.length) {
    console.error('SMOKE FAILED:\n- ' + problems.join('\n- '));
    process.exitCode = 1;
  } else {
    console.log('SMOKE PASSED');
  }
} finally {
  if (browser) {
    await Promise.race([
      browser.close(),
      sleep(5000),
    ]).catch(() => {});
  }
  await stopPreview(server, previewPort);
}

function isIgnorableAsset(url) {
  return /favicon\.ico(\?|$)/i.test(url) || /apple-touch-icon/i.test(url);
}

function isIgnorableConsole(text) {
  return /favicon\.ico/i.test(text) || /apple-touch-icon/i.test(text);
}

async function loadPlaywright() {
  const candidates = ['playwright', 'playwright-core'];
  for (const name of candidates) {
    try {
      return await import(name);
    } catch {
      // try the next candidate
    }
  }

  const roots = [];
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim());
  } catch {
    // ignore
  }
  roots.push(path.join(process.env.HOME || '', '.npm/_npx'));

  for (const dir of roots) {
    const found = await findPackage(dir, 'playwright');
    if (found) {
      return await import(pathToFileURL(path.join(found, 'index.js')).href);
    }
  }

  console.error('Could not load Playwright. Install it globally or run via npx.');
  process.exit(1);
}

async function findPackage(start, name) {
  try {
    const direct = path.join(start, name);
    await access(path.join(direct, 'index.js'));
    return direct;
  } catch {
    // walk one or two levels for the npx cache layout
  }
  try {
    const entries = await readdir(start, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(start, entry.name, 'node_modules', name);
      try {
        await access(path.join(candidate, 'index.js'));
        return candidate;
      } catch {
        // keep looking
      }
    }
  } catch {
    return null;
  }
  return null;
}

function startPreview(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none' },
      detached: true,
    });
    let settled = false;
    const onData = (buf) => {
      const text = buf.toString();
      if (/Local:|localhost|127\.0\.0\.1/.test(text) && !settled) {
        settled = true;
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`vite preview exited early with code ${code}`));
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(child);
      }
    }, 4000);
  });
}

async function stopPreview(child, port) {
  if (child && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }
  await sleep(400);
  try {
    execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
  } catch {
    // nothing bound
  }
  await sleep(200);
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
