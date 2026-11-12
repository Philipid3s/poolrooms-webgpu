/**
 * Seeded grid of tiled rooms with openings and occasional indoor pools.
 * Same seed always produces the same layout and spawn point.
 */

import { mulberry32 } from './rng.js';
import { createTileTexture } from './tiles.js';

export const ROOM_SIZE = 12;
export const WALL_HEIGHT = 4.4;
export const WALL_THICKNESS = 0.28;
export const DOOR_WIDTH = 3.2;
export const DOOR_HEIGHT = 3.15;
export const GRID_W = 5;
export const GRID_H = 5;
export const POOL_MARGIN = 1.55;

/**
 * @returns {{
 *   group: object,
 *   colliders: {minX:number,maxX:number,minZ:number,maxZ:number}[],
 *   spawn: {x:number,z:number,yaw:number},
 *   poolRooms: {i:number,j:number}[],
 * }}
 */
export function buildMap(THREE, seed) {
  const rng = mulberry32(seed);
  const group = new THREE.Group();
  group.name = 'poolrooms-map';
  const colliders = [];

  const floorTex = createTileTexture(THREE, { hue: 44, variation: 12, grout: '#c4b06c' });
  floorTex.repeat.set(ROOM_SIZE / 2, ROOM_SIZE / 2);
  const wallTex = createTileTexture(THREE, { hue: 46, variation: 9, grout: '#d2c086' });
  const ceilTex = createTileTexture(THREE, { hue: 42, variation: 6, grout: '#cbb887' });
  ceilTex.repeat.set((GRID_W * ROOM_SIZE) / 2, (GRID_H * ROOM_SIZE) / 2);

  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 0.28,
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
  const poolBottomMat = new THREE.MeshStandardMaterial({
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

  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      const cx = roomCenterX(i);
      const cz = roomCenterZ(j);
      const isPool = poolRooms.some((p) => p.i === i && p.j === j);
      addRoomFloor(THREE, group, floorMat, poolBottomMat, curbMat, colliders, cx, cz, isPool);
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
      addWallWithDoor(THREE, group, wallMat, wallTex, colliders, {
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
      addWallWithDoor(THREE, group, wallMat, wallTex, colliders, {
        axis: 'x',
        a: z,
        b0: x0,
        b1: x1,
        open,
      });
    }
  }

  addCeiling(THREE, group, ceilMat, ceilTex);

  const spawnRoom = { i: Math.floor(GRID_W / 2), j: Math.floor(GRID_H / 2) };
  // Prefer a non-pool room near the center for a dry start.
  let spawn = spawnRoom;
  if (poolRooms.some((p) => p.i === spawn.i && p.j === spawn.j)) {
    const dry = firstDryRoom(poolRooms);
    if (dry) spawn = dry;
  }

  return {
    group,
    colliders,
    spawn: { x: roomCenterX(spawn.i), z: roomCenterZ(spawn.j), yaw: 0 },
    poolRooms,
    lightsAt: allRoomCenters(),
  };
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

function firstDryRoom(poolRooms) {
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      if (!poolRooms.some((p) => p.i === i && p.j === j)) return { i, j };
    }
  }
  return null;
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

function addRoomFloor(THREE, group, floorMat, poolBottomMat, curbMat, colliders, cx, cz, isPool) {
  const half = ROOM_SIZE / 2;

  if (!isPool) {
    const geo = new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE);
    const mesh = new THREE.Mesh(geo, floorMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;
    group.add(mesh);
    return;
  }

  const opening = ROOM_SIZE - POOL_MARGIN * 2;
  const deck = POOL_MARGIN;
  // Four deck slabs around the pool, plus a sunken bottom.
  const slabs = [
    { w: ROOM_SIZE, d: deck, x: cx, z: cz - half + deck / 2 },
    { w: ROOM_SIZE, d: deck, x: cx, z: cz + half - deck / 2 },
    { w: deck, d: opening, x: cx - half + deck / 2, z: cz },
    { w: deck, d: opening, x: cx + half - deck / 2, z: cz },
  ];
  for (const s of slabs) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.w, 0.08, s.d), floorMat);
    mesh.position.set(s.x, -0.04, s.z);
    group.add(mesh);
  }

  const bottom = new THREE.Mesh(new THREE.BoxGeometry(opening, 0.08, opening), poolBottomMat);
  bottom.position.set(cx, -0.82, cz);
  group.add(bottom);

  // Thin curb around the pool edge so the drop is readable; also used as collision.
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
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(c.w, curbH, c.d), curbMat);
    mesh.position.set(c.x, curbH / 2, c.z);
    group.add(mesh);
    addBoxCollider(colliders, c.x, c.z, c.w, c.d);
  }
}

function addWallWithDoor(THREE, group, wallMat, wallTex, colliders, { axis, a, b0, b1, open }) {
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
    addWallBox(THREE, group, wallMat, wallTex, colliders, axis, a, centerB, len, WALL_HEIGHT, WALL_HEIGHT / 2);
  }

  if (open) {
    // Lintel above the doorway.
    const lintelH = WALL_HEIGHT - DOOR_HEIGHT;
    if (lintelH > 0.05) {
      addWallBox(
        THREE,
        group,
        wallMat,
        wallTex,
        colliders,
        axis,
        a,
        mid,
        DOOR_WIDTH,
        lintelH,
        DOOR_HEIGHT + lintelH / 2,
        false,
      );
    }
  }
}

function addWallBox(THREE, group, wallMat, wallTex, colliders, axis, a, centerB, length, height, y, collide = true) {
  const w = axis === 'z' ? WALL_THICKNESS : length;
  const d = axis === 'z' ? length : WALL_THICKNESS;
  const x = axis === 'z' ? a : centerB;
  const z = axis === 'z' ? centerB : a;
  const geo = new THREE.BoxGeometry(w, height, d);
  const map = wallTex.clone();
  map.repeat.set(length / 2, height / 2);
  map.needsUpdate = true;
  const mat = wallMat.clone();
  mat.map = map;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  group.add(mesh);
  if (collide) addBoxCollider(colliders, x, z, w, d);
}

function addCeiling(THREE, group, ceilMat, ceilTex) {
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

