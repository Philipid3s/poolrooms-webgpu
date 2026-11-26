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

  // All fixtures in one instanced draw call.
  const fixtures = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.6, 0.08, 0.35),
    new THREE.MeshStandardMaterial({
      color: 0xf7f3d8,
      emissive: 0xf0ebd0,
      emissiveIntensity: 1.4,
      roughness: 0.6,
    }),
    centers.length,
  );
  const m = new THREE.Matrix4();
  centers.forEach((c, k) => {
    m.makeTranslation(c.x, ceilingY - 0.12, c.z);
    fixtures.setMatrixAt(k, m);
  });
  fixtures.instanceMatrix.needsUpdate = true;
  fixtures.computeBoundingSphere();
  scene.add(fixtures);

  const order = centers.map((_, k) => k);
  const dist = new Float32Array(centers.length);

  return {
    activeCount: count,
    /** Re-assign lights to the rooms nearest to (x, z). */
    update(x, z) {
      for (let k = 0; k < centers.length; k++) {
        dist[k] = Math.hypot(centers[k].x - x, centers[k].z - z);
      }
      order.sort((a, b) => dist[a] - dist[b] || a - b);
      for (let k = 0; k < count; k++) {
        const c = centers[order[k]];
        const w = 1 - smoothstep(FADE_START, FADE_END, dist[order[k]]);
        lights[k].position.x = c.x;
        lights[k].position.z = c.z;
        lights[k].intensity = LIGHT_INTENSITY * w;
      }
    },
  };
}

function smoothstep(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
