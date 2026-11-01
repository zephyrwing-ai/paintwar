import * as THREE from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { Dir, Seat } from '../../shared/rules.ts'
import { PALETTE } from './palette'

type Clip = 'run' | 'idle' | 'hurt' | 'cheer' | 'victory_celebration'
const LOOPS: readonly Clip[] = ['run', 'idle']
const SCALE = 1.3

/** Facing angle about +Y for a grid heading (model faces +Z = grid down). */
const FACE_ANGLE: Record<number, number> = { 0: 0, 1: Math.PI, 2: Math.PI / 2, 3: 0, 4: -Math.PI / 2 }

/** Repaired clips end one frame short of the loop; append the first key so the wrap is seamless. */
function closeLoop(clip: THREE.AnimationClip): THREE.AnimationClip {
  const end = clip.duration + 1 / 30
  for (const track of clip.tracks) {
    const size = track.getValueSize()
    const times = new Float32Array(track.times.length + 1)
    times.set(track.times)
    times[track.times.length] = end
    const values = new Float32Array(track.values.length + size)
    values.set(track.values)
    values.set(track.values.slice(0, size), track.values.length)
    track.times = times
    track.values = values
  }
  clip.duration = end
  return clip
}

export function prepareClips(gltf: GLTF): Map<Clip, THREE.AnimationClip> {
  const clips = new Map<Clip, THREE.AnimationClip>()
  for (const clip of gltf.animations) {
    const name = clip.name as Clip
    clips.set(name, LOOPS.includes(name) ? closeLoop(clip.clone()) : clip)
  }
  return clips
}

export class Avatar {
  readonly root = new THREE.Group()
  private readonly body: THREE.Object3D
  private readonly mixer: THREE.AnimationMixer
  private readonly actions = new Map<Clip, THREE.AnimationAction>()
  private readonly materials: THREE.MeshStandardMaterial[] = []
  private readonly stars = new THREE.Group()
  private readonly marker: THREE.Mesh
  private readonly shadow: THREE.Mesh
  private current: Clip | null = null
  private angle = 0
  private oneShotUntil = 0
  private time = 0
  private squash = 0
  private ghost = 1
  readonly color: THREE.Color

  constructor(template: GLTF, clips: Map<Clip, THREE.AnimationClip>, readonly seat: Seat, mine: boolean) {
    const palette = PALETTE[['p1', 'p2', 'p3', 'p4'].indexOf(seat)]
    this.color = palette.main
    this.body = cloneSkinned(template.scene)
    this.body.scale.setScalar(SCALE)
    this.body.traverse(node => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.frustumCulled = false
      const material = (mesh.material as THREE.MeshStandardMaterial).clone()
      material.color.copy(palette.body)
      material.emissive = palette.main.clone().multiplyScalar(0.18)
      material.transparent = true
      mesh.material = material
      this.materials.push(material)
    })
    this.root.add(this.body)
    this.mixer = new THREE.AnimationMixer(this.body)
    for (const [name, clip] of clips) {
      const action = this.mixer.clipAction(clip)
      if (!LOOPS.includes(name)) {
        action.setLoop(name === 'victory_celebration' ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
        action.clampWhenFinished = true
      }
      this.actions.set(name, action)
    }
    this.play('idle', 0)

    // Soft contact shadow + a team-coloured ring (thicker for your own painter).
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 24), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.22, depthWrite: false }))
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.position.y = 0.012
    this.root.add(this.shadow)
    this.marker = new THREE.Mesh(new THREE.RingGeometry(mine ? 0.42 : 0.44, mine ? 0.56 : 0.5, 32), new THREE.MeshBasicMaterial({ color: palette.main, transparent: true, opacity: mine ? 0.95 : 0.6, depthWrite: false, toneMapped: false }))
    this.marker.rotation.x = -Math.PI / 2
    this.marker.position.y = 0.02
    this.root.add(this.marker)

    // Dizzy stars, shown while stunned.
    const starMaterial = new THREE.MeshBasicMaterial({ color: '#ffe14d', toneMapped: false })
    for (let i = 0; i < 3; i += 1) {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.1, 0), starMaterial)
      const a = (i / 3) * Math.PI * 2
      star.position.set(Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32)
      this.stars.add(star)
    }
    this.stars.position.y = 1.55
    this.stars.visible = false
    this.root.add(this.stars)
  }

  private play(name: Clip, fade = 0.15): void {
    if (this.current === name) return
    const next = this.actions.get(name)
    if (!next) return
    const prev = this.current ? this.actions.get(this.current) : undefined
    next.reset().setEffectiveWeight(1).play()
    if (prev) next.crossFadeFrom(prev, fade, false)
    this.current = name
  }

  /** One-shot celebration (lobby ready, round win). */
  celebrate(win = false): void {
    this.play(win ? 'victory_celebration' : 'cheer', 0.2)
    this.oneShotUntil = this.time + (win ? 1e9 : 1.6)
  }

  bump(): void {
    this.squash = 1
  }

  /** Per-frame pose from the predicted/interpolated state. */
  set(state: { wx: number; wz: number; face: Dir; moving: boolean; stun: number; dash: number; away: boolean; idleOnly?: boolean }, dt: number): void {
    this.root.position.set(state.wx, 0, state.wz)
    const target = FACE_ANGLE[state.face] ?? 0
    let diff = target - this.angle
    diff = Math.atan2(Math.sin(diff), Math.cos(diff))
    this.angle += diff * Math.min(1, dt * 18)
    this.body.rotation.y = this.angle
    const celebrating = this.time < this.oneShotUntil
    if (state.stun > 0) this.play('hurt', 0.08)
    else if (!celebrating) this.play(state.moving && !state.idleOnly ? 'run' : 'idle', 0.18)
    const run = this.actions.get('run')
    if (run) run.timeScale = state.dash > 0 ? 2.2 : 1.25
    this.stars.visible = state.stun > 0
    this.stars.rotation.y += dt * 7
    // Dash stretch and bump squash.
    this.squash = Math.max(0, this.squash - dt * 4)
    const stretch = state.dash > 0 ? 1.18 : 1
    const sq = 1 - Math.sin(this.squash * Math.PI) * 0.25
    this.body.scale.set(SCALE / Math.sqrt(stretch) / sq, SCALE * sq, SCALE * stretch)
    // Away (seat held while reconnecting): faded.
    const targetGhost = state.away ? 0.35 : 1
    this.ghost += (targetGhost - this.ghost) * Math.min(1, dt * 8)
    for (const m of this.materials) {
      m.opacity = this.ghost
      m.depthWrite = this.ghost > 0.95
    }
    ;(this.marker.material as THREE.MeshBasicMaterial).opacity = (state.away ? 0.25 : 0.9) * (0.75 + Math.sin(this.time * 5) * 0.25)
  }

  update(dt: number): void {
    this.time += dt
    this.mixer.update(dt)
  }

  dispose(): void {
    this.mixer.stopAllAction()
    this.root.removeFromParent()
    for (const m of this.materials) m.dispose()
  }
}
