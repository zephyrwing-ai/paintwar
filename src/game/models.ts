/**
 * Runtime model table. Published builds load the registered Storage copies (see assets.lock.json);
 * the dev server serves the same files straight from assets/models/.
 */
const DEV = import.meta.env.DEV

export const MODEL_URLS = {
  painter: DEV ? '/assets/models/painter-rig.glb' : '/manus-storage/game/sha256/e72ad6154d93699cbd487031b986b1f257ac30fe6a11b1d05a718cd45c759b72.glb',
  bomb: DEV ? '/assets/models/paint-bomb.glb' : '/manus-storage/game/sha256/c195041d8f49f1b903882fc84ac6f1b97bbbf29df18474019567582710ac4311.glb',
  crate: DEV ? '/assets/models/crate.glb' : '/manus-storage/game/sha256/e8586b2ed32c7256e0e3f291f966959cbde826aada221426a67cc27c233d5982.glb',
} as const
