import { parseSeed } from './rng.js';
import { createRenderer } from './renderer.js';
import { buildMap, WALL_HEIGHT } from './map.js';
import { createWater } from './water.js';
import { createControls } from './controls.js';
import { createOverlay } from './overlay.js';

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

  addLights(THREE, scene, map.lightsAt);

  const water = await createWater(THREE, kind, map.poolRooms);
  scene.add(water.group);

  const controls = createControls(camera, renderer.domElement, () => map.colliders);
  controls.setPose(map.spawn.x, map.spawn.z, map.spawn.yaw);

  const blocker = document.getElementById('blocker');
  blocker.addEventListener('click', () => controls.lock());
  document.addEventListener('pointerlockchange', () => {
    if (controls.locked) blocker.classList.add('hidden');
    else blocker.classList.remove('hidden');
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    const t = clock.elapsedTime;
    controls.update(dt);
    water.update(t);
    overlay.tick(performance.now());
    renderer.render(scene, camera);
  });

}

function addLights(THREE, scene, lightsAt) {
  const hemi = new THREE.HemisphereLight(0xf4f1de, 0x4a4a38, 0.85);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xe8dfc0, 0.55);
  scene.add(ambient);

  // One fluorescent-style point light per room. Intensity is in candela
  // (physically based); 25 lights is acceptable for a 5x5 grid.
  for (const pos of lightsAt) {
    const light = new THREE.PointLight(0xf7f3dc, 40, 16, 1.4);
    light.position.set(pos.x, WALL_HEIGHT - 0.28, pos.z);
    scene.add(light);

    // Small fixture under the ceiling so the light has a visible source.
    const fixture = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.08, 0.35),
      new THREE.MeshStandardMaterial({
        color: 0xf7f3d8,
        emissive: 0xf0ebd0,
        emissiveIntensity: 1.4,
        roughness: 0.6,
      }),
    );
    fixture.position.set(pos.x, WALL_HEIGHT - 0.12, pos.z);
    scene.add(fixture);
  }
}

boot().catch((err) => {
  console.error(err);
  const overlay = document.getElementById('overlay');
  if (overlay) {
    overlay.textContent = `Failed to start:\n${err?.message || err}`;
  }
});
