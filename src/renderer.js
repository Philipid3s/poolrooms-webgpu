/**
 * WebGPU detection and renderer construction.
 * Uses three's WebGPURenderer when an adapter is available, otherwise
 * falls back to WebGLRenderer. `?renderer=webgl` forces the fallback.
 */

const TONE_MAPPING_EXPOSURE = 1.15;

export function wantsForcedWebGL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('renderer') === 'webgl';
}

export async function detectWebGPU() {
  if (!navigator.gpu) {
    return { supported: false, reason: 'navigator.gpu is missing' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { supported: false, reason: 'requestAdapter() returned no adapter' };
    }
    return { supported: true, reason: 'adapter acquired', adapter };
  } catch (err) {
    return { supported: false, reason: `requestAdapter() threw: ${err?.message || err}` };
  }
}

/**
 * @returns {Promise<{
 *   THREE: object,
 *   renderer: object,
 *   kind: 'WebGPU'|'WebGL',
 *   detection: {supported:boolean, reason:string},
 *   forced: boolean,
 * }>}
 */
export async function createRenderer(canvasParent = document.body) {
  const forced = wantsForcedWebGL();
  const detection = await detectWebGPU();
  const useWebGPU = !forced && detection.supported;

  if (useWebGPU) {
    const THREE = await import('three/webgpu');
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    await renderer.init();
    configureRenderer(THREE, renderer);
    canvasParent.appendChild(renderer.domElement);
    return { THREE, renderer, kind: 'WebGPU', detection, forced };
  }

  const THREE = await import('three');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  configureRenderer(THREE, renderer);
  canvasParent.appendChild(renderer.domElement);
  return { THREE, renderer, kind: 'WebGL', detection, forced };
}

function configureRenderer(THREE, renderer) {
  // Same output pipeline on both backends so they are comparable.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
}
