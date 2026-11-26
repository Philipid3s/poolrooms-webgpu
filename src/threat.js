/**
 * A hostile presence that hunts the player through the rooms.
 *
 * Almost invisible: a tall, thin, dark silhouette you mostly glimpse at a
 * distance in the haze. Up close it fades and shimmers. It gives itself
 * away through the world: fluorescent lights flicker near it (lights.js),
 * you hear its wet steps and breathing (audio.js), and on WebGPU it makes
 * ripples when it wades through a pool (waterSim.js).
 *
 * Behaviour (a small state machine):
 *   dormant      grace period at the start, far from the player
 *   wander       roams, drifting towards the player's area now and then
 *   investigate  heads to where it heard the player
 *   chase        sees the player: runs at them, lunges when close
 *   search       lost sight: goes to the last known position, looks around
 * Hearing: walking, running and wading make noise of different reach.
 * Sight: a line of sight not blocked by any wall, within range.
 * Navigation: shortest path over the room graph (through doorways), then
 * straight lines inside rooms (rooms are convex).
 *
 * Deterministic per seed (its own seeded RNG), except for the player.
 */

import { ROOM_SIZE, GRID_W, GRID_H, POOL_FLOOR_Y, roomCenterX, roomCenterZ, roomNeighbors, poolAt } from './map.js';
import { mulberry32 } from './rng.js';

const GRACE_SEC = 15;
const SPEED = { wander: 1.7, investigate: 2.8, chase: 5.0, search: 2.4 };
const LUNGE_SPEED = 6.2; // when very close during a chase
const LUNGE_DIST = 5;
const WADE_FACTOR = 0.7;
const SIGHT_RANGE = 24;
const LOSE_SIGHT_SEC = 1.2; // chase continues this long without seeing the player
const HEARING = { walk: 6, run: 16, wade: 10 }; // metres
const CATCH_DIST = 0.85;
const SEARCH_SEC = 10;
const REPLAN_SEC = 0.25;
const STEP_INTERVAL = { slow: 0.78, fast: 0.42 };
const HEIGHT = 2.3;
const DOOR_APPROACH = 1.0; // metres before/after a doorway centre

/**
 * @param {object} THREE
 * @param {{map:object, scene:object, seed:number}} opts
 */
export function createThreat(THREE, { map, scene, seed }) {
  const rng = mulberry32((seed ^ 0x7e11) >>> 0);

  // Spawn in the room farthest (in doorways) from the player's spawn.
  const start = roomOf(map.spawn.x, map.spawn.z);
  const far = farthestRoom(map.doors, start);
  const pos = { x: roomCenterX(far.i), z: roomCenterZ(far.j) };

  let mode = 'dormant';
  let elapsed = 0;
  let waypoints = [];
  let goal = null;
  let replanIn = 0;
  let lastSeen = -Infinity;
  let lastKnown = null;
  let searchUntil = 0;
  let idleUntil = 0;
  let stepClock = 0;
  let speedNow = 0;
  let heading = 0;

  const body = buildBody(THREE);
  body.visible = false;
  scene.add(body);

  function setGoal(x, z) {
    goal = { x, z };
    waypoints = planRoute(map.doors, pos, goal);
  }

  function pickWanderGoal(player) {
    // Drift towards the player's area 40 % of the time, so a quiet player
    // is not left alone forever; otherwise a room one or two doors away.
    let room;
    if (rng() < 0.4) {
      const pr = roomOf(player.x, player.z);
      const options = [pr, ...roomNeighbors(map.doors, pr.i, pr.j)];
      room = options[Math.floor(rng() * options.length)];
    } else {
      room = randomRoomNear(map.doors, roomOf(pos.x, pos.z), 1 + Math.floor(rng() * 2), rng);
    }
    const inset = ROOM_SIZE / 2 - 2;
    setGoal(roomCenterX(room.i) + (rng() * 2 - 1) * inset, roomCenterZ(room.j) + (rng() * 2 - 1) * inset);
  }

  function canSee(player) {
    const d = Math.hypot(player.x - pos.x, player.z - pos.z);
    if (d > SIGHT_RANGE) return false;
    for (const b of map.colliders) {
      if (segmentHitsBox(pos.x, pos.z, player.x, player.z, b)) return false;
    }
    return true;
  }

  function noiseRadius(player) {
    if (player.speed < 0.3) return 0;
    if (player.inWater) return HEARING.wade;
    return player.speed > 6 ? HEARING.run : HEARING.walk;
  }

  return {
    get mode() {
      return mode;
    },
    get position() {
      return pos;
    },
    /**
     * @param {number} dt
     * @param {number} t
     * @param {{x:number,z:number,speed:number,inWater:boolean}} player
     * @param {object} camera for the silhouette's visibility
     * @returns {{x:number,z:number,mode:string,speed:number,inWater:boolean,pool:number,
     *            distance:number,step:boolean,chaseStart:boolean,caught:boolean,active:boolean}}
     */
    update(dt, t, player, camera) {
      elapsed += dt;
      const events = { step: false, chaseStart: false, caught: false };
      const dist = Math.hypot(player.x - pos.x, player.z - pos.z);

      if (mode === 'dormant') {
        if (elapsed >= GRACE_SEC) {
          mode = 'wander';
          pickWanderGoal(player);
        }
      } else {
        // --- perception ---
        if (canSee(player)) {
          if (mode !== 'chase') events.chaseStart = true;
          mode = 'chase';
          lastSeen = elapsed;
          lastKnown = { x: player.x, z: player.z };
        } else if (mode === 'chase' && elapsed - lastSeen > LOSE_SIGHT_SEC) {
          mode = 'search';
          setGoal(lastKnown.x, lastKnown.z);
          searchUntil = Infinity;
        } else if (mode !== 'chase' && dist < noiseRadius(player)) {
          // Heard something: go and look, slightly off the exact spot.
          mode = 'investigate';
          lastKnown = { x: player.x + (rng() * 2 - 1) * 1.5, z: player.z + (rng() * 2 - 1) * 1.5 };
          setGoal(lastKnown.x, lastKnown.z);
        }

        if (mode === 'chase') {
          replanIn -= dt;
          if (replanIn <= 0) {
            replanIn = REPLAN_SEC;
            setGoal(player.x, player.z);
          }
        }

        // --- movement ---
        let speed = SPEED[mode] ?? SPEED.wander;
        if (mode === 'chase' && dist < LUNGE_DIST) speed = LUNGE_SPEED;
        const inWater = Boolean(poolAt(map.pools, pos.x, pos.z));
        if (inWater) speed *= WADE_FACTOR;

        speedNow = 0;
        if (elapsed >= idleUntil && waypoints.length) {
          const w = waypoints[0];
          const dx = w.x - pos.x;
          const dz = w.z - pos.z;
          const len = Math.hypot(dx, dz);
          const stepLen = speed * dt;
          if (len <= stepLen) {
            pos.x = w.x;
            pos.z = w.z;
            waypoints.shift();
          } else {
            pos.x += (dx / len) * stepLen;
            pos.z += (dz / len) * stepLen;
          }
          if (len > 1e-3) heading = Math.atan2(dx, dz);
          speedNow = speed;
        }

        // --- arrival ---
        if (!waypoints.length && mode !== 'chase') {
          if (mode === 'investigate' || (mode === 'search' && searchUntil === Infinity)) {
            mode = 'search';
            searchUntil = elapsed + SEARCH_SEC;
            idleUntil = elapsed + 0.8 + rng() * 1.2; // stands still, listening
          }
          if (mode === 'search' && elapsed > searchUntil) mode = 'wander';
          if (elapsed >= idleUntil) {
            if (mode === 'search') {
              // Look around the nearby rooms.
              const r = randomRoomNear(map.doors, roomOf(pos.x, pos.z), 1, rng);
              setGoal(roomCenterX(r.i) + (rng() * 2 - 1) * 3, roomCenterZ(r.j) + (rng() * 2 - 1) * 3);
            } else {
              if (rng() < 0.35) idleUntil = elapsed + 1 + rng() * 2.5;
              pickWanderGoal(player);
            }
          }
        }

        // --- footsteps ---
        if (speedNow > 0) {
          stepClock += dt;
          const interval = speedNow > 3 ? STEP_INTERVAL.fast : STEP_INTERVAL.slow;
          if (stepClock >= interval) {
            stepClock -= interval;
            events.step = true;
          }
        }

        if (dist < CATCH_DIST) events.caught = true;
      }

      updateBody(body, pos, heading, mode, camera, elapsed, map);
      const pool = poolAt(map.pools, pos.x, pos.z);
      return {
        x: pos.x,
        z: pos.z,
        mode,
        speed: speedNow,
        inWater: Boolean(pool),
        pool: pool ? pool.index : -1,
        distance: dist,
        active: mode !== 'dormant',
        ...events,
      };
    },
  };
}

// --- body ------------------------------------------------------------------

function buildBody(THREE) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x050403,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    fog: true,
  });
  const group = new THREE.Group();
  group.name = 'threat';
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.22, 1.55, 10), mat);
  torso.position.y = 1.35;
  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.06, 0.75, 8), mat);
  legs.position.y = 0.38;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), mat);
  head.scale.set(0.85, 1.25, 0.9);
  head.position.y = HEIGHT - 0.17;
  const armGeo = new THREE.CylinderGeometry(0.04, 0.025, 1.35, 6);
  const armL = new THREE.Mesh(armGeo, mat);
  armL.position.set(-0.27, 1.32, 0);
  armL.rotation.z = 0.06;
  const armR = new THREE.Mesh(armGeo, mat);
  armR.position.set(0.27, 1.32, 0);
  armR.rotation.z = -0.06;
  group.add(torso, legs, head, armL, armR);
  group.userData.material = mat;
  return group;
}

function updateBody(body, pos, heading, mode, camera, t, map) {
  if (mode === 'dormant') {
    body.visible = false;
    return;
  }
  body.visible = true;
  const mat = body.userData.material;
  const d = Math.hypot(camera.position.x - pos.x, camera.position.z - pos.z);

  // Visible as a silhouette at mid range; fades and shimmers up close,
  // with occasional dropouts, so you are never quite sure it is there.
  const mid = smoothstep(3, 9, d) * (1 - smoothstep(20, 30, d));
  const shimmer = 0.75 + 0.25 * Math.sin(t * 23.0) * Math.sin(t * 7.3);
  const dropout = hash1(Math.floor(t * 9)) < 0.08 ? 0 : 1;
  mat.opacity = Math.max(0, (0.12 + 0.7 * mid) * shimmer * dropout);

  // A slight unnatural jitter, and it sinks to the pool floor when wading.
  const jx = (hash1(Math.floor(t * 30)) - 0.5) * 0.04;
  const jz = (hash1(Math.floor(t * 30) + 17) - 0.5) * 0.04;
  const y = poolAt(map.pools, pos.x, pos.z) ? POOL_FLOOR_Y : 0;
  body.position.set(pos.x + jx, y, pos.z + jz);
  body.rotation.y = heading;
}

// --- navigation ------------------------------------------------------------

function roomOf(x, z) {
  return {
    i: Math.min(GRID_W - 1, Math.max(0, Math.round(x / ROOM_SIZE))),
    j: Math.min(GRID_H - 1, Math.max(0, Math.round(z / ROOM_SIZE))),
  };
}

const key = (r) => r.j * GRID_W + r.i;

function bfs(doors, from) {
  const prev = new Map([[key(from), null]]);
  const dist = new Map([[key(from), 0]]);
  const queue = [from];
  while (queue.length) {
    const r = queue.shift();
    for (const n of roomNeighbors(doors, r.i, r.j)) {
      if (prev.has(key(n))) continue;
      prev.set(key(n), r);
      dist.set(key(n), dist.get(key(r)) + 1);
      queue.push(n);
    }
  }
  return { prev, dist };
}

function farthestRoom(doors, from) {
  const { dist } = bfs(doors, from);
  let best = from;
  let bestD = -1;
  for (const [k, d] of dist) {
    if (d > bestD) {
      bestD = d;
      best = { i: k % GRID_W, j: Math.floor(k / GRID_W) };
    }
  }
  return best;
}

function randomRoomNear(doors, from, steps, rng) {
  let r = from;
  for (let s = 0; s < steps; s++) {
    const n = roomNeighbors(doors, r.i, r.j);
    if (!n.length) break;
    r = n[Math.floor(rng() * n.length)];
  }
  return r;
}

/**
 * Waypoints along the room path: for each doorway, a point 1 m before it,
 * its centre and a point 1 m after it (so doorways are crossed head-on and
 * the door frame is never clipped), then the goal.
 */
function planRoute(doors, pos, goal) {
  const a = roomOf(pos.x, pos.z);
  const b = roomOf(goal.x, goal.z);
  if (key(a) === key(b)) return [goal];
  const { prev } = bfs(doors, a);
  if (!prev.has(key(b))) return [];
  const rooms = [];
  for (let r = b; r; r = prev.get(key(r))) rooms.unshift(r);
  const pts = [];
  for (let k = 0; k < rooms.length - 1; k++) {
    const r0 = rooms[k];
    const r1 = rooms[k + 1];
    const dx = Math.sign(r1.i - r0.i);
    const dz = Math.sign(r1.j - r0.j);
    const x = (roomCenterX(r0.i) + roomCenterX(r1.i)) / 2;
    const z = (roomCenterZ(r0.j) + roomCenterZ(r1.j)) / 2;
    // Skip the approach point if we are already between it and the doorway
    // (re-planning while crossing a doorway must not send us backwards).
    const along = (x - pos.x) * dx + (z - pos.z) * dz;
    if (k > 0 || along > DOOR_APPROACH) {
      pts.push({ x: x - dx * DOOR_APPROACH, z: z - dz * DOOR_APPROACH });
    }
    pts.push({ x, z });
    pts.push({ x: x + dx * DOOR_APPROACH, z: z + dz * DOOR_APPROACH });
  }
  pts.push(goal);
  return pts;
}

/** 2D segment vs axis-aligned box (slab test). */
function segmentHitsBox(ax, az, bx, bz, b) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  const slabs = [
    [dx, ax, b.minX, b.maxX],
    [dz, az, b.minZ, b.maxZ],
  ];
  for (const [d, o, lo, hi] of slabs) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
    } else {
      let ta = (lo - o) / d;
      let tb = (hi - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothstep(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
