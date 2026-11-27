/**
 * Seeded grid of tiled rooms with openings and occasional indoor pools.
 * Same seed always produces the same layout and spawn point.
 */

import { mulberry32 } from './rng.js';
import { createTileTexture } from './tiles.js';
import { createBoxBatch } from './boxbatch.js';

export const ROOM_SIZE = 12;
export const WALL_HEIGHT = 4.4;
export const WALL_THICKNESS = 0.28;
export const DOOR_WIDTH = 3.2;
export const DOOR_HEIGHT = 3.15;
export const GRID_W = 5;
export const GRID_H = 5;
export const POOL_MARGIN = 1.55;
export const POOL_BOTTOM = -0.86; // underside of the pool floor slab (its top is at -0.78)
export const POOL_FLOOR_Y = POOL_BOTTOM + 0.08; // walkable pool floor
export const WATER_Y = -0.28; // still water surface
export const POOL_HALF = (ROOM_SIZE - POOL_MARGIN * 2) / 2; // half-size of the pool opening
export const TILE_METERS = 2; // one texture repeat = 2 m (8 tiles of 25 cm)

/**
 * @returns {{
 *   group: object,
 *   colliders: {minX:number,maxX:number,minZ:number,maxZ:number}[],
 *   spawn: {x:number,z:number,yaw:number},
 *   poolRooms: {i:number,j:number}[],
 *   pools: {i:number,j:number,cx:number,cz:number,half:number}[],
 *   exit: {x:number,z:number,nx:number,nz:number,i:number,j:number},
 * }}
 */
export function buildMap(THREE, seed) {
  const rng = mulberry32(seed);
  const group = new THREE.Group();
  group.name = 'poolrooms-map';
  const colliders = [];

  // Floors and walls use world-space UVs (1 repeat per TILE_METERS), so the
  // textures need no per-mesh repeat.
  const floorTex = createTileTexture(THREE, { hue: 44, variation: 12, grout: '#c4b06c' });
  const wallTex = createTileTexture(THREE, { hue: 46, variation: 9, grout: '#d2c086' });
  const ceilTex = createTileTexture(THREE, { hue: 42, variation: 6, grout: '#cbb887' });
  ceilTex.repeat.set((GRID_W * ROOM_SIZE) / TILE_METERS, (GRID_H * ROOM_SIZE) / TILE_METERS);

  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 0.5,
    metalness: 0.02,
    color: 0xffffff,
  });
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTex,
    roughness: 0.38,
    metalness: 0.02,
    color: 0xf3ead0,
  });
  const ceilMat = new THREE.MeshStandardMaterial({
    map: ceilTex,
    roughness: 0.7,
    metalness: 0.0,
    color: 0xddd3b3,
  });
  const curbMat = new THREE.MeshStandardMaterial({
    color: 0xe8dcb0,
    roughness: 0.45,
    metalness: 0.0,
  });
  // Node material on WebGPU so caustics can be attached (caustics.js).
  const PoolMaterial = THREE.MeshStandardNodeMaterial ?? THREE.MeshStandardMaterial;
  const poolBottomMat = new PoolMaterial({
    color: 0x6e8a6a,
    roughness: 0.55,
    metalness: 0.05,
  });

  // Spanning tree of openings, then a few extra doors so it feels like halls, not a maze.
  const hDoors = Array.from({ length: GRID_H }, () => Array(GRID_W - 1).fill(false));
  const vDoors = Array.from({ length: GRID_H - 1 }, () => Array(GRID_W).fill(false));
  carveMaze(rng, hDoors, vDoors);
  addExtraDoors(rng, hDoors, vDoors, 0.32);

  const poolRooms = pickPoolRooms(rng);

  const batches = {
    floor: createBoxBatch(TILE_METERS),
    wall: createBoxBatch(TILE_METERS),
    curb: createBoxBatch(TILE_METERS),
    pool: createBoxBatch(TILE_METERS),
  };

  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      const cx = roomCenterX(i);
      const cz = roomCenterZ(j);
      const isPool = poolRooms.some((p) => p.i === i && p.j === j);
      addRoomFloor(batches, cx, cz, isPool);
    }
  }

  // Vertical walls (constant x), between rooms and on the outer boundary.
  for (let j = 0; j < GRID_H; j++) {
    for (let e = 0; e <= GRID_W; e++) {
      const x = e * ROOM_SIZE - ROOM_SIZE / 2;
      const z0 = j * ROOM_SIZE - ROOM_SIZE / 2;
      const z1 = z0 + ROOM_SIZE;
      const isOuter = e === 0 || e === GRID_W;
      const open = !isOuter && hDoors[j][e - 1];
      addWallWithDoor(batches.wall, colliders, {
        axis: 'z',
        a: x,
        b0: z0,
        b1: z1,
        open,
      });
    }
  }

  // Horizontal walls (constant z).
  for (let i = 0; i < GRID_W; i++) {
    for (let e = 0; e <= GRID_H; e++) {
      const z = e * ROOM_SIZE - ROOM_SIZE / 2;
      const x0 = i * ROOM_SIZE - ROOM_SIZE / 2;
      const x1 = x0 + ROOM_SIZE;
      const isOuter = e === 0 || e === GRID_H;
      const open = !isOuter && vDoors[e - 1][i];
      addWallWithDoor(batches.wall, colliders, {
        axis: 'x',
        a: z,
        b0: x0,
        b1: x1,
        open,
      });
    }
  }

  // One mesh (= one draw call) per material.
  const merged = [
    ['floors', batches.floor, floorMat],
    ['walls', batches.wall, wallMat],
    ['curbs', batches.curb, curbMat],
    ['pools', batches.pool, poolBottomMat],
  ];
  for (const [name, batch, mat] of merged) {
    if (!batch.count) continue;
    const mesh = new THREE.Mesh(batch.build(THREE), mat);
    mesh.name = name;
    group.add(mesh);
  }

  addCeiling(THREE, group, ceilMat);

  // Start in the dry room closest to the center of the grid.
  const spawn = nearestDryRoom(poolRooms, Math.floor(GRID_W / 2), Math.floor(GRID_H / 2));

  // The way out: a door in the dry room farthest (in doorways) from the spawn.
  const doors = { h: hDoors, v: vDoors };
  const exitRoom = farthestDryRoom(doors, poolRooms, spawn);
  const exit = placeExit(doors, exitRoom);
  group.add(buildExitDoor(THREE, exit));

  return {
    group,
    colliders,
    spawn: { x: roomCenterX(spawn.i), z: roomCenterZ(spawn.j), yaw: 0 },
    poolRooms,
    lightsAt: allRoomCenters(),
    pools: poolRooms.map((p) => ({ ...p, cx: roomCenterX(p.i), cz: roomCenterZ(p.j), half: POOL_HALF })),
    materials: { pool: poolBottomMat },
    // hDoors[j][i]: opening between (i, j) and (i + 1, j).
    // vDoors[j][i]: opening between (i, j) and (i, j + 1).
    doors,
    exit,
  };
}

/** Doorway distance from room `from` to every reachable room, keyed j * GRID_W + i. */
export function roomDistances(doors, from) {
  const dist = new Map([[from.j * GRID_W + from.i, 0]]);
  const queue = [from];
  while (queue.length) {
    const r = queue.shift();
    const d = dist.get(r.j * GRID_W + r.i);
    for (const n of roomNeighbors(doors, r.i, r.j)) {
      const k = n.j * GRID_W + n.i;
      if (dist.has(k)) continue;
      dist.set(k, d + 1);
      queue.push(n);
    }
  }
  return dist;
}

/** Deterministic: most doorways away, then farthest in a straight line, then row-major. */
function farthestDryRoom(doors, poolRooms, from) {
  const dist = roomDistances(doors, from);
  let best = null;
  let bestScore = -1;
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      if (poolRooms.some((p) => p.i === i && p.j === j)) continue;
      const d = dist.get(j * GRID_W + i);
      if (d === undefined) continue;
      const score = d * 100 + (i - from.i) ** 2 + (j - from.j) ** 2;
      if (score > bestScore) {
        bestScore = score;
        best = { i, j };
      }
    }
  }
  return best ?? from;
}

/**
 * Put the exit door flat against one wall of the room, facing inwards.
 * A closed wall is preferred (door centred); otherwise it goes on the wall
 * beside the doorway.
 */
function placeExit(doors, { i, j }) {
  const cx = roomCenterX(i);
  const cz = roomCenterZ(j);
  const face = ROOM_SIZE / 2 - WALL_THICKNESS / 2 - 0.04; // just off the wall face
  // n = inward normal; (tx, tz) = along the wall.
  const sides = [
    { open: i > 0 && doors.h[j][i - 1], nx: 1, nz: 0 }, // west wall
    { open: i < GRID_W - 1 && doors.h[j][i], nx: -1, nz: 0 }, // east wall
    { open: j > 0 && doors.v[j - 1][i], nx: 0, nz: 1 }, // north wall
    { open: j < GRID_H - 1 && doors.v[j][i], nx: 0, nz: -1 }, // south wall
  ];
  const side = sides.find((s) => !s.open) ?? sides[0];
  const along = side.open ? (DOOR_WIDTH / 2 + ROOM_SIZE / 2) / 2 : 0; // middle of the wall beside the doorway
  const tx = -side.nz;
  const tz = side.nx;
  return {
    i,
    j,
    x: cx - side.nx * face + tx * along,
    z: cz - side.nz * face + tz * along,
    nx: side.nx,
    nz: side.nz,
  };
}

/**
 * An emergency exit: a grey steel door with a push bar, and above it a
 * French-style "ISSUE DE SECOURS" light box (white housing, green panel,
 * running man heading for a door).
 */
function buildExitDoor(THREE, exit) {
  const g = new THREE.Group();
  g.name = 'exit';
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x8a8b84, roughness: 0.5, metalness: 0.4 });
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x9a9c94, roughness: 0.42, metalness: 0.45 });
  const barMat = new THREE.MeshStandardMaterial({ color: 0xc9cbc4, roughness: 0.25, metalness: 0.8 });
  const housingMat = new THREE.MeshStandardMaterial({ color: 0xeeebe2, roughness: 0.5, metalness: 0.0 });

  // One merged mesh per material (see boxbatch.js).
  const batches = new Map();
  const box = (w, h, d, mat, x, y, z) => {
    if (!batches.has(mat)) batches.set(mat, createBoxBatch(TILE_METERS));
    batches.get(mat).add(x, y, z, w, h, d);
  };

  // Frame (two jambs and a head) and the door leaf.
  box(0.09, 2.36, 0.08, frameMat, -0.7, 1.18, 0.04);
  box(0.09, 2.36, 0.08, frameMat, 0.7, 1.18, 0.04);
  box(1.49, 0.09, 0.08, frameMat, 0, 2.315, 0.04);
  box(1.31, 2.26, 0.05, doorMat, 0, 1.13, 0.05);
  // Push bar ("barre anti-panique") on two brackets.
  box(1.02, 0.07, 0.05, barMat, 0, 1.02, 0.15);
  box(0.06, 0.12, 0.09, barMat, -0.5, 1.02, 0.1);
  box(0.06, 0.12, 0.09, barMat, 0.5, 1.02, 0.1);
  // Kick plate.
  box(1.2, 0.22, 0.01, barMat, 0, 0.13, 0.08);

  // Emergency light box above the door, its face lit (unlit material).
  box(0.92, 0.38, 0.09, housingMat, 0, 2.72, 0.045);
  for (const [mat, batch] of batches) g.add(new THREE.Mesh(batch.build(THREE), mat));
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.84, 0.32),
    new THREE.MeshBasicMaterial({ map: exitSignTexture(THREE) }),
  );
  sign.position.set(0, 2.72, 0.092);
  g.add(sign);

  g.position.set(exit.x, 0, exit.z);
  g.rotation.y = Math.atan2(exit.nx, exit.nz); // local +z = inward normal
  return g;
}

/** Green panel: arrow, running man, door, then "ISSUE DE SECOURS". */
function exitSignTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 196;
  const ctx = c.getContext('2d');
  const green = '#0a9a4a';
  const white = '#f4fff6';
  ctx.fillStyle = green;
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.save();
  ctx.translate(76, 4);
  ctx.strokeStyle = white;
  ctx.fillStyle = white;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Arrow pointing to the door.
  ctx.lineWidth = 15;
  ctx.beginPath();
  ctx.moveTo(40, 74);
  ctx.lineTo(102, 74);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(132, 74);
  ctx.lineTo(98, 48);
  ctx.lineTo(98, 100);
  ctx.closePath();
  ctx.fill();

  // Running man.
  ctx.beginPath();
  ctx.arc(240, 30, 14, 0, Math.PI * 2);
  ctx.fill();
  const limb = (w, pts) => {
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
    ctx.stroke();
  };
  limb(20, [230, 52, 212, 94]); // torso
  limb(11, [229, 58, 252, 72, 272, 60]); // front arm
  limb(11, [226, 58, 202, 64, 186, 50]); // back arm
  limb(13, [212, 94, 238, 106, 244, 134]); // front leg
  limb(13, [212, 94, 196, 116, 168, 120]); // back leg

  // Door: white frame around a green opening.
  ctx.fillRect(292, 16, 72, 124);
  ctx.fillStyle = green;
  ctx.fillRect(304, 28, 48, 112);
  ctx.restore();

  ctx.fillStyle = white;
  ctx.font = 'bold 34px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ISSUE DE SECOURS', c.width / 2, 172);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Pool containing (x, z), or null. `index` is the pool's position in
 * map.pools (also its slot in the water simulation).
 */
export function poolAt(pools, x, z) {
  for (let k = 0; k < pools.length; k++) {
    const p = pools[k];
    if (Math.abs(x - p.cx) < p.half && Math.abs(z - p.cz) < p.half) return { index: k, pool: p };
  }
  return null;
}

/** Rooms reachable from (i, j) through an opening. */
export function roomNeighbors(doors, i, j) {
  const out = [];
  if (i > 0 && doors.h[j][i - 1]) out.push({ i: i - 1, j });
  if (i < GRID_W - 1 && doors.h[j][i]) out.push({ i: i + 1, j });
  if (j > 0 && doors.v[j - 1][i]) out.push({ i, j: j - 1 });
  if (j < GRID_H - 1 && doors.v[j][i]) out.push({ i, j: j + 1 });
  return out;
}

export function roomCenterX(i) {
  return i * ROOM_SIZE;
}

export function roomCenterZ(j) {
  return j * ROOM_SIZE;
}

function allRoomCenters() {
  const out = [];
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      out.push({ x: roomCenterX(i), z: roomCenterZ(j) });
    }
  }
  return out;
}

function nearestDryRoom(poolRooms, ci, cj) {
  // Deterministic: scan in row-major order and keep the first room at the
  // smallest squared distance, so ties always resolve the same way.
  let best = { i: ci, j: cj };
  let bestD = Infinity;
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      if (poolRooms.some((p) => p.i === i && p.j === j)) continue;
      const d = (i - ci) ** 2 + (j - cj) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { i, j };
      }
    }
  }
  return best;
}

function carveMaze(rng, hDoors, vDoors) {
  const visited = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(false));
  const stack = [{ i: 0, j: 0 }];
  visited[0][0] = true;
  while (stack.length) {
    const current = stack[stack.length - 1];
    const neighbors = [];
    if (current.i > 0 && !visited[current.j][current.i - 1]) neighbors.push({ i: current.i - 1, j: current.j, dir: 'w' });
    if (current.i < GRID_W - 1 && !visited[current.j][current.i + 1]) neighbors.push({ i: current.i + 1, j: current.j, dir: 'e' });
    if (current.j > 0 && !visited[current.j - 1][current.i]) neighbors.push({ i: current.i, j: current.j - 1, dir: 'n' });
    if (current.j < GRID_H - 1 && !visited[current.j + 1][current.i]) neighbors.push({ i: current.i, j: current.j + 1, dir: 's' });
    if (!neighbors.length) {
      stack.pop();
      continue;
    }
    const next = neighbors[Math.floor(rng() * neighbors.length)];
    if (next.dir === 'e') hDoors[current.j][current.i] = true;
    if (next.dir === 'w') hDoors[current.j][next.i] = true;
    if (next.dir === 's') vDoors[current.j][current.i] = true;
    if (next.dir === 'n') vDoors[next.j][current.i] = true;
    visited[next.j][next.i] = true;
    stack.push(next);
  }
}

function addExtraDoors(rng, hDoors, vDoors, chance) {
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W - 1; i++) {
      if (!hDoors[j][i] && rng() < chance) hDoors[j][i] = true;
    }
  }
  for (let j = 0; j < GRID_H - 1; j++) {
    for (let i = 0; i < GRID_W; i++) {
      if (!vDoors[j][i] && rng() < chance) vDoors[j][i] = true;
    }
  }
}

function pickPoolRooms(rng) {
  const rooms = [];
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      rooms.push({ i, j });
    }
  }
  // Shuffle, take a fixed count so the density is stable.
  for (let k = rooms.length - 1; k > 0; k--) {
    const n = Math.floor(rng() * (k + 1));
    const tmp = rooms[k];
    rooms[k] = rooms[n];
    rooms[n] = tmp;
  }
  const count = 7;
  return rooms.slice(0, count);
}

// Static geometry is collected per material and merged (see boxbatch.js).
function addRoomFloor(batches, cx, cz, isPool) {
  const half = ROOM_SIZE / 2;
  const slabH = 0.08;

  if (!isPool) {
    batches.floor.add(cx, -slabH / 2, cz, ROOM_SIZE, slabH, ROOM_SIZE);
    return;
  }

  const opening = ROOM_SIZE - POOL_MARGIN * 2;
  const deck = POOL_MARGIN;
  // Four deck slabs around the pool, plus a sunken bottom.
  batches.floor.add(cx, -slabH / 2, cz - half + deck / 2, ROOM_SIZE, slabH, deck);
  batches.floor.add(cx, -slabH / 2, cz + half - deck / 2, ROOM_SIZE, slabH, deck);
  batches.floor.add(cx - half + deck / 2, -slabH / 2, cz, deck, slabH, opening);
  batches.floor.add(cx + half - deck / 2, -slabH / 2, cz, deck, slabH, opening);

  batches.pool.add(cx, POOL_BOTTOM + 0.04, cz, opening, 0.08, opening);

  // Pit side walls, from the pool bottom up to the underside of the deck,
  // so you cannot see under the deck through the water.
  const pitT = 0.08;
  const pitTop = -slabH; // underside of the deck slab (no coplanar overlap)
  const pitBottom = POOL_BOTTOM;
  const pitH = pitTop - pitBottom;
  const pitY = (pitTop + pitBottom) / 2;
  const half2 = opening / 2 + pitT / 2;
  batches.pool.add(cx, pitY, cz - half2, opening + pitT * 2, pitH, pitT);
  batches.pool.add(cx, pitY, cz + half2, opening + pitT * 2, pitH, pitT);
  batches.pool.add(cx - half2, pitY, cz, pitT, pitH, opening);
  batches.pool.add(cx + half2, pitY, cz, pitT, pitH, opening);

  // Thin curb around the pool edge so the drop is readable. Not a collider:
  // you can step over it and wade into the pool.
  const curbH = 0.16;
  const curbT = 0.16;
  const inner = opening / 2;
  const curbs = [
    { w: opening + curbT * 2, d: curbT, x: cx, z: cz - inner - curbT / 2 },
    { w: opening + curbT * 2, d: curbT, x: cx, z: cz + inner + curbT / 2 },
    { w: curbT, d: opening, x: cx - inner - curbT / 2, z: cz },
    { w: curbT, d: opening, x: cx + inner + curbT / 2, z: cz },
  ];
  for (const c of curbs) {
    batches.curb.add(c.x, curbH / 2, c.z, c.w, curbH, c.d);
  }
}

function addWallWithDoor(batch, colliders, { axis, a, b0, b1, open }) {
  const mid = (b0 + b1) / 2;
  const doorHalf = DOOR_WIDTH / 2;

  const segments = open
    ? [
        { from: b0, to: mid - doorHalf },
        { from: mid + doorHalf, to: b1 },
      ]
    : [{ from: b0, to: b1 }];

  for (const seg of segments) {
    const len = seg.to - seg.from;
    if (len < 0.05) continue;
    const centerB = (seg.from + seg.to) / 2;
    addWallBox(batch, colliders, axis, a, centerB, len, WALL_HEIGHT, WALL_HEIGHT / 2);
  }

  if (open) {
    // Lintel above the doorway (no collider: it is above head height).
    const lintelH = WALL_HEIGHT - DOOR_HEIGHT;
    if (lintelH > 0.05) {
      addWallBox(batch, colliders, axis, a, mid, DOOR_WIDTH, lintelH, DOOR_HEIGHT + lintelH / 2, false);
    }
  }
}

function addWallBox(batch, colliders, axis, a, centerB, length, height, y, collide = true) {
  const w = axis === 'z' ? WALL_THICKNESS : length;
  const d = axis === 'z' ? length : WALL_THICKNESS;
  const x = axis === 'z' ? a : centerB;
  const z = axis === 'z' ? centerB : a;
  batch.add(x, y, z, w, height, d);
  if (collide) addBoxCollider(colliders, x, z, w, d);
}

function addCeiling(THREE, group, ceilMat) {
  const w = GRID_W * ROOM_SIZE;
  const h = GRID_H * ROOM_SIZE;
  const cx = (GRID_W - 1) * ROOM_SIZE / 2;
  const cz = (GRID_H - 1) * ROOM_SIZE / 2;
  const geo = new THREE.PlaneGeometry(w, h);
  const mesh = new THREE.Mesh(geo, ceilMat);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(cx, WALL_HEIGHT, cz);
  group.add(mesh);
}

function addBoxCollider(colliders, x, z, w, d) {
  colliders.push({
    minX: x - w / 2,
    maxX: x + w / 2,
    minZ: z - d / 2,
    maxZ: z + d / 2,
  });
}

