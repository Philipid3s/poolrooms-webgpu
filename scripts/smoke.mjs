/**
 * Headless smoke check: serve the production build, load the page with
 * ?renderer=webgl, assert no page errors, and write smoke.png.
 *
 * Not a project dependency. Uses Playwright from the environment
 * (npx cache / a global install) and the system Chrome if present.
 *
 * Works on Linux, macOS and Windows.
 *
 * Usage (from the repo root, after `npm run build`):
 *   npm run smoke        (or: node scripts/smoke.mjs)
 */
import path from 'node:path';
import {
  root, requireDist, loadPlaywright, findSystemChrome, startPreview, stopPreview, sleep,
} from './lib.mjs';

const screenshotPath = path.join(root, 'smoke.png');
const previewPort = Number(process.env.SMOKE_PORT || 4173);
const previewUrl = `http://127.0.0.1:${previewPort}/?renderer=webgl&seed=42`;

await requireDist();

const playwright = await loadPlaywright();
const maxAttempts = Math.max(1, Number(process.env.SMOKE_ATTEMPTS || 2));
const navTimeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 60000);

let passed = false;
for (let attempt = 1; attempt <= maxAttempts && !passed; attempt += 1) {
  if (attempt > 1) console.error(`Smoke attempt ${attempt - 1} failed, retrying (${attempt}/${maxAttempts})...`);
  passed = await runSmoke();
}
if (!passed) process.exitCode = 1;

async function runSmoke() {
  let ok = false;
  let server;

  const errors = [];
  const pageErrors = [];
  const failedRequests = [];
  let browser;
  try {
    server = await startPreview(previewPort);
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
    const chrome = await findSystemChrome();
    if (chrome) launchOptions.executablePath = chrome;

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

    const response = await page.goto(previewUrl, { waitUntil: 'networkidle', timeout: navTimeoutMs });
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
      ok = false;
    } else {
      console.log('SMOKE PASSED');
      ok = true;
    }
  } catch (err) {
    console.error('SMOKE FAILED:\n- ' + (err && err.stack ? err.stack : String(err)));
    ok = false;
  } finally {
    if (browser) {
      await Promise.race([
        browser.close(),
        sleep(5000),
      ]).catch(() => {});
    }
    await stopPreview(server, previewPort);
  }
  return ok;
}

function isIgnorableAsset(url) {
  return /favicon\.ico(\?|$)/i.test(url) || /apple-touch-icon/i.test(url);
}

function isIgnorableConsole(text) {
  return /favicon\.ico/i.test(text) || /apple-touch-icon/i.test(text);
}

