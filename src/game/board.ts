import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { CELL, CELLS, COLS, ROWS, WALL, cellX, cellY, createGrid } from '../../shared/rules.ts'
import { PALETTE } from './palette'

/** World units: one cell = 1. The board is centred on the origin, x right, z down the rows. */
export const worldX = (x: number): number => x / CELL - COLS / 2
export const worldZ = (y: number): number => y / CELL - ROWS / 2
export const cellWorld = (cell: number): THREE.Vector3 => new THREE.Vector3(cellX(cell) + 0.5 - COLS / 2, 0, cellY(cell) + 0.5 - ROWS / 2)

const TILE_H = 0.22
const NEUTRAL_A = new THREE.Color('#ece8f7')
const NEUTRAL_B = new THREE.Color('#ddd7ef')
const FLASH = new THREE.Color('#ffffff')
const POP_TIME = 0.32

export class Board {
  readonly group = new THREE.Group()
  private readonly tiles: THREE.InstancedMesh
  private readonly shown = new Uint8Array(CELLS)
  private readonly from = new Uint8Array(CELLS)
  private readonly age = new Float32Array(CELLS).fill(99)
  private readonly active = new Set<number>()
  private readonly walls = createGrid()
  private readonly bombTemplate: THREE.Object3D
  private readonly bombs = new Map<number, { obj: THREE.Object3D; ring: THREE.Mesh; born: number }>()
  private readonly tmp = new THREE.Object3D()
  private readonly color = new THREE.Color()
  private time = 0

  constructor(crate: GLTF, bomb: GLTF) {
    const geometry = new RoundedBoxGeometry(0.94, TILE_H, 0.94, 2, 0.08)
    const material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 })
    this.tiles = new THREE.InstancedMesh(geometry, material, CELLS)
    this.tiles.receiveShadow = true
    for (let cell = 0; cell < CELLS; cell += 1) {
      this.place(cell, 1, 0)
      this.tiles.setColorAt(cell, this.neutral(cell))
    }
    this.tiles.instanceMatrix.needsUpdate = true
    this.group.add(this.tiles)

    // Board slab with a raised rim.
    const slab = new THREE.Mesh(new RoundedBoxGeometry(COLS + 1.2, 0.6, ROWS + 1.2, 3, 0.3), new THREE.MeshStandardMaterial({ color: '#3b3470', roughness: 0.8 }))
    slab.position.y = -0.32
    slab.receiveShadow = true
    this.group.add(slab)
    const rimMaterial = new THREE.MeshStandardMaterial({ color: '#4d4590', roughness: 0.7 })
    for (const [w, d, x, z] of [[COLS + 1.2, 0.5, 0, -(ROWS + 0.7) / 2], [COLS + 1.2, 0.5, 0, (ROWS + 0.7) / 2], [0.5, ROWS + 1.2, -(COLS + 0.7) / 2, 0], [0.5, ROWS + 1.2, (COLS + 0.7) / 2, 0]]) {
      const rim = new THREE.Mesh(new RoundedBoxGeometry(w, 0.5, d, 2, 0.2), rimMaterial)
      rim.position.set(x, 0.05, z)
      rim.castShadow = true
      rim.receiveShadow = true
      this.group.add(rim)
    }

    this.addCrates(crate)
    this.bombTemplate = bomb.scene
  }

  private neutral(cell: number): THREE.Color {
    return (cellX(cell) + cellY(cell)) % 2 === 0 ? NEUTRAL_A : NEUTRAL_B
  }

  private paintColor(value: number, cell: number): THREE.Color {
    return value >= 1 && value <= 4 ? PALETTE[value - 1].tile : this.neutral(cell)
  }

  private place(cell: number, scaleY: number, lift: number): void {
    const p = cellWorld(cell)
    this.tmp.position.set(p.x, -TILE_H / 2 + lift, p.z)
    this.tmp.scale.set(1, scaleY, 1)
    this.tmp.updateMatrix()
    this.tiles.setMatrixAt(cell, this.tmp.matrix)
  }

  private addCrates(crate: GLTF): void {
    const cells: number[] = []
    for (let cell = 0; cell < CELLS; cell += 1) if (this.walls[cell] === WALL) cells.push(cell)
    crate.scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(crate.scene)
    const size = box.getSize(new THREE.Vector3())
    const scale = 0.96 / Math.max(size.x, size.z)
    crate.scene.traverse(node => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      const geometry = mesh.geometry.clone()
      geometry.applyMatrix4(mesh.matrixWorld)
      geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
      geometry.scale(scale, scale, scale)
      const instanced = new THREE.InstancedMesh(geometry, mesh.material, cells.length)
      instanced.castShadow = true
      instanced.receiveShadow = true
      cells.forEach((cell, i) => {
        const p = cellWorld(cell)
        // Small deterministic variety so the crates do not look stamped.
        this.tmp.position.set(p.x, -0.02, p.z)
        this.tmp.rotation.set(0, ((cell * 7) % 4) * (Math.PI / 2) + (((cell * 13) % 5) - 2) * 0.03, 0)
        this.tmp.scale.setScalar(1)
        this.tmp.updateMatrix()
        instanced.setMatrixAt(i, this.tmp.matrix)
      })
      this.group.add(instanced)
    })
  }

  /** Shows a grid (server truth + local prediction). Returns cells whose colour changed. */
  setGrid(grid: Uint8Array, animate = true): Array<{ cell: number; value: number; was: number }> {
    const changed: Array<{ cell: number; value: number; was: number }> = []
    for (let cell = 0; cell < CELLS; cell += 1) {
      const value = grid[cell] === WALL ? 0 : grid[cell]
      if (value === this.shown[cell]) continue
      changed.push({ cell, value, was: this.shown[cell] })
      this.from[cell] = this.shown[cell]
      this.shown[cell] = value
      if (animate) {
        this.age[cell] = 0
        this.active.add(cell)
      } else {
        this.tiles.setColorAt(cell, this.paintColor(value, cell))
      }
    }
    if (changed.length && !animate && this.tiles.instanceColor) this.tiles.instanceColor.needsUpdate = true
    return changed
  }

  clear(): void {
    this.setGrid(new Uint8Array(CELLS), false)
  }

  setBombs(cells: number[]): void {
    for (const [cell, bomb] of this.bombs) {
      if (cells.includes(cell)) continue
      this.group.remove(bomb.obj, bomb.ring)
      this.bombs.delete(cell)
    }
    for (const cell of cells) {
      if (this.bombs.has(cell)) continue
      const obj = this.bombTemplate.clone(true)
      obj.traverse(n => { if ((n as THREE.Mesh).isMesh) (n as THREE.Mesh).castShadow = true })
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.46, 32), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthWrite: false }))
      ring.rotation.x = -Math.PI / 2
      const p = cellWorld(cell)
      obj.position.copy(p)
      ring.position.set(p.x, 0.012, p.z)
      this.group.add(obj, ring)
      this.bombs.set(cell, { obj, ring, born: this.time })
    }
  }

  update(dt: number): void {
    this.time += dt
    if (this.active.size) {
      for (const cell of this.active) {
        this.age[cell] += dt
        const t = Math.min(1, this.age[cell] / POP_TIME)
        // Squash-and-stretch pop with a white flash fading into the new colour.
        const bounce = Math.sin(t * Math.PI) * (1 - t * 0.4)
        this.place(cell, 1 + bounce * 1.6, bounce * 0.12)
        const target = this.paintColor(this.shown[cell], cell)
        this.color.copy(FLASH).lerp(target, Math.min(1, t * 2.2))
        this.tiles.setColorAt(cell, this.color)
        if (t >= 1) {
          this.place(cell, 1, 0)
          this.tiles.setColorAt(cell, target)
          this.active.delete(cell)
        }
      }
      this.tiles.instanceMatrix.needsUpdate = true
      if (this.tiles.instanceColor) this.tiles.instanceColor.needsUpdate = true
    }
    for (const bomb of this.bombs.values()) {
      const life = this.time - bomb.born
      const grow = Math.min(1, life / 0.35)
      const s = 0.62 * (grow < 1 ? 1 - Math.pow(1 - grow, 3) * 1.0 + Math.sin(grow * Math.PI) * 0.25 : 1)
      bomb.obj.scale.setScalar(s)
      bomb.obj.position.y = 0.38 + Math.sin(this.time * 3 + bomb.born) * 0.08
      bomb.obj.rotation.y += dt * 1.4
      const pulse = (this.time * 1.2 + bomb.born) % 1
      bomb.ring.scale.setScalar(0.8 + pulse * 0.7)
      ;(bomb.ring.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - pulse)
    }
  }
}
