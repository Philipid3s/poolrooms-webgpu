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

export function createControls(camera, domElement, getColliders) {
  const keys = new Set();
  let yaw = 0;
  let pitch = 0;
  let locked = false;

  const euler = { x: 0, y: 0, z: 0 };
  // Reuse a scratch object; we set camera quaternion from yaw/pitch each frame.
  const _forward = { x: 0, z: 0 };
  const _right = { x: 0, z: 0 };

  function applyLook() {
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    euler.y = yaw;
    euler.x = pitch;
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

  function onPointerLockChange() {
    locked = document.pointerLockElement === domElement;
  }

  function onPointerLockError() {
    locked = false;
  }

  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('pointerlockerror', onPointerLockError);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

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
    setPose(x, z, yawValue = 0) {
      camera.position.x = x;
      camera.position.y = EYE_HEIGHT;
      camera.position.z = z;
      yaw = yawValue;
      pitch = 0;
      applyLook();
    },
    update(dt) {
      if (dt <= 0 || dt > 0.25) return;
      let ax = 0;
      let az = 0;
      if (keys.has('KeyW') || keys.has('ArrowUp')) az += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) az -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) ax += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) ax -= 1;
      if (ax === 0 && az === 0) return;

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

      const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? MOVE_SPEED * 1.55 : MOVE_SPEED;
      const dx = (_forward.x * az + _right.x * ax) * speed * dt;
      const dz = (_forward.z * az + _right.z * ax) * speed * dt;

      const next = collide(camera.position.x, camera.position.z, dx, dz, PLAYER_RADIUS, getColliders());
      camera.position.x = next.x;
      camera.position.z = next.z;
      camera.position.y = EYE_HEIGHT;
    },
    dispose() {
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('pointerlockerror', onPointerLockError);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
    },
  };
}

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
