/**
 * Collects axis-aligned boxes and builds them into ONE BufferGeometry, so a
 * whole category of static geometry (all walls, all floors...) is a single
 * draw call.
 *
 * UVs are world-space (planar per face): u/v = world coordinate / tileMeters.
 * Tiles therefore have the same size on every surface and line up across
 * neighbouring boxes, with no per-box texture clones or repeat settings.
 *
 * Written by hand rather than with BufferGeometryUtils, because addons import
 * from `three` and must not be mixed with objects from `three/webgpu`.
 */

// For each face: outward normal n, and tangent axes a, b with a x b = n
// (so the quad (-,-) (+,-) (+,+) (-,+) is counter-clockwise seen from outside).
const FACES = [
  { n: [1, 0, 0], a: [0, 0, -1], b: [0, 1, 0] },
  { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0] },
  { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, -1] },
  { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
  { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
  { n: [0, 0, -1], a: [-1, 0, 0], b: [0, 1, 0] },
];
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

export function createBoxBatch(tileMeters = 2) {
  const boxes = [];
  return {
    get count() {
      return boxes.length;
    },
    /** Box centred at (x, y, z) with full sizes w (x), h (y), d (z). */
    add(x, y, z, w, h, d) {
      boxes.push({ c: [x, y, z], half: [w / 2, h / 2, d / 2] });
    },
    build(THREE) {
      const vCount = boxes.length * 24;
      const pos = new Float32Array(vCount * 3);
      const nrm = new Float32Array(vCount * 3);
      const uv = new Float32Array(vCount * 2);
      const idx = new Uint32Array(boxes.length * 36);
      let v = 0;
      let t = 0;
      for (const { c, half } of boxes) {
        for (const f of FACES) {
          const base = v;
          for (const [sa, sb] of CORNERS) {
            const p = [0, 0, 0];
            for (let k = 0; k < 3; k++) {
              // |a[k]|, |b[k]|, |n[k]| select which half-extent applies on axis k.
              p[k] = c[k] + (f.n[k] + f.a[k] * sa + f.b[k] * sb) * half[k];
            }
            pos.set(p, v * 3);
            nrm.set(f.n, v * 3);
            uv[v * 2] = dot(p, f.a) / tileMeters;
            uv[v * 2 + 1] = dot(p, f.b) / tileMeters;
            v++;
          }
          idx.set([base, base + 1, base + 2, base, base + 2, base + 3], t);
          t += 6;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      return geo;
    },
  };
}

function dot(p, a) {
  return p[0] * a[0] + p[1] * a[1] + p[2] * a[2];
}
