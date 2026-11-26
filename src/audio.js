/**
 * Procedural ambience with the Web Audio API (no audio files).
 *
 * - Fluorescent hum: 100 Hz mains hum + harmonics + a faint buzz, emitted
 *   from the ceiling fixtures nearest the listener (a small pool of 3D
 *   sources re-assigned as you move, like the lights).
 * - Water: a lapping loop positioned on every pool, a "plic" for each drip
 *   (in sync with the ripples on WebGPU), splashy steps while wading.
 * - Footsteps on tile at a natural walking cadence (time-based, so the
 *   rhythm stays human even though the player moves fast).
 * - Everything except the hum goes through a generated tiled-room reverb:
 *   that is the echo.
 *
 * Browsers only allow audio after a user gesture, so start() is called from
 * the click that locks the pointer. `M` toggles mute.
 */

const HUM_SOURCES = 6;
const HUM_FADE = [7, 13]; // metres: hum emitters fade out over this range
// Seconds between footsteps. Time-based: the player moves at 5.4 m/s
// (8.4 running), so a distance-based stride gave ~7 steps/s.
const STEP_INTERVAL = 0.5; // walking, ~2 steps/s
const RUN_STEP_INTERVAL = 0.38;
const WADE_STEP_INTERVAL = 0.62;
const STEP_LEVEL = 0.5; // overall footstep loudness
const MASTER_LEVEL = 0.8;

/**
 * @param {object} THREE either build (only Vector3 is used)
 * @param {{
 *   fixtures: {x:number,z:number}[],
 *   fixtureY: number,
 *   pools: {cx:number,cz:number}[],
 *   waterY: number,
 * }} scene
 */
export function createAudio(THREE, { fixtures, fixtureY, pools, waterY }) {
  let ctx = null;
  let nodes = null;
  let muted = false;
  let stepClock = 0;
  let foot = 0;
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();

  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();

    const master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER_LEVEL;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    master.connect(comp).connect(ctx.destination);

    // Reverb bus (the "echo" of the tiled rooms).
    const reverb = ctx.createConvolver();
    reverb.buffer = makeTiledRoomImpulse(ctx, 2.6);
    const reverbIn = ctx.createGain();
    reverbIn.gain.value = 1;
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = 0.55;
    reverbIn.connect(reverb).connect(reverbOut).connect(master);

    const noise = makeNoiseBuffer(ctx, 2, 'white');
    const brown = makeNoiseBuffer(ctx, 6, 'brown');

    nodes = { master, reverbIn, noise, brown, hum: buildHum(master, reverbIn), water: buildWater(master, reverbIn, brown) };
    return true;
  }

  // --- fluorescent hum ---------------------------------------------------
  function buildHum(master, reverbIn) {
    const bus = ctx.createGain();
    bus.gain.value = 0.05;
    const partials = [
      [100, 'sine', 0.55],
      [200, 'sine', 0.3],
      [300, 'sine', 0.1],
      [400, 'sine', 0.05],
    ];
    for (const [f, type, g] of partials) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const gain = ctx.createGain();
      gain.gain.value = g;
      o.connect(gain).connect(bus);
      o.start();
    }
    // Faint high buzz from the ballast.
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = 100;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 0.9;
    const buzz = ctx.createGain();
    buzz.gain.value = 0.035;
    saw.connect(bp).connect(buzz).connect(bus);
    saw.start();

    const emitters = [];
    for (let k = 0; k < Math.min(HUM_SOURCES, fixtures.length); k++) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const panner = makePanner({ ref: 1.2, rolloff: 1.4 });
      bus.connect(gain).connect(panner);
      panner.connect(master);
      emitters.push({ gain, panner });
    }
    // A touch of the hum in the reverb makes it feel like it fills the room.
    const send = ctx.createGain();
    send.gain.value = 0.08;
    bus.connect(send).connect(reverbIn);
    return { bus, emitters, order: fixtures.map((_, k) => k), dist: new Float32Array(fixtures.length) };
  }

  function updateHum(x, z, t) {
    const h = nodes.hum;
    for (let k = 0; k < fixtures.length; k++) h.dist[k] = Math.hypot(fixtures[k].x - x, fixtures[k].z - z);
    h.order.sort((a, b) => h.dist[a] - h.dist[b] || a - b);
    const now = ctx.currentTime;
    h.emitters.forEach((e, k) => {
      const idx = h.order[k];
      const w = 1 - smoothstep(HUM_FADE[0], HUM_FADE[1], h.dist[idx]);
      setPos(e.panner, fixtures[idx].x, fixtureY, fixtures[idx].z);
      e.gain.gain.setTargetAtTime(w, now, 0.05);
    });
    // Slow, slightly irregular flicker of the whole hum.
    const flicker = 0.05 * (1 + 0.12 * Math.sin(t * 0.7) * Math.sin(t * 2.3 + 1.1));
    h.bus.gain.setTargetAtTime(flicker, now, 0.1);
  }

  // --- water -------------------------------------------------------------
  function buildWater(master, reverbIn, brown) {
    return pools.map((p, k) => {
      const src = ctx.createBufferSource();
      src.buffer = brown;
      src.loop = true;
      src.playbackRate.value = 0.85 + 0.1 * k / Math.max(1, pools.length - 1);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 520 + 60 * (k % 3);
      bp.Q.value = 0.8;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const panner = makePanner({ ref: 2.2, rolloff: 1.5 });
      setPos(panner, p.cx, waterY, p.cz);
      src.connect(bp).connect(lp).connect(gain).connect(panner);
      panner.connect(master);
      const send = ctx.createGain();
      send.gain.value = 0.35;
      panner.connect(send).connect(reverbIn);
      // Different offsets so the pools do not lap in unison.
      src.start(0, (k * 0.83) % brown.duration);
      return { gain, phase: k * 1.7 };
    });
  }

  function updateWater(t) {
    const now = ctx.currentTime;
    for (const w of nodes.water) {
      // Slow irregular swell of the lapping, different per pool.
      const swell = 0.55 + 0.45 * Math.sin(t * 0.63 + w.phase) * Math.sin(t * 1.37 + w.phase * 2.1);
      w.gain.gain.setTargetAtTime(0.9 * swell, now, 0.15);
    }
  }

  function playDrip(x, z) {
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = 700 + Math.random() * 300;
    o.frequency.setValueAtTime(f0, now);
    o.frequency.exponentialRampToValueAtTime(f0 * 2.8, now + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.35, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
    const panner = makePanner({ ref: 1.5, rolloff: 1.3 });
    setPos(panner, x, waterY, z);
    o.connect(g).connect(panner);
    panner.connect(nodes.master);
    const send = ctx.createGain();
    send.gain.value = 0.9;
    panner.connect(send).connect(nodes.reverbIn);
    o.start(now);
    o.stop(now + 0.15);
  }

  // --- footsteps ---------------------------------------------------------
  function playStep(inWater) {
    const now = ctx.currentTime;
    const side = foot++ % 2 ? 1 : -1;
    const out = ctx.createGain();
    // Small random level variation so steps do not sound machine-made.
    out.gain.value = STEP_LEVEL * (0.85 + Math.random() * 0.3);
    out.connect(nodes.master);
    const send = ctx.createGain();
    send.gain.value = inWater ? 0.6 : 0.9;
    out.connect(send).connect(nodes.reverbIn);

    const n = ctx.createBufferSource();
    n.buffer = nodes.noise;
    n.playbackRate.value = 0.9 + Math.random() * 0.2;
    const env = ctx.createGain();

    if (!inWater) {
      // Soft sole on ceramic: a rounded heel thump, then a gentle toe scuff
      // ~70 ms later. Slow-ish attacks, mid frequencies, no sharp click.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1500 + side * 120;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900 + side * 80;
      bp.Q.value = 0.7;
      // heel
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(0.16, now + 0.012);
      env.gain.setTargetAtTime(0, now + 0.012, 0.035);
      // toe
      const toe = now + 0.07 + Math.random() * 0.02;
      env.gain.setValueAtTime(0.0001, toe);
      env.gain.linearRampToValueAtTime(0.07, toe + 0.015);
      env.gain.setTargetAtTime(0, toe + 0.015, 0.045);
      n.connect(bp).connect(lp).connect(env).connect(out);
      n.start(now, Math.random() * 1.5, 0.35);

      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(95, now);
      o.frequency.exponentialRampToValueAtTime(60, now + 0.12);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0, now);
      og.gain.linearRampToValueAtTime(0.18, now + 0.01);
      og.gain.setTargetAtTime(0, now + 0.01, 0.04);
      o.connect(og).connect(out);
      o.start(now);
      o.stop(now + 0.3);
    } else {
      // Wading: a soft slosh with a falling low-pass.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2;
      lp.frequency.setValueAtTime(1600, now);
      lp.frequency.exponentialRampToValueAtTime(320, now + 0.45);
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(0.35, now + 0.06);
      env.gain.setTargetAtTime(0, now + 0.06, 0.13);
      n.connect(lp).connect(env).connect(out);
      n.start(now, Math.random() * 1.2, 0.7);
    }
  }

  return {
    get state() {
      if (!ctx) return 'click to start';
      return muted ? 'muted (M)' : 'on (M to mute)';
    },
    /** Call from a user gesture (click). */
    start() {
      if (!ctx && !build()) return;
      if (ctx.state === 'suspended') ctx.resume();
    },
    toggleMute() {
      muted = !muted;
      if (ctx) nodes.master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, ctx.currentTime, 0.05);
    },
    /**
     * @param {object} camera
     * @param {{speed:number, inWater:boolean}} move player movement state
     * @param {number} dt seconds
     * @param {number} t  seconds
     * @param {{x:number,z:number}|null} drip drip that fell this frame
     */
    update(camera, move, dt, t, drip) {
      if (!ctx || ctx.state !== 'running') return;

      // Listener = camera.
      const l = ctx.listener;
      camera.getWorldDirection(fwd);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      const p = camera.position;
      if (l.positionX) {
        const now = ctx.currentTime;
        l.positionX.setTargetAtTime(p.x, now, 0.02);
        l.positionY.setTargetAtTime(p.y, now, 0.02);
        l.positionZ.setTargetAtTime(p.z, now, 0.02);
        l.forwardX.setTargetAtTime(fwd.x, now, 0.02);
        l.forwardY.setTargetAtTime(fwd.y, now, 0.02);
        l.forwardZ.setTargetAtTime(fwd.z, now, 0.02);
        l.upX.setTargetAtTime(up.x, now, 0.02);
        l.upY.setTargetAtTime(up.y, now, 0.02);
        l.upZ.setTargetAtTime(up.z, now, 0.02);
      } else {
        l.setPosition(p.x, p.y, p.z);
        l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
      }

      updateHum(p.x, p.z, t);
      updateWater(t);
      if (drip) playDrip(drip.x, drip.z);

      // Footsteps at a fixed cadence while moving.
      if (move.speed > 0.3) {
        const interval = move.inWater
          ? WADE_STEP_INTERVAL
          : move.speed > 6 ? RUN_STEP_INTERVAL : STEP_INTERVAL;
        stepClock += dt;
        if (stepClock >= interval) {
          stepClock = Math.min(stepClock - interval, interval);
          playStep(move.inWater);
        }
      } else {
        // First step lands shortly after starting to walk again.
        stepClock = STEP_INTERVAL * 0.75;
      }
    },
  };

  function makePanner({ ref, rolloff }) {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'exponential';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = 60;
    return p;
  }
}

function setPos(panner, x, y, z) {
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    panner.setPosition(x, y, z);
  }
}

function makeNoiseBuffer(ctx, seconds, kind) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else {
      d[i] = w;
    }
  }
  return buf;
}

/**
 * Stereo impulse response of a hard, tiled room: a few early reflections,
 * then an exponentially decaying noise tail that gets darker over time
 * (high frequencies die first).
 */
function makeTiledRoomImpulse(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  const rt60 = seconds * 0.85;
  const preDelay = Math.floor(0.012 * rate);
  const early = [0.019, 0.031, 0.047, 0.066, 0.089];
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = preDelay; i < len; i++) {
      const t = (i - preDelay) / rate;
      const amp = Math.exp((-6.9 * t) / rt60);
      // One-pole low-pass whose cutoff falls with time.
      const a = 0.85 * Math.exp(-t * 1.6) + 0.08;
      lp += a * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * amp * 0.6;
    }
    for (const e of early) {
      const i = preDelay + Math.floor((e + c * 0.0031) * rate);
      if (i < len) d[i] += (c ? -0.5 : 0.5) * Math.exp(-e * 8);
    }
  }
  return buf;
}

function smoothstep(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
