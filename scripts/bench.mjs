/**
 * Headless benchmark: serve the production build, run the in-app bench
 * (?bench=<s>) once per renderer on the real GPU, and print a comparison.
 *
 * Chrome is launched with vsync and the frame-rate limit disabled, so the
 * numbers are not capped at the display refresh rate.
 *
 * Usage (from the repo root, after `npm run build`):
 *   npm run bench                       (seed 42, 15 s per renderer)
 *   node scripts/bench.mjs --seconds 30 --seed 7 --size 1920x1080
 *   node scripts/bench.mjs --extra "water=sine"   (extra URL params)
 *
 * Results are also written to bench-results.json (git-ignored).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  root, requireDist, loadPlaywright, findSystemChrome, startPreview, stopPreview, sleep,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const seconds = Number(args.seconds || 15);
const seed = args.seed || '42';
const [width, height] = (args.size || '1280x720').split('x').map(Number);
const extra = args.extra ? `&${args.extra}` : '';
const port = Number(process.env.BENCH_PORT || 4174);

await requireDist();
const playwright = await loadPlaywright();
const server = await startPreview(port);

const runs = [
  { label: 'WebGPU', query: '' },
  { label: 'WebGL', query: '&renderer=webgl' },
];
const results = [];
let browser;

try {
  const launchOptions = {
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
    ],
  };
  const chrome = await findSystemChrome();
  if (chrome) launchOptions.executablePath = chrome;
  browser = await playwright.chromium.launch(launchOptions);

  for (const run of runs) {
    // A fresh page per run so the two renderers do not share GPU state.
    const page = await browser.newPage({ viewport: { width, height } });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text());
    });

    const url = `http://127.0.0.1:${port}/?seed=${encodeURIComponent(seed)}&bench=${seconds}${run.query}${extra}`;
    process.stdout.write(`${run.label}: ${url} … `);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });

    const gpu = await page.evaluate(gpuDescription);
    const handle = await page.waitForFunction(() => window.__benchResult, null, {
      timeout: (seconds + 30) * 1000,
      polling: 500,
    }).catch(() => null);
    const result = handle ? await handle.jsonValue() : null;
    const overlay = await page.evaluate(() => document.getElementById('overlay')?.textContent || '');

    if (!result) {
      console.log('no result');
      console.log(overlay);
      if (pageErrors.length) console.log('errors:', pageErrors.join(' | '));
      process.exitCode = 1;
    } else {
      console.log(`${result.avgFps} fps`);
      if (result.renderer !== run.label) {
        console.log(`  note: page reported renderer ${result.renderer} (${overlay.split('\n')[3] || ''})`);
      }
      results.push({ ...result, requested: run.label, gpu, size: `${width}x${height}`, errors: pageErrors });
    }
    await page.screenshot({ path: path.join(root, `bench-${run.label.toLowerCase()}.png`) });
    await page.close();
  }
} finally {
  if (browser) await Promise.race([browser.close(), sleep(5000)]).catch(() => {});
  await stopPreview(server, port);
}

if (results.length) {
  console.log('');
  console.log(`GPU: ${results[0].gpu}`);
  console.log(`seed ${seed}, ${width}x${height}, ${seconds}s measured per renderer${extra ? `, ${extra.slice(1)}` : ''}`);
  console.table(
    Object.fromEntries(
      results.map((r) => [
        r.renderer,
        {
          'avg fps': r.avgFps,
          'avg ms': r.avgMs,
          'p50 ms': r.p50Ms,
          'p95 ms': r.p95Ms,
          'p99 ms': r.p99Ms,
          'draw calls': r.drawCalls,
          frames: r.frames,
        },
      ]),
    ),
  );
  await writeFile(path.join(root, 'bench-results.json'), JSON.stringify(results, null, 2));
}

async function gpuDescription() {
  const parts = [];
  try {
    const a = await navigator.gpu?.requestAdapter();
    if (a?.info) parts.push(`WebGPU adapter: ${[a.info.vendor, a.info.architecture, a.info.description].filter(Boolean).join(' ')}`);
  } catch {
    // ignore
  }
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    if (ext) parts.push(`WebGL: ${gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}`);
  } catch {
    // ignore
  }
  return parts.join(' | ') || 'unknown';
}

function parseArgs(argv) {
  const out = {};
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split('=');
      out[name] = inline ?? argv[++k];
    }
  }
  return out;
}
