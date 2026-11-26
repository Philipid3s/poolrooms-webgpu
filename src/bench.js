/**
 * Benchmark mode (?bench or ?bench=<seconds>).
 *
 * The camera follows a fixed tour of the map (a depth-first walk through
 * the doorways, starting at the spawn room). Position and look direction
 * are a pure function of elapsed time, so both renderers see exactly the
 * same frames regardless of their frame rate. After a warm-up (shader /
 * pipeline compilation), frame times are recorded and summarised.
 *
 * Results are shown in the HUD, logged to the console as JSON, and stored
 * on window.__benchResult (read by scripts/bench.mjs).
 *
 * Note: browsers cap requestAnimationFrame at the display refresh rate.
 * For meaningful numbers on a fast GPU, launch Chrome with
 *   --disable-gpu-vsync --disable-frame-rate-limit
 * (scripts/bench.mjs does this).
 */

import { ROOM_SIZE, roomCenterX, roomCenterZ, roomNeighbors } from './map.js';

const WARMUP_SEC = 2;
const DEFAULT_SEC = 15;
const SPEED = 4.2; // m/s along the tour
const TURN_BLEND = 2.5; // metres before/after a corner over which yaw blends

export function parseBenchParam(params) {
  if (!params.has('bench')) return null;
  const raw = Number(params.get('bench'));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SEC;
}

/**
 * @param {object} opts
 * @param {number} opts.seconds measured duration (after warm-up)
 * @param {{doors:object, spawn:{x:number,z:number}}} opts.map
 */
export function createBench({ seconds, map }) {
  const tour = buildTour(map);
  const frameMs = [];
  let startT = null;
  let lastT = null;
  let done = false;
  let result = null;

  return {
    get done() {
      return done;
    },
    get result() {
      return result;
    },
    /** Camera pose for time t (seconds since the bench started). */
    pose(t) {
      return poseAt(tour, t);
    },
    /**
     * Call once per frame with performance.now(). Returns the elapsed bench
     * time in seconds and whether we are still warming up.
     */
    frame(nowMs) {
      if (startT === null) startT = nowMs;
      const t = (nowMs - startT) / 1000;
      // Count a frame only if it also *started* after the warm-up: WebGL
      // compiles shaders synchronously in the first render(), which can
      // produce one multi-second frame straddling the warm-up boundary.
      if (!done && lastT !== null && (lastT - startT) / 1000 > WARMUP_SEC) {
        frameMs.push(nowMs - lastT);
      }
      lastT = nowMs;
      if (!done && t >= WARMUP_SEC + seconds) {
        done = true;
        result = summarise(frameMs, seconds);
      }
      return { t, warmup: t <= WARMUP_SEC };
    },
  };
}

function summarise(frameMs, seconds) {
  const sorted = [...frameMs].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const total = frameMs.reduce((s, v) => s + v, 0);
  const avg = total / Math.max(1, frameMs.length);
  return {
    seconds,
    frames: frameMs.length,
    avgFps: round(1000 / avg, 1),
    avgMs: round(avg, 2),
    p50Ms: round(pct(50), 2),
    p95Ms: round(pct(95), 2),
    p99Ms: round(pct(99), 2),
    maxMs: round(sorted[sorted.length - 1] || 0, 2),
  };
}

function round(v, d) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/**
 * Depth-first walk over the room graph from the spawn room, including the
 * walk back, as a closed polyline of room centres.
 */
function buildTour(map) {
  const start = { i: Math.round(map.spawn.x / ROOM_SIZE), j: Math.round(map.spawn.z / ROOM_SIZE) };
  const seen = new Set();
  const pts = [];
  const key = (r) => `${r.i},${r.j}`;
  const visit = (r) => {
    seen.add(key(r));
    pts.push({ x: roomCenterX(r.i), z: roomCenterZ(r.j) });
    for (const n of roomNeighbors(map.doors, r.i, r.j)) {
      if (seen.has(key(n))) continue;
      visit(n);
      pts.push({ x: roomCenterX(r.i), z: roomCenterZ(r.j) });
    }
  };
  visit(start);

  // Segments with cumulative length and heading.
  const segs = [];
  let total = 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    // Camera looks down -Z at yaw 0, so heading = atan2(-dx, -dz).
    segs.push({ a, b, len, start: total, yaw: Math.atan2(-(b.x - a.x), -(b.z - a.z)) });
    total += len;
  }
  return { segs, total };
}

function poseAt(tour, t) {
  const { segs, total } = tour;
  if (!segs.length) {
    return { x: 0, z: 0, yaw: t * 0.4, pitch: -0.05 };
  }
  const d = (t * SPEED) % total;
  let k = segs.findIndex((s) => d < s.start + s.len);
  if (k < 0) k = segs.length - 1;
  const s = segs[k];
  const u = (d - s.start) / s.len;
  const x = s.a.x + (s.b.x - s.a.x) * u;
  const z = s.a.z + (s.b.z - s.a.z) * u;

  // Blend heading smoothly around corners (room centres).
  let yaw = s.yaw;
  const intoSeg = d - s.start;
  const toEnd = s.start + s.len - d;
  if (toEnd < TURN_BLEND) {
    const next = segs[(k + 1) % segs.length];
    yaw = blendAngle(s.yaw, next.yaw, 0.5 * (1 - toEnd / TURN_BLEND));
  } else if (intoSeg < TURN_BLEND) {
    const prev = segs[(k - 1 + segs.length) % segs.length];
    yaw = blendAngle(prev.yaw, s.yaw, 0.5 + 0.5 * (intoSeg / TURN_BLEND));
  }

  // A gentle look-around so walls, pools and ceiling all get drawn.
  yaw += 0.35 * Math.sin(t * 0.55);
  const pitch = -0.12 + 0.1 * Math.sin(t * 0.37);
  return { x, z, yaw, pitch };
}

function blendAngle(a, b, w) {
  let diff = b - a;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return a + diff * w;
}
