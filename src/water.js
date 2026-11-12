/**
 * Shallow animated water planes. WebGPU uses a TSL node material;
 * WebGL uses a small GLSL ShaderMaterial. Both are simple sine waves.
 */

import { ROOM_SIZE, POOL_MARGIN, roomCenterX, roomCenterZ } from './map.js';

const COLOR_DEEP = 0x1c4d4f;
const COLOR_SHALLOW = 0x4f8a86;

/**
 * @param {object} THREE
 * @param {'WebGPU'|'WebGL'} rendererKind
 * @param {{i:number,j:number}[]} poolRooms
 */
export async function createWater(THREE, rendererKind, poolRooms) {
  const group = new THREE.Group();
  group.name = 'water';
  const width = ROOM_SIZE - POOL_MARGIN * 2 - 0.12;
  const material = await makeWaterMaterial(THREE, rendererKind);
  if (!material) return { group, update() {} };

  for (const room of poolRooms) {
    const geo = new THREE.PlaneGeometry(width, width, 48, 48);
    const mesh = new THREE.Mesh(geo, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(roomCenterX(room.i), -0.28, roomCenterZ(room.j));
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  return {
    group,
    update(timeSec) {
      if (typeof material.userData.update === 'function') {
        material.userData.update(timeSec);
      }
    },
  };
}

async function makeWaterMaterial(THREE, rendererKind) {
  if (rendererKind === 'WebGPU') {
    try {
      return await makeTslMaterial();
    } catch (err) {
      console.warn('TSL water material failed, falling back to a still plane:', err);
      return makeBasicFallback(THREE);
    }
  }
  return makeGlslMaterial(THREE);
}

async function makeTslMaterial() {
  const { MeshStandardNodeMaterial } = await import('three/webgpu');
  const tsl = await import('three/tsl');
  const { positionLocal, time, sin, cos, vec3, float, mix, color, add, mul } = tsl;

  const material = new MeshStandardNodeMaterial();
  material.color = COLOR_DEEP;
  material.transparent = true;
  material.opacity = 0.82;
  material.metalness = 0.12;
  material.roughness = 0.22;
  material.side = 2; // DoubleSide
  material.depthWrite = false;

  const wave = add(
    mul(sin(add(mul(positionLocal.x, float(0.85)), mul(time, float(1.15)))), float(0.07)),
    mul(cos(add(mul(positionLocal.y, float(0.7)), mul(time, float(0.9)))), float(0.045)),
  );
  material.positionNode = positionLocal.add(vec3(0, 0, wave));

  const shallow = color(COLOR_SHALLOW);
  const deep = color(COLOR_DEEP);
  // Wave lifts the surface toward the shallow tint.
  material.colorNode = mix(deep, shallow, wave.mul(4.0).add(0.35).clamp());
  material.opacityNode = float(0.82);

  return material;
}

function makeGlslMaterial(THREE) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColorDeep: { value: new THREE.Color(COLOR_DEEP) },
      uColorShallow: { value: new THREE.Color(COLOR_SHALLOW) },
    },
    vertexShader: `
      uniform float uTime;
      varying float vWave;
      void main() {
        vec3 p = position;
        float wave = sin(p.x * 0.85 + uTime * 1.15) * 0.07
                   + cos(p.y * 0.70 + uTime * 0.90) * 0.045;
        p.z += wave;
        vWave = wave;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColorDeep;
      uniform vec3 uColorShallow;
      varying float vWave;
      void main() {
        float t = clamp(vWave * 4.0 + 0.35, 0.0, 1.0);
        vec3 col = mix(uColorDeep, uColorShallow, t);
        gl_FragColor = vec4(col, 0.82);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  material.userData.update = (timeSec) => {
    material.uniforms.uTime.value = timeSec;
  };
  return material;
}

function makeBasicFallback(THREE) {
  return new THREE.MeshStandardMaterial({
    color: COLOR_DEEP,
    transparent: true,
    opacity: 0.82,
    roughness: 0.22,
    metalness: 0.12,
    depthWrite: false,
  });
}
