/**
 * Room lighting: a ceiling fixture in every room, but only a small fixed
 * pool of PointLights, re-assigned each frame to the rooms nearest the
 * camera.
 *
 * Every lit pixel loops over every light, so 25 lights (one per room) cost
 * ~3x more shading than 9. Far rooms are only seen through doorways, where
 * fog and the hemisphere/ambient fill dominate anyway.
 *
 * No popping: a light's intensity fades to zero between FADE_START and
 * FADE_END metres from the camera. On this grid (12 m spacing) at most 9
 * room centres can lie within 18 m of any point, so every room with a
 * non-zero weight always has a light. The light count never changes, so no
 * shader recompiles either.
 */

const MAX_ACTIVE = 9;
const FADE_START = 12;
const FADE_END = 18;

const LIGHT_COLOR = 0xf7f3dc;
const LIGHT_INTENSITY = 26; // candela (physically based)
const LIGHT_DISTANCE = 14;
const LIGHT_DECAY = 1.6;

// Lights near the hostile presence flicker (see threat.js).
export const FLICKER_RADIUS = 10;
const FLICKER_RATE = 14; // flicker "frames" per second

/**
 * @param {object} THREE
 * @param {object} scene
 * @param {{x:number,z:number}[]} centers room centres
 * @param {number} ceilingY
 */
export function createRoomLights(THREE, scene, centers, ceilingY) {
  const hemi = new THREE.HemisphereLight(0xf4f1de, 0x4a4a38, 0.6);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0xe8dfc0, 0.4);
  scene.add(ambient);

  const count = Math.min(MAX_ACTIVE, centers.length);
  const lights = [];
  for (let k = 0; k < count; k++) {
    const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_DISTANCE, LIGHT_DECAY);
    light.position.y = ceilingY - 0.28;
    scene.add(light);
    lights.push(light);
  }

  // All fixtures in one instanced draw call. Unlit (they are the light
  // source) with a per-instance colour, so each tube can flicker on its own.
  const fixtures = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.6, 0.08, 0.35),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    centers.length,
  );
  const tubeOn = new THREE.Color(0xf3efd6).multiplyScalar(1.4); // HDR, > 1 on purpose
  const tubeNow = new THREE.Color();
  const m = new THREE.Matrix4();
  centers.forEach((c, k) => {
    m.makeTranslation(c.x, ceilingY - 0.12, c.z);
    fixtures.setMatrixAt(k, m);
    fixtures.setColorAt(k, tubeOn);
  });
  fixtures.instanceColor.needsUpdate = true;
  let fixturesDirty = false;
  fixtures.instanceMatrix.needsUpdate = true;
  fixtures.computeBoundingSphere();
  scene.add(fixtures);

  const order = centers.map((_, k) => k);
  const dist = new Float32Array(centers.length);

  return {
    activeCount: count,
    /**
     * Re-assign lights to the rooms nearest to (x, z).
     * @param {number} t seconds
     * @param {{x:number,z:number}|null} disturber the presence, makes nearby lights flicker
     */
    update(x, z, t = 0, disturber = null) {
      for (let k = 0; k < centers.length; k++) {
        dist[k] = Math.hypot(centers[k].x - x, centers[k].z - z);
      }
      // Tubes near the presence flicker (all fixtures, not only active lights).
      if (disturber || fixturesDirty) {
        fixturesDirty = false;
        for (let k = 0; k < centers.length; k++) {
          const f = disturber ? tubeFlicker(t, k, centers[k], disturber) : 1;
          if (f < 1) fixturesDirty = true;
          fixtures.setColorAt(k, tubeNow.copy(tubeOn).multiplyScalar(f));
        }
        fixtures.instanceColor.needsUpdate = true;
      }
      order.sort((a, b) => dist[a] - dist[b] || a - b);
      for (let k = 0; k < count; k++) {
        const c = centers[order[k]];
        let w = 1 - smoothstep(FADE_START, FADE_END, dist[order[k]]);
        if (disturber) w *= tubeFlicker(t, order[k], c, disturber);
        lights[k].position.x = c.x;
        lights[k].position.z = c.z;
        lights[k].intensity = LIGHT_INTENSITY * w;
      }
    },
  };
}

/** Brightness factor (0..1) of fixture k at c, given the presence's position. */
function tubeFlicker(t, k, c, disturber) {
  const dd = Math.hypot(c.x - disturber.x, c.z - disturber.z);
  if (dd >= FLICKER_RADIUS) return 1;
  const strength = 1 - dd / FLICKER_RADIUS;
  return 1 - strength * (1 - flicker(t, k));
}

/** Fluorescent-tube flicker: mostly dimmed, with hard drop-outs. 0..1 */
function flicker(t, k) {
  const f = Math.floor(t * FLICKER_RATE);
  const a = hash(f + k * 31.7);
  if (a < 0.22) return 0.03; // tube drops out
  return 0.45 + 0.55 * hash(f * 1.3 + k * 7.1 + 3.3);
}

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothstep(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
