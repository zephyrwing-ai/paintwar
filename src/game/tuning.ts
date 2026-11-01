import { CONFIG, DEFAULT_CONFIG } from './config'

/**
 * Tweak controls for the Manus Preview. Online rules belong to the server, so every control here
 * is cosmetic and applies live: changing one never desynchronizes the players.
 */
type Control = { id: string; type: 'number'; category: string; label: string; description: string; unit: string;
  default: number; min: number; max: number; step: number; applyMode: 'LIVE'; integrity: 'COSMETIC' }
type Binding = { control: Control; read(): number; write(value: number): void }

const bindings: Binding[] = []
function number<S extends keyof typeof CONFIG>(section: S, key: keyof typeof CONFIG[S] & string,
  label: string, min: number, max: number, step: number, unit: string, category = 'Camera'): void {
  const values = CONFIG[section] as Record<string, number>
  const defaults = DEFAULT_CONFIG[section] as Record<string, number>
  bindings.push({ control: Object.freeze({ id: `${section}.${key}`, type: 'number', category, label,
    description: 'Updates this preview immediately.', unit, default: defaults[key], min, max, step,
    applyMode: 'LIVE', integrity: 'COSMETIC' }),
    read: () => values[key], write: value => { values[key] = value } })
}
number('camera', 'fov', 'Field of view', 20, 60, 1, '°')
number('camera', 'tilt', 'Camera tilt', 40, 85, 1, '°')
number('look', 'shake', 'Screen shake', 0, 2, 0.1, '×', 'Feel')

const byId = new Map(bindings.map(binding => [binding.control.id, binding]))
let requested = Object.fromEntries(bindings.map(({ control }) => [control.id, control.default]))

export const tuning = {
  controls: Object.freeze(bindings.map(binding => binding.control)),
  read() {
    return { requested: { ...requested }, active: Object.fromEntries(bindings.map(binding => [binding.control.id, binding.read()])) }
  },
  apply(patch: unknown): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid patch')
    const entries = Object.entries(patch)
    if (entries.length > bindings.length) throw new Error('Invalid patch')
    for (const [id, value] of entries) {
      const control = byId.get(id)?.control
      if (!control || typeof value !== 'number' || !Number.isFinite(value) || value < control.min || value > control.max) throw new Error('Invalid value')
      const steps = (value - control.min) / control.step
      if (value !== control.default && Math.abs(steps - Math.round(steps)) > 1e-7) throw new Error('Invalid increment')
    }
    // Validate everything first, then commit synchronously before the next render.
    requested = { ...requested, ...patch } as Record<string, number>
    for (const [id, value] of entries) byId.get(id)!.write(value as number)
  },
}
