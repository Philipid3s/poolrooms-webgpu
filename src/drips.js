/**
 * Seeded schedule of drips falling from the ceiling into the pools.
 * Shared by the water (ripples, WebGPU) and the audio (both renderers), so
 * every "plic" you hear matches a ring you see.
 */

import { mulberry32 } from './rng.js';

const INTERVAL = [0.6, 2.2]; // seconds between drips (all pools together)
const EDGE_KEEP_OUT = 0.36; // metres from the pool edge

/**
 * @param {{cx:number,cz:number,half:number}[]} pools
 * @param {number} seed map seed
 */
export function createDripScheduler(pools, seed) {
  const rng = mulberry32((seed ^ 0x5eed) >>> 0);
  let next = 0.5;
  return {
    /** Returns the drip due at time t (seconds), or null. At most one per call. */
    poll(t) {
      if (!pools.length || t < next) return null;
      const k = Math.floor(rng() * pools.length);
      const p = pools[k];
      const span = p.half - EDGE_KEEP_OUT;
      const drip = { pool: k, x: p.cx + (rng() * 2 - 1) * span, z: p.cz + (rng() * 2 - 1) * span };
      next = t + INTERVAL[0] + rng() * (INTERVAL[1] - INTERVAL[0]);
      return drip;
    },
  };
}
