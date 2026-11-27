# Poolrooms (WebGPU PoC)

A small first-person “poolrooms” scene in the browser: tiled rooms on a seeded grid and shallow indoor pools you can wade into. The app uses three.js `WebGPURenderer` when the browser exposes a WebGPU adapter, and falls back to `WebGLRenderer` automatically. You can also force the fallback to compare the two paths.

On WebGPU, the pools are an interactive wave simulation run in a compute shader: wading through them leaves a wake, and drips from the ceiling make rings that bounce off the pool walls. The ripples also focus light onto the pool floor as moving caustics. WebGL keeps simple analytic sine-wave water with the same procedural caustic pattern.

The sound is synthesized live with the Web Audio API (no audio files): fluorescent hum from the nearest fixtures, lapping water from each pool, a “plic” for each drip, and footsteps on tile or in water, all with a tiled-room echo.

**You are not alone.** After a short grace period, a hostile presence starts roaming the rooms. It is almost invisible: a tall dark silhouette you glimpse in the haze, which fades when it gets close. You notice it through the world: fluorescent tubes flicker and crackle near it, you hear its breathing and its heavy wet steps, and on WebGPU it leaves ripples when it wades through a pool. It hears you walk (and hears you run or wade from much further away), and it chases you when it sees you. If it catches you, you wake up somewhere else: the same level, with new rooms.

**Find the way out.** Each level hides an emergency exit (a steel door with a green “ISSUE DE SECOURS” light box) in the dry room farthest from where you start. Go through it to reach the next level. There are 10 levels. With each one the presence gets a little faster (up to +15 %), hears you from a little further away (up to +30 %), wakes sooner (from 15 s down to 8 s), and the haze gets thicker. Level 1 uses the base tuning. After level 10 you are out.

This started as a renderer proof of concept and is now a small local game. It is not published on GitHub Pages or any other host.

## How to run

```bash
git clone https://github.com/Philipid3s/poolrooms-webgpu.git
cd poolrooms-webgpu
npm ci
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173/`).

Production build and local preview:

```bash
npm ci
npm run build
npm run preview
```

Versions are pinned exactly in `package.json` (no `^` / `~`). Use `npm ci` so the lockfile is respected.


## CI & deployment

GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request, on every push to `main` and on manual dispatch:

- **verify** (always): `npm ci`, `npm run build`, then the headless WebGL smoke test (`scripts/smoke.mjs`, one automatic retry) against `vite preview`. The `dist/` build is kept as a workflow artifact.
- **image** (push to `main` only, after `verify`): builds the Docker image (`Dockerfile`: Vite build, served by nginx on port 80), scans it with Trivy (the job fails on any fixable CRITICAL vulnerability), and only if the scan passes pushes it to GitHub Container Registry with provenance and SBOM attestations.

The image is published as `ghcr.io/philipid3s/poolrooms-webgpu`, tagged `sha-<first 7 chars of the commit>`. There is **no `latest` tag**. The tag and the immutable digest (`sha256:...`) of each build are written to the run's job summary.

Deployment is not done by CI. It is done by digest (`ghcr.io/philipid3s/poolrooms-webgpu@sha256:...`, with a rollback to the previous digest) by Boris (DevOps) on the VPS, only after Julien's go for each rollout.

## Controls

- Click the scene to lock the pointer.
- Mouse — look around.
- `W` `A` `S` `D` (or arrow keys) — move. Hold Shift to run.
- Running drains your stamina: about 4.5 s from full. A thin bar at the bottom of the screen shows it while it is not full, and you hear yourself panting. It refills slowly (about 7 s) once you stop running. If you empty it you are winded (the bar turns red) and cannot run again until about a third of it is back.
- `M` — mute / unmute. Sound starts with the first click (browsers require a user gesture).
- The presence only acts while you are in the scene (pointer locked); releasing the pointer pauses it.
- Survival tips: running is faster than the presence, but only in short bursts, and it can be heard 16 m away; walking is heard at 6 m, wading at 10 m. In the water you are slower than it.
- `Esc` — release the pointer.
- Movement is blocked by walls. Step over a pool's curb to wade in: you sink to the pool floor and move slower. On WebGPU your movement makes ripples. There is no jump.

## URL parameters

| Parameter | Effect |
| --- | --- |
| `?seed=42` | Build the map from this seed. Numeric seeds are used as-is; any other string is hashed to a 32-bit seed. The same seed always produces the same layout and spawn point. If you omit it, a seed is generated and written into the URL. |
| `?renderer=webgl` | Skip WebGPU detection and force `WebGLRenderer`, for a side-by-side comparison. |
| `?water=sine` | On WebGPU, use the analytic sine-wave water instead of the compute simulation (same water as WebGL, for a like-for-like comparison). |
| `?level=3` | Start at this level (1 to 10). Reaching the exit moves on to the next level with a new seed; being caught restarts the same level with a new seed. |
| `?threat=off` | No hostile presence (exploration only). It is always off in benchmark mode. |
| `?debug` | Shows the presence's state and distance in the HUD, and lets it act while the pointer is not locked (for headless tests). |
| `?bench` / `?bench=30` | Benchmark mode: the camera follows a fixed tour of the map for 15 s (or the given number of seconds) after a 2 s warm-up, then the HUD shows average fps and frame-time percentiles. The tour is a function of time, so both renderers draw the same frames. |

Examples:

- `http://localhost:5173/?seed=42`
- `http://localhost:5173/?seed=42&renderer=webgl`
- `http://localhost:5173/?seed=42&bench`

The HUD shows the active renderer (`WebGPU` or `WebGL`), a live FPS counter, the seed, why that renderer was chosen, the draw-call count, the number of active lights, and the water mode.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server. |
| `npm run build` / `npm run preview` | Production build / serve it locally. |
| `npm run smoke` | Headless WebGL check of the build (`scripts/smoke.mjs`): no page errors, overlay correct, writes `smoke.png`. |
| `npm run bench` | Headless benchmark of the build on the real GPU (`scripts/bench.mjs`): runs `?bench` on WebGPU then WebGL with vsync and the frame-rate limit disabled, prints a table and writes `bench-results.json` + screenshots. Options: `--seconds 30`, `--seed 7`, `--size 1920x1080`, `--extra water=sine`. |

The headless scripts work on Linux, macOS and Windows. Playwright is not a project dependency: they use an environment install (global or npx cache) plus the system Chrome when present. Build first (`npm run build`).

When benchmarking by hand in a normal browser, the frame rate is capped at the display refresh rate. Launch Chrome with `--disable-gpu-vsync --disable-frame-rate-limit` to remove the cap.

## Scope

**In scope:** Vite + three.js skeleton, WebGPU detection (`navigator.gpu` + `requestAdapter()`), automatic WebGL fallback (also used if WebGPU renderer initialisation fails), seeded procedural rooms, a compute-shader water simulation on WebGPU (TSL), simple animated sine-wave water as the fallback (a lit TSL node material on WebGPU with `?water=sine`; a `MeshStandardMaterial` with GLSL patched in via `onBeforeCompile` on WebGL), basic lighting, first-person controls with wading, cheap wall collision, FPS overlay, benchmark mode, procedural caustics (driven by the simulated surface on WebGPU), procedural spatial audio.

**Out of scope:** Nanite-style geometry, global illumination, imported assets, multiplayer, LLMs, GitHub Pages, and any other deploy.

## Results

Only numbers that were actually measured are listed. A discrete desktop GPU has not been measured yet.

### Environment: Windows laptop, Intel Iris Xe (integrated), 2026-11-26

- Intel Core i9-13900H with Iris Xe graphics, Windows 11
- Google Chrome `158.0.8127.38`, headless, real GPU (WebGPU adapter `intel gen-12lp`; WebGL via ANGLE Direct3D 11), vsync and frame-rate limit disabled
- Node.js `v24.14.1`; `three@0.187.0`, `vite@8.3.8`
- `npm run bench`: seed 42, 1280×720, 12 s measured per run after a 2 s warm-up; each row is two runs (they agreed within about 8 %)

| Version | WebGPU fps (avg ms) | WebGL fps (avg ms) | Draw calls |
| --- | --- | --- | --- |
| Before optimisation (25 point lights, one mesh and material per wall) | 204–210 (4.8–4.9) | 282–287 (3.5) | ~88 |
| Merged static geometry + 9 nearest lights, `?water=sine` | 428–430 (2.3) | 602–654 (1.5–1.7) | 12–13 |
| Same, WebGPU with the compute water simulation (default) | 374–375 (2.7) | 586–634 (1.6–1.7) | 9 (+ compute) |
| + caustics on the pool floor, `?water=sine` | 414–419 (2.4) | 592* (1.7) | 12–13 |
| + caustics, default (WebGPU caustics follow the simulated ripples) | 353–362 (2.8) | 571–585 (1.7–1.8) | 9 (+ compute) |

\* One of the two WebGL runs in that row was an outlier at 412 fps; the other runs of the same build were 571–592.

What this shows:

- The two optimisations roughly **doubled** the frame rate on both renderers.
- The compute water (7 pools × 128² cells, 120 steps/s, plus a 115k-vertex displaced mesh) costs about **0.35 ms per frame** on this GPU.
- Caustics cost about 0.1 ms per frame on WebGPU, and slightly more when they sample the simulation (about 20 storage reads per pool-floor pixel). Audio is not active during benchmarks.
- On this integrated GPU, at these very short frame times, **WebGL is faster than WebGPU** (about 1.5 ms vs 2.3 ms per frame with the same water). The scene is light, so this probably reflects per-frame CPU overhead in each renderer more than GPU work (not profiled). A heavier scene or a discrete GPU may give a different picture.

### Environment: the Linux box (no usable GPU), 2026-11-12

- Node.js `v24.22.1`, npm `11.21.1`
- Pinned dependencies: `three@0.187.0`, `vite@8.3.8`
- `npm ci`: passed
- `npm run build`: passed (Vite 8.3.8, ~0.4–1.3 s)
- Headless smoke check: passed
  - Google Chrome `156.0.8078.47` in headless mode, SwiftShader (`--use-gl=angle --use-angle=swiftshader`)
  - URL: `/?renderer=webgl&seed=42`
  - Page loaded, canvas 1280×720, overlay reported `Renderer: WebGL`, no page errors
  - Screenshot: `smoke.png` (kept locally, not committed)
  - **FPS: 4** at 1280×720, WebGL, software rasterizer. This is not a useful GPU figure.
- WebGPU was not measured here. The box is not expected to expose a usable `navigator.gpu` adapter, and the smoke run forced the WebGL path.

## Limitations

- The compute water is a linear height-field wave equation, not fluid dynamics: no splashes, foam, reflections or refraction. It runs on WebGPU only; WebGL keeps the two-sine-wave water.
- Collision is axis-aligned boxes only (walls). Pools are a floor-height change, not a collision volume.
- Only the 9 lights nearest the camera are active. They fade out between 12 m and 18 m, so rooms seen far away through several doorways are lit only by the ambient fill.
- First-person controls are implemented in this repo rather than `PointerLockControls`, so the same code can run with objects from either `three` or `three/webgpu` (those two entry points must not be mixed).
- Tile textures are generated on a canvas at runtime; there are no image assets.
- The caustics are a procedural pattern (plus, on WebGPU, a curvature-based focusing term), not ray-traced light transport. They are not offset by refraction.
- Audio is synthesized and has no occlusion: walls do not muffle sounds from other rooms, only distance does. The presence's hearing has no occlusion either.
- The presence moves along doorway-to-doorway paths and does not collide with the player or avoid pools. Its sight is a 2D line-of-sight test against the walls (no field of view: it notices you behind it too).
- Being caught reloads the page with a new seed, so audio needs another click to restart.
- There is no mobile touch path and no pointer-lock fallback beyond the on-screen hint.

## License

Private project. Not licensed for reuse.
