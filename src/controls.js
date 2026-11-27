/**
 * First-person look + WASD. Implemented locally so the same code works
 * with objects from either the `three` or `three/webgpu` entry (addons
 * import from `three` and must not be mixed with the WebGPU build).
 */

const LOOK_SENSITIVITY = 0.0022;
const MOVE_SPEED = 5.4;
const PLAYER_RADIUS = 0.32;
const EYE_HEIGHT = 1.62;
const PITCH_LIMIT = Math.PI / 2 - 0.05;
const WADE_SPEED_FACTOR = 0.55; // slower while standing in a pool
const STEP_SMOOTHING = 10; // 1/s, how fast the eye follows floor height changes
const RUN_FACTOR = 1.55;
// Stamina (0..1): running drains it, anything else slowly refills it.
const STAMINA = {
  runSeconds: 4.5, // full to empty while running
  refillSeconds: 7, // empty to full
  refillDelay: 0.8, // s after you stop running before it refills
  recover: 0.35, // once out of breath, you cannot run again until this much is back
};

/**
 * @param {object} camera
 * @param {HTMLElement} domElement
 * @param {() => object[]} getColliders axis-aligned boxes in XZ
 * @param {(x:number, z:number) => {y:number, inWater:boolean}} [getGround]
 *   floor height at (x, z); defaults to a flat floor at y = 0
 */
export function createControls(camera, domElement, getColliders, getGround = () => FLAT) {
  const keys = new Set();
  // Exposed movement state (used for water wakes).
  // stamina / winded: see STAMINA (winded = emptied it, cannot run yet).
  const state = { speed: 0, inWater: false, stamina: 1, winded: false };
  let restClock = 0;
  let yaw = 0;
  let pitch = 0;
  let locked = false;

  // Scratch vectors, reused every frame.
  const _forward = { x: 0, z: 0 };
  const _right = { x: 0, z: 0 };

  function updateStamina(dt, running) {
    if (running) {
      restClock = 0;
      state.stamina = Math.max(0, state.stamina - dt / STAMINA.runSeconds);
      if (state.stamina === 0) state.winded = true;
      return;
    }
    restClock += dt;
    if (restClock >= STAMINA.refillDelay) {
      state.stamina = Math.min(1, state.stamina + dt / STAMINA.refillSeconds);
    }
    if (state.winded && state.stamina >= STAMINA.recover) state.winded = false;
  }

  function applyLook() {
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    // YXZ: look around, then pitch.
    const cy = Math.cos(yaw * 0.5);
    const sy = Math.sin(yaw * 0.5);
    const cx = Math.cos(pitch * 0.5);
    const sx = Math.sin(pitch * 0.5);
    camera.quaternion.set(
      sx * cy,
      cx * sy,
      -sx * sy,
      cx * cy,
    );
  }

  function onMouseMove(event) {
    if (!locked) return;
    yaw -= event.movementX * LOOK_SENSITIVITY;
    pitch -= event.movementY * LOOK_SENSITIVITY;
    applyLook();
  }

  function onKeyDown(event) {
    keys.add(event.code);
  }

  function onKeyUp(event) {
    keys.delete(event.code);
  }

  // keyup never fires if focus or pointer lock is lost mid-press, so
  // drop every held key whenever that happens.
  function releaseKeys() {
    keys.clear();
  }

  function onPointerLockChange() {
    locked = document.pointerLockElement === domElement;
    if (!locked) releaseKeys();
  }

  function onPointerLockError() {
    locked = false;
    releaseKeys();
  }

  function onVisibilityChange() {
    if (document.hidden) releaseKeys();
  }

  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('pointerlockerror', onPointerLockError);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('blur', releaseKeys);

  // Ease the eye height towards the floor under the player (stepping
  // down into / up out of a pool).
  function followGround(dt) {
    const ground = getGround(camera.position.x, camera.position.z);
    state.inWater = ground.inWater;
    const target = ground.y + EYE_HEIGHT;
    camera.position.y += (target - camera.position.y) * (1 - Math.exp(-STEP_SMOOTHING * dt));
  }

  applyLook();
  camera.position.y = EYE_HEIGHT;

  return {
    get locked() {
      return locked;
    },
    lock() {
      if (!locked) {
        domElement.requestPointerLock();
      }
    },
    unlock() {
      if (document.pointerLockElement === domElement) {
        document.exitPointerLock();
      }
    },
    get state() {
      return state;
    },
    setPose(x, z, yawValue = 0, pitchValue = 0) {
      const ground = getGround(x, z);
      camera.position.x = x;
      camera.position.y = ground.y + EYE_HEIGHT;
      camera.position.z = z;
      state.inWater = ground.inWater;
      state.speed = 0;
      yaw = yawValue;
      pitch = pitchValue;
      applyLook();
    },
    update(dt) {
      // Only move while the pointer is locked (i.e. the player is "in" the scene).
      if (!locked || dt <= 0 || dt > 0.25) return;
      state.speed = 0;
      let ax = 0;
      let az = 0;
      if (keys.has('KeyW') || keys.has('ArrowUp')) az += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) az -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) ax += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) ax -= 1;
      const wantsRun = keys.has('ShiftLeft') || keys.has('ShiftRight');
      const running = wantsRun && !state.winded && (ax !== 0 || az !== 0);
      updateStamina(dt, running);
      if (ax === 0 && az === 0) {
        followGround(dt);
        return;
      }

      const len = Math.hypot(ax, az) || 1;
      ax /= len;
      az /= len;

      const sinY = Math.sin(yaw);
      const cosY = Math.cos(yaw);
      // Camera looks down -Z at yaw 0.
      _forward.x = -sinY;
      _forward.z = -cosY;
      _right.x = cosY;
      _right.z = -sinY;

      let speed = running ? MOVE_SPEED * RUN_FACTOR : MOVE_SPEED;
      if (state.inWater) speed *= WADE_SPEED_FACTOR;
      const dx = (_forward.x * az + _right.x * ax) * speed * dt;
      const dz = (_forward.z * az + _right.z * ax) * speed * dt;

      const next = collide(camera.position.x, camera.position.z, dx, dz, PLAYER_RADIUS, getColliders());
      state.speed = Math.hypot(next.x - camera.position.x, next.z - camera.position.z) / dt;
      camera.position.x = next.x;
      camera.position.z = next.z;
      followGround(dt);
    },
    dispose() {
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('pointerlockerror', onPointerLockError);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', releaseKeys);
    },
  };
}

const FLAT = { y: 0, inWater: false };

function collide(x, z, dx, dz, radius, boxes) {
  let nx = x + dx;
  let nz = z;
  for (const b of boxes) {
    const hit = resolve(nx, nz, radius, b);
    nx = hit.x;
    nz = hit.z;
  }
  nz = nz + dz;
  for (const b of boxes) {
    const hit = resolve(nx, nz, radius, b);
    nx = hit.x;
    nz = hit.z;
  }
  return { x: nx, z: nz };
}

function resolve(x, z, r, b) {
  const closestX = clamp(x, b.minX, b.maxX);
  const closestZ = clamp(z, b.minZ, b.maxZ);
  let ox = x - closestX;
  let oz = z - closestZ;
  const d2 = ox * ox + oz * oz;

  if (d2 > r * r) return { x, z };

  if (d2 === 0) {
    // Center is inside the box: push out on the shallowest axis.
    const left = x - b.minX;
    const right = b.maxX - x;
    const top = z - b.minZ;
    const bottom = b.maxZ - z;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return { x: b.minX - r, z };
    if (m === right) return { x: b.maxX + r, z };
    if (m === top) return { x, z: b.minZ - r };
    return { x, z: b.maxZ + r };
  }

  const d = Math.sqrt(d2);
  const k = r / d;
  return { x: closestX + ox * k, z: closestZ + oz * k };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
