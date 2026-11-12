/**
 * On-screen HUD: renderer name, FPS, seed, and a short help line.
 */

export function createOverlay(element) {
  let frames = 0;
  let fps = 0;
  let last = performance.now();
  let rendererName = '…';
  let seedText = '';
  let extra = '';

  function render() {
    element.textContent =
      `Renderer: ${rendererName}\n` +
      `FPS: ${fps}\n` +
      `Seed: ${seedText}` +
      (extra ? `\n${extra}` : '');
  }

  return {
    setRenderer(name) {
      rendererName = name;
      render();
    },
    setSeed(text) {
      seedText = text;
      render();
    },
    setExtra(text) {
      extra = text;
      render();
    },
    tick(now) {
      frames += 1;
      const elapsed = now - last;
      if (elapsed >= 500) {
        fps = Math.round((frames * 1000) / elapsed);
        frames = 0;
        last = now;
        render();
      }
    },
  };
}
