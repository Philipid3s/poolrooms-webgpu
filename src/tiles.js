/**
 * Procedural tile textures (canvas, no external assets).
 * Poolrooms-like cream / yellow ceramic with grout lines.
 */

export function createTileTexture(THREE, { hue = 42, tilePx = 32, size = 256, variation = 14, grout = '#c9b57a' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const tiles = size / tilePx;

  ctx.fillStyle = grout;
  ctx.fillRect(0, 0, size, size);

  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) {
      const n = hash2(x, y);
      const light = 68 + Math.floor(n * variation);
      ctx.fillStyle = `hsl(${hue}, 38%, ${light}%)`;
      ctx.fillRect(x * tilePx + 1, y * tilePx + 1, tilePx - 2, tilePx - 2);

      // faint highlight on the upper-left edge
      ctx.fillStyle = `hsla(${hue}, 30%, ${Math.min(90, light + 16)}%, 0.28)`;
      ctx.fillRect(x * tilePx + 1, y * tilePx + 1, tilePx - 2, 3);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function hash2(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
