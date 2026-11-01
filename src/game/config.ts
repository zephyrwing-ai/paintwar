/**
 * Client presentation values in one place. Gameplay rules (speed, board, dash, bombs, round
 * length) live in shared/rules.ts and are enforced by the server; nothing here changes outcomes.
 */
export const DEFAULT_CONFIG = {
  camera: {
    fov: 34,
    /** Camera elevation above the board plane, in degrees (90 = straight down). */
    tilt: 60,
  },
  look: {
    /** Screen shake multiplier for hits and bombs (0 turns it off). */
    shake: 1,
  },
} as const

// Presentation always reads active values here. Source defaults remain immutable for
// Tweak Reset and Save with Manus; Apply never writes source or local storage.
type MutableConfig<T> = { -readonly [K in keyof T]: T[K] extends number ? number : T[K] extends object ? MutableConfig<T[K]> : T[K] }
export const CONFIG: MutableConfig<typeof DEFAULT_CONFIG> = structuredClone(DEFAULT_CONFIG)
