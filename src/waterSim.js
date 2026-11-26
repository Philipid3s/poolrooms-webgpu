/**
 * WebGPU-only interactive water: a height-field wave simulation run in a
 * TSL compute shader, rendered by displacing one merged grid mesh.
 *
 * Simulation
 *   One N x N grid per pool, all pools packed in two storage buffers (A, B).
 *   Discrete 2D wave equation with damping:
 *     next = (2 - 4c^2) h + c^2 (hN + hS + hE + hW) - prev
 *   Each dispatch reads neighbours from one buffer and overwrites the
 *   *previous* heights in the other buffer in place (each thread only
 *   writes its own cell), so there is no read/write race. Steps always run
 *   in pairs (A->B, then B->A), so the latest heights are always in A.
 *   Pool edges are reflective (neighbour indices are clamped to the pool).
 *   The step rate is fixed (STEP_HZ) and independent of the frame rate.
 *
 * Disturbances
 *   - wakes of up to two waders (the player and the threat),
 *   - occasional drips from the ceiling (seeded, deterministic per map).
 *
 * Rendering
 *   The mesh's vertex order matches the grid layout, so the vertex shader
 *   reads its height at storage index = vertex_index. Normals come from
 *   central differences of neighbouring heights. A small analytic swell
 *   (the same two sine waves as the plain water) is added on top so the
 *   surface is never perfectly flat.
 */

import { WATER_Y, ROOM_SIZE, GRID_W, GRID_H } from './map.js';

export const GRID = 128; // cells per pool side
const STEP_HZ = 120; // simulation steps per second (run in pairs)
const MAX_PAIRS_PER_FRAME = 4; // avoid a spiral of death after a stall
const C2 = 0.15; // (wave speed * dt / cell)^2, must be < 0.5 for stability
const DAMPING = 0.995;
const WAKE_RADIUS = 0.3; // metres
const WAKE_STRENGTH = 0.006; // metres per step at full walking speed
const WAKE_HZ = 1.8; // the wake pulses (stride rhythm) so it emits rings
const DRIP_RADIUS = 0.22;
const DRIP_STRENGTH = -0.06;
const NORMAL_GAIN = 2.5; // visual exaggeration of ripple slopes
const FOCUS_GAIN = 0.3; // caustic focusing: intensity = 1 / (1 + FOCUS_GAIN * laplacian)
const FOCUS_STENCIL = 2; // cells; a wider Laplacian stencil gives smoother light rings
const EDGE_INSET = 0.06; // gap between the water mesh and the pool wall

// Same ambient swell as the plain water (see water.js).
const W = { a1: 0.035, k1: 0.85, w1: 1.15, a2: 0.022, k2: 0.7, w2: 0.9 };

/**
 * @param {object} THREE three/webgpu namespace
 * @param {object} renderer WebGPURenderer
 * @param {{cx:number,cz:number,half:number}[]} pools
 * @param {object} look shared colours / opacity
 * @param {{poll(t:number):({pool:number,x:number,z:number}|null)}} drips
 */
export async function createComputeWater(THREE, renderer, pools, look, drips) {
  const tsl = await import('three/tsl');
  const {
    Fn, instanceIndex, vertexIndex, instancedArray, storage, uniform, int, float, vec2, vec3,
    select, max, min, mix, color, sin, cos, varying, positionLocal, transformNormalToView,
    normalView, positionViewDirection, uniformArray,
  } = tsl;

  const group = new THREE.Group();
  group.name = 'water-sim';
  if (!pools.length) return { group, update() {}, label: 'none' };

  const N = GRID;
  const PER = N * N;
  const TOTAL = pools.length * PER;
  const width = pools[0].half * 2 - EDGE_INSET * 2;
  const cell = width / (N - 1);

  // ---- simulation -------------------------------------------------------
  const hA = instancedArray(TOTAL, 'float').setName('waterHeightA');
  const hB = instancedArray(TOTAL, 'float').setName('waterHeightB');

  // Disturbances, in grid units: (pool index, gx, gz, strength). pool < 0 = off.
  const uWake = uniform(new THREE.Vector4(-1, 0, 0, 0));
  const uWake2 = uniform(new THREE.Vector4(-1, 0, 0, 0));
  const uDrip = uniform(new THREE.Vector4(-1, 0, 0, 0));
  const wakeRadius = float(WAKE_RADIUS / cell);
  const dripRadius = float(DRIP_RADIUS / cell);

  const cellIndex = (base, x, z) =>
    base.add(min(max(z, int(0)), int(N - 1)).mul(N)).add(min(max(x, int(0)), int(N - 1)));

  const splat = (d, radius, pool, gx, gz) => {
    const dist = vec2(gx, gz).sub(vec2(d.y, d.z)).length();
    const fall = max(float(1).sub(dist.div(radius)), 0);
    return select(pool.equal(d.x), fall.mul(fall).mul(d.w), float(0));
  };

  const makeStep = (cur, prev) =>
    Fn(() => {
      const i = int(instanceIndex);
      const pool = i.div(PER);
      const base = pool.mul(PER);
      const local = i.sub(base);
      const iz = local.div(N);
      const ix = local.sub(iz.mul(N));

      const h = cur.element(i);
      const sum = cur.element(cellIndex(base, ix.add(1), iz))
        .add(cur.element(cellIndex(base, ix.sub(1), iz)))
        .add(cur.element(cellIndex(base, ix, iz.add(1))))
        .add(cur.element(cellIndex(base, ix, iz.sub(1))));

      const next = h.mul(2 - 4 * C2).add(sum.mul(C2)).sub(prev.element(i)).mul(DAMPING).toVar();

      const poolF = float(pool);
      const gx = float(ix);
      const gz = float(iz);
      next.addAssign(splat(uWake, wakeRadius, poolF, gx, gz));
      next.addAssign(splat(uWake2, wakeRadius, poolF, gx, gz));
      next.addAssign(splat(uDrip, dripRadius, poolF, gx, gz));

      prev.element(i).assign(next);
    })().compute(TOTAL);

  const stepAB = makeStep(hA, hB); // reads A, writes next into B
  const stepBA = makeStep(hB, hA); // reads B, writes next into A

  // ---- rendering --------------------------------------------------------
  const geometry = buildGridGeometry(THREE, pools, N, width);

  // Separate read-only view of buffer A for the vertex stage (WebGPU does
  // not allow read_write storage buffers in vertex shaders).
  const heights = storage(hA.value, 'float', TOTAL).toReadOnly();
  const uTime = uniform(0);

  const material = new THREE.MeshStandardNodeMaterial();
  material.color.set(look.deep);
  material.transparent = true;
  material.metalness = look.metalness;
  material.roughness = look.roughness;
  material.side = THREE.DoubleSide;
  material.depthWrite = false;

  const vi = int(vertexIndex);
  const vPool = vi.div(PER);
  const vBase = vPool.mul(PER);
  const vLocal = vi.sub(vBase);
  const vz = vLocal.div(N);
  const vx = vLocal.sub(vz.mul(N));
  const simH = heights.element(vi);
  const dSimDx = heights.element(cellIndex(vBase, vx.add(1), vz))
    .sub(heights.element(cellIndex(vBase, vx.sub(1), vz)))
    .mul(NORMAL_GAIN / (2 * cell));
  const dSimDz = heights.element(cellIndex(vBase, vx, vz.add(1)))
    .sub(heights.element(cellIndex(vBase, vx, vz.sub(1))))
    .mul(NORMAL_GAIN / (2 * cell));

  // Ambient swell, analytic (world-space x / z).
  const px = positionLocal.x;
  const pz = positionLocal.z;
  const ph1 = px.mul(W.k1).add(uTime.mul(W.w1));
  const ph2 = pz.mul(W.k2).add(uTime.mul(W.w2));
  const swell = sin(ph1).mul(W.a1).add(cos(ph2).mul(W.a2));
  const dSwellDx = cos(ph1).mul(W.a1 * W.k1);
  const dSwellDz = sin(ph2).mul(-W.a2 * W.k2);

  const height = simH.add(swell);
  material.positionNode = positionLocal.add(vec3(0, height, 0));

  // Computed per vertex (needs vertex_index), interpolated to fragments.
  const vNormal = varying(vec3(dSimDx.add(dSwellDx).negate(), 1, dSimDz.add(dSwellDz).negate()).normalize());
  const vHeight = varying(height);
  material.normalNode = transformNormalToView(vNormal);

  // Crests lean to the shallow tint, troughs to the deep one.
  material.colorNode = mix(color(look.deep), color(look.shallow), vHeight.mul(5).add(0.35).clamp());

  const ndv = normalView.dot(positionViewDirection).abs().clamp();
  const fresnel = float(1).sub(ndv).pow(3);
  material.opacityNode = mix(float(look.opacity), float(look.opacityGrazing), fresnel);

  // ---- caustic focusing (used by caustics.js on the pool material) -------
  // Room grid -> pool index (-1 = no pool), to find the sim cell under a
  // world position in a fragment shader.
  const table = new Array(GRID_W * GRID_H).fill(-1);
  pools.forEach((p, k) => {
    table[p.j * GRID_W + p.i] = k;
  });
  const poolTable = uniformArray(table, 'float');
  const focusAt = (px, pz) => {
    const gi = min(max(int(px.div(ROOM_SIZE).round()), int(0)), int(GRID_W - 1));
    const gj = min(max(int(pz.div(ROOM_SIZE).round()), int(0)), int(GRID_H - 1));
    const k = poolTable.element(gj.mul(GRID_W).add(gi));
    const base = int(max(k, 0)).mul(PER);
    // Continuous grid coordinates; the Laplacian is bilinearly interpolated
    // between the four surrounding cells (nearest-cell sampling shows blocks).
    const fxc = px.sub(float(gi).mul(ROOM_SIZE).sub(width / 2)).div(cell);
    const fzc = pz.sub(float(gj).mul(ROOM_SIZE).sub(width / 2)).div(cell);
    const gx = int(fxc.floor());
    const gz = int(fzc.floor());
    const tx = fxc.fract();
    const tz = fzc.fract();
    const s = FOCUS_STENCIL;
    const at = (x, z) => heights.element(cellIndex(base, x, z));
    const lapAt = (x, z) =>
      at(x.add(s), z).add(at(x.sub(s), z)).add(at(x, z.add(s))).add(at(x, z.sub(s))).sub(at(x, z).mul(4));
    const lap = mix(
      mix(lapAt(gx, gz), lapAt(gx.add(1), gz), tx),
      mix(lapAt(gx, gz.add(1)), lapAt(gx.add(1), gz.add(1)), tx),
      tz,
    ).div((s * cell) ** 2);
    const focus = float(1).div(max(float(1).add(lap.mul(FOCUS_GAIN)), 0.3)).clamp(0, 3);
    return select(k.greaterThanEqual(0), focus, float(1));
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'water-sim';
  mesh.renderOrder = 1;
  mesh.frustumCulled = false; // vertices move on the GPU; bounds are approximate
  group.add(mesh);

  // ---- per-frame driving ------------------------------------------------
  let acc = 0;
  const setWake = (u, w, t, phase) => {
    if (w && w.pool >= 0 && w.speed > 0.05) {
      const g = toGrid(w.pool, w.x, w.z);
      const s = WAKE_STRENGTH * Math.min(1, w.speed / 3) * Math.sin(2 * Math.PI * WAKE_HZ * t + phase);
      u.value.set(w.pool, g.gx, g.gz, s);
    } else {
      u.value.set(-1, 0, 0, 0);
    }
  };
  const toGrid = (k, x, z) => ({
    gx: (x - (pools[k].cx - width / 2)) / cell,
    gz: (z - (pools[k].cz - width / 2)) / cell,
  });

  return {
    group,
    label: `compute sim ${pools.length}x${N}² @ ${STEP_HZ} Hz`,
    focusAt,
    /**
     * @param {number} t   seconds (drives the swell and the drip schedule)
     * @param {number} dt  frame delta, seconds
     * @param {{x:number,z:number,speed:number,pool:number}|null} wader  the player
     * @param {{x:number,z:number,speed:number,pool:number}|null} [wader2] the threat
     * @returns {{pool:number,x:number,z:number}|null} the drip that fell this frame
     */
    update(t, dt, wader, wader2 = null) {
      uTime.value = t;
      acc = Math.min(acc + Math.max(0, dt), MAX_PAIRS_PER_FRAME * 2 / STEP_HZ);

      const fell = drips.poll(t);
      let drip = fell ? { k: fell.pool, ...toGrid(fell.pool, fell.x, fell.z) } : null;

      setWake(uWake, wader, t, 0);
      setWake(uWake2, wader2, t, 1.3); // different stride phase

      while (acc >= 2 / STEP_HZ) {
        acc -= 2 / STEP_HZ;
        if (drip) {
          uDrip.value.set(drip.k, drip.gx, drip.gz, DRIP_STRENGTH);
        } else {
          uDrip.value.set(-1, 0, 0, 0);
        }
        renderer.compute(stepAB);
        uDrip.value.set(-1, 0, 0, 0);
        drip = null; // a drip is applied once
        renderer.compute(stepBA);
      }
      return fell;
    },
    /** Debug / test hook: read back simulation heights (A, latest). */
    async readHeights() {
      const buf = await renderer.getArrayBufferAsync(hA.value);
      return new Float32Array(buf);
    },
    /** Debug / test hook: drop a splash at a world position. */
    splash(x, z, strength = DRIP_STRENGTH) {
      const k = pools.findIndex((p) => Math.abs(x - p.cx) < p.half && Math.abs(z - p.cz) < p.half);
      if (k < 0) return false;
      const g = toGrid(k, x, z);
      uDrip.value.set(k, g.gx, g.gz, strength);
      renderer.compute(stepAB);
      uDrip.value.set(-1, 0, 0, 0);
      renderer.compute(stepBA);
      return true;
    },
  };
}

/**
 * One grid mesh for all pools, in world space (Y up). Vertex k of pool p is
 * at storage index p * N * N + k, matching the simulation layout.
 */
function buildGridGeometry(THREE, pools, N, width) {
  const PER = N * N;
  const pos = new Float32Array(pools.length * PER * 3);
  const nrm = new Float32Array(pools.length * PER * 3);
  const idx = new Uint32Array(pools.length * (N - 1) * (N - 1) * 6);
  let t = 0;
  pools.forEach((p, k) => {
    const base = k * PER;
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const v = base + iz * N + ix;
        pos[v * 3] = p.cx + (ix / (N - 1) - 0.5) * width;
        pos[v * 3 + 1] = WATER_Y;
        pos[v * 3 + 2] = p.cz + (iz / (N - 1) - 0.5) * width;
        nrm[v * 3 + 1] = 1;
      }
    }
    for (let iz = 0; iz < N - 1; iz++) {
      for (let ix = 0; ix < N - 1; ix++) {
        const a = base + iz * N + ix;
        const b = a + 1;
        const c = a + N;
        const d = c + 1;
        // Counter-clockwise seen from above (+Y).
        idx.set([a, c, b, b, c, d], t);
        t += 6;
      }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}
