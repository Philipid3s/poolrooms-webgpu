import { parseSeed } from './rng.js';
import { createRenderer } from './renderer.js';
import { buildMap, poolAt, WALL_HEIGHT, POOL_FLOOR_Y, WATER_Y } from './map.js';
import { createWater } from './water.js';
import { createControls } from './controls.js';
import { createOverlay } from './overlay.js';
import { createBench, parseBenchParam } from './bench.js';
import { createRoomLights } from './lights.js';
import { applyCaustics } from './caustics.js';
import { createAudio } from './audio.js';

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const seedInfo = parseSeed(params.get('seed'));
  if (seedInfo.generated || !params.has('seed')) {
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(seedInfo.seed));
    history.replaceState({}, '', url);
  }

  const overlay = createOverlay(document.getElementById('overlay'));
  const seedText = seedInfo.label && seedInfo.label !== String(seedInfo.seed)
    ? `${seedInfo.label} (${seedInfo.seed})`
    : String(seedInfo.seed);
  overlay.setSeed(seedText);

  let created;
  try {
    created = await createRenderer(document.body);
  } catch (err) {
    overlay.setRenderer('failed');
    overlay.setExtra(String(err?.message || err));
    throw err;
  }

  const { THREE, renderer, kind, detection, forced } = created;
  overlay.setRenderer(kind);
  const why = forced
    ? 'forced by ?renderer=webgl'
    : (kind === 'WebGPU' ? detection.reason : `fallback (${detection.reason})`);
  overlay.setExtra(why);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a271c);
  scene.fog = new THREE.FogExp2(0x3a3628, 0.018);

  const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 200);

  const map = buildMap(THREE, seedInfo.seed);
  scene.add(map.group);

  const lights = createRoomLights(THREE, scene, map.lightsAt, WALL_HEIGHT);

  // ?water=sine forces the analytic water on WebGPU too (fair comparison).
  const waterMode = params.get('water') === 'sine' ? 'sine' : 'sim';
  const water = await createWater(THREE, kind, map.pools, { renderer, mode: waterMode, seed: seedInfo.seed });
  scene.add(water.group);

  const caustics = await applyCaustics(THREE, kind, map.materials.pool, { waterY: WATER_Y, focusAt: water.focusAt });
  const audio = createAudio(THREE, {
    fixtures: map.lightsAt,
    fixtureY: WALL_HEIGHT - 0.12,
    pools: map.pools,
    waterY: WATER_Y,
  });

  const benchSeconds = parseBenchParam(params);
  const bench = benchSeconds ? createBench({ seconds: benchSeconds, map }) : null;

  // Floor height under the player: pools are walkable (wading). The bench
  // keeps a constant eye height so its frames stay comparable across runs.
  const ground = (x, z) => (poolAt(map.pools, x, z) ? WADING : DRY);
  const controls = createControls(camera, renderer.domElement, () => map.colliders, bench ? undefined : ground);
  controls.setPose(map.spawn.x, map.spawn.z, map.spawn.yaw);

  // Small debug hook (console / headless tests).
  window.__poolrooms = { THREE, renderer, scene, camera, controls, map, water, audio, kind };

  const blocker = document.getElementById('blocker');
  if (bench) {
    blocker.classList.add('hidden');
  } else {
    blocker.addEventListener('click', () => {
      audio.start(); // needs a user gesture
      controls.lock();
    });
    document.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM') audio.toggleMute();
    });
    document.addEventListener('pointerlockchange', () => {
      if (controls.locked) blocker.classList.add('hidden');
      else blocker.classList.remove('hidden');
    });
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const timer = new THREE.Timer();
  timer.connect(document); // ignores time spent in a hidden tab
  let infoFrame = 0;
  renderer.setAnimationLoop((timestamp) => {
    const now = performance.now();
    timer.update(timestamp);
    const dt = timer.getDelta();
    let t = timer.getElapsed();

    if (bench) {
      const b = bench.frame(now);
      // Drive everything time-based from the bench clock so both renderers
      // render the same sequence of frames.
      t = b.t;
      const p = bench.pose(b.t);
      controls.setPose(p.x, p.z, p.yaw, p.pitch);
      if (!bench.done) {
        overlay.setBench(b.warmup ? 'Bench: warming up…' : `Bench: ${Math.ceil(benchSeconds + 2 - b.t)} s left`);
      }
    } else {
      controls.update(dt);
    }

    lights.update(camera.position.x, camera.position.z);
    const drip = water.update(t, dt, wader(controls, map, camera));
    caustics.update(t);
    audio.update(camera, controls.state, dt, t, drip);
    renderer.render(scene, camera);
    overlay.tick(now);

    // After render(): WebGPU resets its per-frame counters at the start of
    // each animation frame, WebGL at the start of render().
    if (bench?.done && !bench.reported) {
      bench.reported = true;
      reportBench(overlay, kind, seedInfo.seed, bench.result, renderer);
    }

    if (++infoFrame % 30 === 0) {
      overlay.setInfo(
        `Draw calls: ${drawCalls(renderer)} · lights: ${lights.activeCount}/${map.lightsAt.length}
` +
        `Water: ${water.label} · audio: ${audio.state}`,
      );
    }
  });

}

const DRY = { y: 0, inWater: false };
const WADING = { y: POOL_FLOOR_Y, inWater: true };

/** The player as a water disturbance, or null when not in a pool. */
function wader(controls, map, camera) {
  const { x, z } = camera.position;
  const hit = controls.state.inWater ? poolAt(map.pools, x, z) : null;
  return hit ? { x, z, speed: controls.state.speed, pool: hit.index } : null;
}

function drawCalls(renderer) {
  const r = renderer.info?.render || {};
  // WebGLRenderer: info.render.calls; WebGPURenderer: info.render.drawCalls.
  return r.drawCalls ?? r.calls ?? '?';
}

function reportBench(overlay, kind, seed, result, renderer) {
  const full = { renderer: kind, seed, drawCalls: drawCalls(renderer), ...result };
  window.__benchResult = full;
  console.log('BENCH', JSON.stringify(full));
  overlay.setBench(
    `Bench (${result.seconds}s): ${result.avgFps} fps avg\n` +
    `frame ms  avg ${result.avgMs}  p50 ${result.p50Ms}  p95 ${result.p95Ms}  p99 ${result.p99Ms}`,
  );
}

boot().catch((err) => {
  console.error(err);
  const overlay = document.getElementById('overlay');
  if (overlay) {
    overlay.textContent = `Failed to start:\n${err?.message || err}`;
  }
});
