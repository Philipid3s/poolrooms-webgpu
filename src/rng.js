/**
 * Seed parsing and a small deterministic PRNG (Mulberry32).
 * The same numeric seed always yields the same sequence.
 */

export function parseSeed(raw) {
  if (raw == null || raw === '') {
    return { seed: (Math.random() * 0xffffffff) >>> 0, label: null, generated: true };
  }
  if (/^\d+$/.test(raw)) {
    const seed = Number(raw) >>> 0;
    return { seed, label: String(seed), generated: false };
  }
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return { seed: h >>> 0, label: raw, generated: false };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng, min, maxInclusive) {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

export function choice(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}
