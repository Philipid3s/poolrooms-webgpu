/**
 * Shared helpers for the headless scripts (smoke.mjs, bench.mjs).
 * Playwright is not a project dependency: it is loaded from the
 * environment (global install or npx cache).
 */
import { spawn, execSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isWindows = process.platform === 'win32';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function requireDist() {
  await access(path.join(root, 'dist', 'index.html')).catch(() => {
    console.error('dist/ is missing. Run `npm run build` first.');
    process.exit(1);
  });
}

export async function loadPlaywright() {
  const candidates = ['playwright', 'playwright-core'];
  for (const name of candidates) {
    try {
      return unwrap(await import(name));
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
  // npx cache: ~/.npm/_npx on Linux/macOS, %LOCALAPPDATA%\npm-cache\_npx on Windows.
  roots.push(path.join(os.homedir(), '.npm', '_npx'));
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'));
  }

  for (const dir of roots) {
    const found = await findPackage(dir, 'playwright');
    if (found) {
      return unwrap(await import(pathToFileURL(path.join(found, 'index.js')).href));
    }
  }

  console.error('Could not load Playwright. Install it globally or run via npx.');
  process.exit(1);
}

// Playwright is CommonJS; depending on how it is resolved, its API is either
// on the module namespace or under `default`.
function unwrap(mod) {
  return mod?.chromium ? mod : mod?.default;
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

export async function findSystemChrome() {
  const candidates = isWindows
    ? [
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
        process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  for (const p of candidates) {
    if (p && (await exists(p))) return p;
  }
  return null; // let Playwright use its bundled Chromium
}

export function startPreview(port) {
  return new Promise((resolve, reject) => {
    // Run Vite's CLI directly with node: avoids `npm` (npm.cmd on Windows,
    // which spawn() cannot run without a shell) and an extra process layer.
    const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    const child = spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none' },
      // A process group lets us kill the whole tree on POSIX. On Windows,
      // detached would open a new console window; taskkill /T handles the tree.
      detached: !isWindows,
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

export async function stopPreview(child, port) {
  if (child && child.pid) {
    if (isWindows) {
      try {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // already gone
      }
    } else {
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
  }
  await sleep(400);
  if (process.platform === 'linux') {
    // Belt and braces: free the port if anything is still bound to it.
    try {
      execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
    } catch {
      // nothing bound, or fuser not installed
    }
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

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
