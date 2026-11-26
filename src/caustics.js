/**
 * Caustics on the pool floor and walls: the bright, wobbling network of
 * light lines that sunlight / lamplight makes after refracting through
 * a wavy surface.
 *
 * Procedural pattern, identical on both renderers (TSL on WebGPU, GLSL via
 * onBeforeCompile on WebGL): two layers of a domain-warped sine lattice;
 * each layer is bright only near the zero lines of sin(x)·sin(y), and the
 * warps make those lines wobble. Added as emission.
 *
 * On WebGPU with the compute water, the pattern is also modulated by the
 * simulated surface: where the surface curves like a lens (crests), light is
 * focused onto the floor below. Intensity ≈ 1 / (1 + G·∇²h), from the
 * height-field Laplacian under each floor point. So ripples you make show
 * up as moving rings of light on the bottom.
 */

const COLOR = [0.72, 1.0, 0.9];
const STRENGTH = 0.55;
const WALL_WEIGHT = 0.4; // vertical surfaces get less light
const ABOVE_WATER_WEIGHT = 0.25; // pool walls above the waterline (reflected light)

// Pattern constants (shared by both implementations).
const L1_SCALE = 3.5;
const L2_SCALE = 4.3;
const L2_ROT = [0.825, 0.565]; // cos, sin of ~0.6 rad
const L2_OFFSET = [4.1, 1.7];
const L2_SPEED = 1.15;

/**
 * @param {object} THREE
 * @param {'WebGPU'|'WebGL'} kind
 * @param {object} material pool material (node material on WebGPU)
 * @param {{waterY:number, focusAt?:Function}} opts focusAt(px, pz) -> TSL float node
 * @returns {Promise<{update(t:number):void}>}
 */
export async function applyCaustics(THREE, kind, material, { waterY, focusAt }) {
  if (kind === 'WebGPU' && material.isNodeMaterial) {
    return applyTsl(material, waterY, focusAt);
  }
  return applyGlsl(material, waterY);
}

async function applyTsl(material, waterY, focusAt) {
  const { uniform, float, vec2, vec3, sin, abs, pow, mix, select, max, positionWorld, normalWorld } =
    await import('three/tsl');

  const uTime = uniform(0);

  const layer = (p, t) => {
    const q1 = p.add(vec2(sin(p.y.mul(1.7).add(t.mul(0.9))), sin(p.x.mul(1.9).sub(t.mul(0.7)))).mul(0.55));
    const q2 = q1.add(vec2(sin(q1.y.mul(3.1).sub(t.mul(1.3))), sin(q1.x.mul(2.7).add(t.mul(1.1)))).mul(0.3));
    const v = sin(q2.x.mul(2.0)).mul(sin(q2.y.mul(2.0)));
    return pow(float(1).sub(abs(v)), 10);
  };

  // Floors use world (x, z). Walls use (along-wall, height), so the pattern
  // is not stretched into vertical streaks: x + z runs along any
  // axis-aligned wall because one of the two is constant on it.
  const isFloor = abs(normalWorld.y).greaterThan(0.5);
  const x = select(isFloor, positionWorld.x, positionWorld.x.add(positionWorld.z));
  const z = select(isFloor, positionWorld.z, positionWorld.y.mul(1.4));
  const p1 = vec2(x, z).mul(L1_SCALE);
  const p2 = vec2(
    x.mul(L2_ROT[0]).sub(z.mul(L2_ROT[1])),
    x.mul(L2_ROT[1]).add(z.mul(L2_ROT[0])),
  ).mul(L2_SCALE).add(vec2(L2_OFFSET[0], L2_OFFSET[1]));
  let intensity = layer(p1, uTime).add(layer(p2, uTime.mul(L2_SPEED))).clamp(0, 1.5);

  if (focusAt) {
    // Light focused by the simulated surface: scales the pattern and adds a
    // soft glow under strongly focusing crests.
    const focus = focusAt(positionWorld.x, positionWorld.z);
    intensity = intensity.mul(focus).add(max(focus.sub(1), 0).mul(0.35));
  }

  const weight = mix(float(WALL_WEIGHT), float(1), abs(normalWorld.y))
    .mul(select(positionWorld.y.lessThan(waterY), float(1), float(ABOVE_WATER_WEIGHT)));

  material.emissiveNode = vec3(...COLOR).mul(intensity).mul(weight).mul(STRENGTH);
  material.needsUpdate = true;

  return {
    update(t) {
      uTime.value = t;
    },
  };
}

function applyGlsl(material, waterY) {
  const uniforms = { uCausticTime: { value: 0 } };
  const f = (v) => v.toFixed(4);

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vCWorld;
        varying float vCNy;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vCWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vCNy = normalize(mat3(modelMatrix) * objectNormal).y;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uCausticTime;
        varying vec3 vCWorld;
        varying float vCNy;
        float causticLayer(vec2 p, float t) {
          vec2 q = p + 0.55 * vec2(sin(p.y * 1.7 + t * 0.9), sin(p.x * 1.9 - t * 0.7));
          q += 0.3 * vec2(sin(q.y * 3.1 - t * 1.3), sin(q.x * 2.7 + t * 1.1));
          float v = sin(q.x * 2.0) * sin(q.y * 2.0);
          return pow(1.0 - abs(v), 10.0);
        }
        float caustic(vec2 xz, float t) {
          vec2 p1 = xz * ${f(L1_SCALE)};
          vec2 p2 = vec2(xz.x * ${f(L2_ROT[0])} - xz.y * ${f(L2_ROT[1])},
                         xz.x * ${f(L2_ROT[1])} + xz.y * ${f(L2_ROT[0])}) * ${f(L2_SCALE)}
                    + vec2(${f(L2_OFFSET[0])}, ${f(L2_OFFSET[1])});
          return clamp(causticLayer(p1, t) + causticLayer(p2, t * ${f(L2_SPEED)}), 0.0, 1.5);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float w = mix(${f(WALL_WEIGHT)}, 1.0, abs(vCNy))
                  * (vCWorld.y < ${f(waterY)} ? 1.0 : ${f(ABOVE_WATER_WEIGHT)});
          // Floors: world (x, z). Walls: (along-wall, height), see applyTsl.
          vec2 cp = abs(vCNy) > 0.5 ? vCWorld.xz : vec2(vCWorld.x + vCWorld.z, vCWorld.y * 1.4);
          totalEmissiveRadiance += vec3(${COLOR.map(f).join(', ')})
                                 * caustic(cp, uCausticTime) * w * ${f(STRENGTH)};
        }`,
      );
  };
  material.needsUpdate = true;

  return {
    update(t) {
      uniforms.uCausticTime.value = t;
    },
  };
}
