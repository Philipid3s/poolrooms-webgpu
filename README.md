# Poolrooms (WebGPU PoC)

A small first-person “poolrooms” scene in the browser: tiled rooms on a seeded grid, shallow indoor pools, and simple waving water. The app uses three.js `WebGPURenderer` when the browser exposes a WebGPU adapter, and falls back to `WebGLRenderer` automatically. You can also force the fallback to compare the two paths.

This is a local proof of concept. It is not a game, and it is not published on GitHub Pages or any other host.

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

A zip of the source (without `node_modules/` or `dist/`) may also be available on the box at `/workspace/bots-work/judy/poolrooms-webgpu.zip`.

## Controls

- Click the scene to lock the pointer.
- Mouse — look around.
- `W` `A` `S` `D` (or arrow keys) — move. Hold Shift to walk faster.
- `Esc` — release the pointer.
- Movement is blocked by walls and by the curb around each pool. There is no jump.

## URL parameters

| Parameter | Effect |
| --- | --- |
| `?seed=42` | Build the map from this seed. Numeric seeds are used as-is; any other string is hashed to a 32-bit seed. The same seed always produces the same layout and spawn point. If you omit it, a seed is generated and written into the URL. |
| `?renderer=webgl` | Skip WebGPU detection and force `WebGLRenderer`, for a side-by-side comparison. |

Examples:

- `http://localhost:5173/?seed=42`
- `http://localhost:5173/?seed=42&renderer=webgl`

The HUD shows the active renderer (`WebGPU` or `WebGL`), a live FPS counter, the seed, and why that renderer was chosen.

## Scope

**In scope:** Vite + three.js skeleton, WebGPU detection (`navigator.gpu` + `requestAdapter()`), automatic WebGL fallback, seeded procedural rooms, a simple animated water shader (TSL / node material on the WebGPU path, a small GLSL `ShaderMaterial` on the WebGL path), basic lighting, first-person controls, cheap wall collision, FPS overlay.

**Out of scope:** Nanite-style geometry, global illumination, imported assets, multiplayer, LLMs, GitHub Pages, and any other deploy.

## Results

Recorded on 2026-11-12. Only numbers that were actually measured are listed. WebGPU and WebGL frame rates on a real desktop GPU are still **to measure on Julien's Chrome**.

### Environment: the Linux box (no usable GPU)

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

### Environment: Julien's Chrome (desktop)

- WebGPU FPS: **to measure on Julien's Chrome** (open the dev server with no `renderer` parameter; confirm the HUD says `WebGPU`)
- WebGL FPS: **to measure on Julien's Chrome** (same seed, add `?renderer=webgl`)

A reasonable comparison is `?seed=42` vs `?seed=42&renderer=webgl` on the same machine.

## Limitations

- The water shaders are intentionally simple (two sine waves). They are not a physical water sim.
- Collision is axis-aligned boxes only (walls and pool curbs). You cannot fall into a pool.
- First-person controls are implemented in this repo rather than `PointerLockControls`, so the same code can run with objects from either `three` or `three/webgpu` (those two entry points must not be mixed).
- Tile textures are generated on a canvas at runtime; there are no image assets.
- There is no audio, no mobile touch path, and no pointer-lock fallback beyond the on-screen hint.
- A `scripts/smoke.mjs` helper exists for a headless WebGL check. Playwright is not a project dependency; the script uses an environment install of Playwright plus the system Chrome when present.

## License

Private project. Not licensed for reuse.
