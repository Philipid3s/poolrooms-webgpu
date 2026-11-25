/**
 * Shallow animated water planes. WebGPU uses a TSL node material;
 * WebGL uses a MeshStandardMaterial patched with GLSL. Both are lit and
 * share the same two sine waves, tint, opacity and fresnel-ish falloff.
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

// Shared look, used by both the TSL (WebGPU) and the GLSL (WebGL) materials
// so the two renderers can be compared fairly. Both are lit PBR materials.
const WATER_OPACITY_BASE = 0.74; // facing the camera
const WATER_OPACITY_GRAZING = 0.95; // at grazing angles (fresnel-ish)
const WATER_METALNESS = 0.12;
const WATER_ROUGHNESS = 0.22;

// wave(x, y, t) = A1 * sin(k1 * x + w1 * t) + A2 * cos(k2 * y + w2 * t)
const W = { a1: 0.07, k1: 0.85, w1: 1.15, a2: 0.045, k2: 0.7, w2: 0.9 };

async function makeTslMaterial() {
  const { MeshStandardNodeMaterial, DoubleSide } = await import('three/webgpu');
  const tsl = await import('three/tsl');
  const {
    positionLocal, time, sin, cos, vec3, float, mix, color, add, mul,
    normalView, positionViewDirection, transformNormalToView,
  } = tsl;

  const material = new MeshStandardNodeMaterial();
  material.color.set(COLOR_DEEP);
  material.transparent = true;
  material.opacity = WATER_OPACITY_BASE;
  material.metalness = WATER_METALNESS;
  material.roughness = WATER_ROUGHNESS;
  material.side = DoubleSide;
  material.depthWrite = false;

  const px = positionLocal.x;
  const py = positionLocal.y;
  const phase1 = add(mul(px, float(W.k1)), mul(time, float(W.w1)));
  const phase2 = add(mul(py, float(W.k2)), mul(time, float(W.w2)));
  const wave = add(mul(sin(phase1), float(W.a1)), mul(cos(phase2), float(W.a2)));
  material.positionNode = positionLocal.add(vec3(0, 0, wave));

  // Analytic normal of the displaced surface (plane lies in local XY, +Z up).
  const dzdx = mul(cos(phase1), float(W.a1 * W.k1));
  const dzdy = mul(sin(phase2), float(-W.a2 * W.k2));
  material.normalNode = transformNormalToView(vec3(dzdx.negate(), dzdy.negate(), 1).normalize());

  const shallow = color(COLOR_SHALLOW);
  const deep = color(COLOR_DEEP);
  // Wave lifts the surface toward the shallow tint.
  material.colorNode = mix(deep, shallow, wave.mul(4.0).add(0.35).clamp());

  // Fresnel-ish: more opaque / reflective at grazing angles.
  const ndv = normalView.dot(positionViewDirection).abs().clamp();
  const fresnel = float(1).sub(ndv).pow(3.0);
  material.opacityNode = mix(float(WATER_OPACITY_BASE), float(WATER_OPACITY_GRAZING), fresnel);

  return material;
}

function makeGlslMaterial(THREE) {
  // Same lit PBR material as the WebGPU path (MeshStandardMaterial), with the
  // vertex displacement, normal, tint and opacity patched in via onBeforeCompile.
  const material = new THREE.MeshStandardMaterial({
    color: COLOR_DEEP,
    transparent: true,
    opacity: WATER_OPACITY_BASE,
    metalness: WATER_METALNESS,
    roughness: WATER_ROUGHNESS,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const uniforms = {
    uTime: { value: 0 },
    uColorDeep: { value: new THREE.Color(COLOR_DEEP) },
    uColorShallow: { value: new THREE.Color(COLOR_SHALLOW) },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        varying float vWave;
        float waveAt(vec2 p) {
          return sin(p.x * ${W.k1.toFixed(2)} + uTime * ${W.w1.toFixed(2)}) * ${W.a1.toFixed(3)}
               + cos(p.y * ${W.k2.toFixed(2)} + uTime * ${W.w2.toFixed(2)}) * ${W.a2.toFixed(3)};
        }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `float dzdx = cos(position.x * ${W.k1.toFixed(2)} + uTime * ${W.w1.toFixed(2)}) * ${(W.a1 * W.k1).toFixed(4)};
        float dzdy = -sin(position.y * ${W.k2.toFixed(2)} + uTime * ${W.w2.toFixed(2)}) * ${(W.a2 * W.k2).toFixed(4)};
        vec3 objectNormal = normalize(vec3(-dzdx, -dzdy, 1.0));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3( tangent.xyz );
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWave = waveAt(position.xy);
        transformed.z += vWave;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uColorDeep;
        uniform vec3 uColorShallow;
        varying float vWave;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb = mix(uColorDeep, uColorShallow, clamp(vWave * 4.0 + 0.35, 0.0, 1.0));`,
      )
      .replace(
        '#include <opaque_fragment>',
        `// Fresnel-ish: more opaque at grazing angles.
        float ndv = abs(dot(normalize(normal), normalize(vViewPosition)));
        float fresnel = pow(1.0 - clamp(ndv, 0.0, 1.0), 3.0);
        diffuseColor.a = mix(${WATER_OPACITY_BASE.toFixed(2)}, ${WATER_OPACITY_GRAZING.toFixed(2)}, fresnel);
        #include <opaque_fragment>`,
      );
  };

  material.userData.update = (timeSec) => {
    uniforms.uTime.value = timeSec;
  };
  return material;
}

function makeBasicFallback(THREE) {
  return new THREE.MeshStandardMaterial({
    color: COLOR_DEEP,
    transparent: true,
    opacity: WATER_OPACITY_BASE,
    roughness: WATER_ROUGHNESS,
    metalness: WATER_METALNESS,
    depthWrite: false,
  });
}
