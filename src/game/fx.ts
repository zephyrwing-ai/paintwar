import * as THREE from 'three'

type Particle = { life: number; max: number; pos: THREE.Vector3; vel: THREE.Vector3; size: number; color: THREE.Color; gravity: number }

const MAX = 600

/**
 * Pooled particle bursts on one InstancedMesh (a single draw call for every effect), plus
 * expanding shock rings. Purely cosmetic: driven by snapshots and local input feedback.
 */
export class Effects {
  readonly group = new THREE.Group()
  readonly mesh: THREE.InstancedMesh
  private particles: Particle[] = []
  private readonly dummy = new THREE.Object3D()
  private readonly rings: Array<{ mesh: THREE.Mesh; life: number; max: number; size: number }> = []
  /** Fewer particles when the player asked for reduced motion. */
  reduced = false

  constructor() {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false })
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.1, 0), mat, MAX)
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.setColorAt(0, new THREE.Color())
    this.group.add(this.mesh)
  }

  /** Paint droplets bursting up and out from a point. */
  burst(at: THREE.Vector3, color: THREE.ColorRepresentation, count = 24, speed = 6): void {
    const c = new THREE.Color(color)
    const n = this.reduced ? Math.ceil(count / 3) : count
    for (let i = 0; i < n; i += 1) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.35, Math.random() - 0.5).normalize()
      this.spawn({ life: 0, max: 0.45 + Math.random() * 0.4, pos: at.clone(), vel: dir.multiplyScalar(speed * (0.4 + Math.random() * 0.6)), size: 0.8 + Math.random() * 0.9, color: c, gravity: -16 })
    }
  }

  puff(at: THREE.Vector3, strength = 1, color: THREE.ColorRepresentation = '#f3e6cf'): void {
    const c = new THREE.Color(color)
    const n = Math.round((8 + strength * 10) * (this.reduced ? 0.4 : 1))
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2
      const vel = new THREE.Vector3(Math.cos(a), 0.25 + Math.random() * 0.3, Math.sin(a)).multiplyScalar(2 + strength * 3)
      this.spawn({ life: 0, max: 0.35 + Math.random() * 0.25, pos: at.clone(), vel, size: 1.2 + Math.random(), color: c, gravity: -2 })
    }
  }

  ring(at: THREE.Vector3, color: THREE.ColorRepresentation, size = 2.5, max = 0.45): void {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.72, 1, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }))
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(at.x, 0.06, at.z)
    this.group.add(mesh)
    this.rings.push({ mesh, life: 0, max, size })
  }

  private spawn(p: Particle): void {
    if (this.particles.length >= MAX) this.particles.shift()
    this.particles.push(p)
  }

  update(dt: number): void {
    this.particles = this.particles.filter(p => (p.life += dt) < p.max)
    this.particles.forEach((p, i) => {
      p.vel.y += p.gravity * dt
      p.vel.multiplyScalar(1 - 2.2 * dt)
      p.pos.addScaledVector(p.vel, dt)
      if (p.pos.y < 0.03) { p.pos.y = 0.03; p.vel.set(p.vel.x * 0.3, 0, p.vel.z * 0.3) }
      const k = 1 - p.life / p.max
      this.dummy.position.copy(p.pos)
      this.dummy.scale.set(p.size * k, p.size * k * (p.pos.y <= 0.031 ? 0.3 : 1), p.size * k)
      this.dummy.rotation.set(p.life * 6, p.life * 4, 0)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
      this.mesh.setColorAt(i, p.color)
    })
    this.mesh.count = this.particles.length
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    for (let i = this.rings.length - 1; i >= 0; i -= 1) {
      const r = this.rings[i]
      r.life += dt
      const t = r.life / r.max
      if (t >= 1) {
        this.group.remove(r.mesh)
        r.mesh.geometry.dispose()
        ;(r.mesh.material as THREE.Material).dispose()
        this.rings.splice(i, 1)
        continue
      }
      r.mesh.scale.setScalar(0.2 + (1 - Math.pow(1 - t, 3)) * r.size)
      ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t)
    }
  }

  clear(): void {
    this.particles = []
    this.mesh.count = 0
  }
}
