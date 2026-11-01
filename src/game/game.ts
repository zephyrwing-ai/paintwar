import * as THREE from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  CELLS, COLS, DASH_COOLDOWN, PLAYABLE, ROWS, SEATS, SPAWNS, WALL, centerX, centerY, isFrenzy, type Dir, type Seat,
} from '../../shared/rules.ts'
import type { GameEvent, Role, RoomMsg, SnapMsg } from '../../shared/protocol.ts'
import type { Audio } from '../engine/audio'
import type { Action, Input } from '../engine/input'
import type { Renderer } from '../engine/renderer'
import type { ServerClock } from '../net/clock'
import { Avatar, prepareClips } from './avatars'
import { Board, cellWorld, worldX, worldZ } from './board'
import { CONFIG } from './config'
import { Effects } from './fx'
import { PALETTE } from './palette'
import { Predictor, tickAt } from './predict'

export type GameHooks = {
  send(message: Record<string, unknown>): void
  toast(text: string, tone?: 'info' | 'good' | 'bad'): void
  banner(text: string, tone?: 'frenzy' | 'hit' | 'go'): void
}

export type Share = { seat: Seat; cells: number; pct: number }
export type Hud = {
  remainingMs: number
  frenzy: boolean
  shares: Share[]
  /** 0..1, 1 = dash ready. */
  dashReady: number
  stunned: boolean
  /** This client steers a painter in the current round. */
  playing: boolean
}

const SCREEN_DIRS = ['up', 'down', 'left', 'right'] as const
type ScreenDir = (typeof SCREEN_DIRS)[number]
const GRID_VECTORS: Record<1 | 2 | 3 | 4, THREE.Vector3> = { 1: new THREE.Vector3(0, 0, -1), 2: new THREE.Vector3(1, 0, 0), 3: new THREE.Vector3(0, 0, 1), 4: new THREE.Vector3(-1, 0, 0) }

export class Game {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(36, 1, 0.1, 400)
  private readonly board: Board
  private readonly fx = new Effects()
  private readonly avatars = new Map<Seat, Avatar>()
  private readonly clips: ReturnType<typeof prepareClips>
  private readonly painterTemplate: GLTF
  private readonly predictor = new Predictor()
  private readonly labels = new Map<Seat, HTMLElement>()
  private readonly sun: THREE.DirectionalLight
  private readonly project = new THREE.Vector3()
  private readonly basePosition = new THREE.Vector3()
  private room: RoomMsg | null = null
  private role: Role = 'spectator'
  private seen = new Set<number>()
  private seenRound = -1
  private haveSnap = false
  private shake = 0
  private dirMap: Record<ScreenDir, Dir> = { up: 1, down: 3, left: 4, right: 2 }
  private fitKey = ''
  private combo = 0
  private comboTimer = 0
  private lastSecond = -1
  private shares: Share[] = []
  private dashReady = 1
  private stunned = false
  private avatarRole: Role | null = null

  constructor(
    private readonly renderer: Renderer,
    private readonly audio: Audio,
    private readonly input: Input,
    private readonly clock: ServerClock,
    models: { painter: GLTF; bomb: GLTF; crate: GLTF },
    private readonly labelLayer: HTMLElement,
    private readonly hooks: GameHooks,
  ) {
    this.clips = prepareClips(models.painter)
    this.painterTemplate = models.painter
    this.board = new Board(models.crate, models.bomb)
    this.scene.background = new THREE.Color('#241e4d')
    this.scene.fog = new THREE.Fog('#241e4d', 60, 140)
    this.scene.add(this.board.group, this.fx.group)
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#5a4f9a', 1.25))
    this.sun = new THREE.DirectionalLight('#fff4e0', 2.1)
    this.sun.position.set(-7, 20, 11)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.setScalar(renderer.shadowMapSize)
    const s = this.sun.shadow.camera
    s.left = -15; s.right = 15; s.top = 11; s.bottom = -11; s.near = 1; s.far = 50
    this.sun.shadow.bias = -0.0008
    this.sun.shadow.normalBias = 0.02
    this.scene.add(this.sun, this.sun.target)
    this.addBackdrop()
  }

  /** Decorative floor around the board: a large disc with scattered paint splats. */
  private addBackdrop(): void {
    const floor = new THREE.Mesh(new THREE.CircleGeometry(80, 64), new THREE.MeshStandardMaterial({ color: '#2d2660', roughness: 1 }))
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.62
    floor.receiveShadow = true
    this.scene.add(floor)
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 46; i += 1) {
      const a = rand() * Math.PI * 2
      const r = 17 + rand() * 22
      const x = Math.cos(a) * r * 1.2
      const z = Math.sin(a) * r * 0.85
      if (Math.abs(x) < COLS / 2 + 2 && Math.abs(z) < ROWS / 2 + 2) continue
      const size = 0.6 + rand() * 2.2
      const splat = new THREE.Mesh(new THREE.CircleGeometry(size, 7 + Math.floor(rand() * 5)), new THREE.MeshStandardMaterial({ color: PALETTE[i % 4].main, roughness: 0.6, transparent: true, opacity: 0.55 }))
      splat.rotation.set(-Math.PI / 2, 0, rand() * Math.PI)
      splat.position.set(x, -0.6, z)
      this.scene.add(splat)
    }
  }

  // ---------- network input ----------

  setRole(role: Role): void {
    this.role = role
    this.predictor.self = role === 'spectator' ? null : role
    this.predictor.resetIntents()
    this.syncAvatars()
  }

  /** The socket dropped: unacknowledged intents died with it, and the next snapshot is adopted whole. */
  resetConnection(): void {
    this.predictor.resetIntents()
    this.haveSnap = false
  }

  onRoom(room: RoomMsg): void {
    const prev = this.room
    this.room = room
    const phaseChanged = !prev || prev.phase !== room.phase || prev.round !== room.round
    if (prev) {
      for (const seat of SEATS) {
        const before = prev.seats[seat]
        const now = room.seats[seat]
        if (!before && now) { this.audio.play('join'); this.fx.puff(cellWorld(SPAWNS[seat].cell), 1, PALETTE[SEATS.indexOf(seat)].css) }
        if (before && !now) this.audio.play('leave')
        if (before && now && !before.ready && now.ready && room.phase !== 'live') {
          this.avatars.get(seat)?.celebrate()
          this.audio.play('ready')
        }
      }
    }
    if (phaseChanged) {
      if (room.phase === 'countdown' || room.phase === 'lobby') {
        // Wipe the previous round's paint with a ripple of pops.
        if (prev?.phase === 'results' || prev?.phase === 'live') this.board.setGrid(new Uint8Array(CELLS), true)
        this.board.setBombs([])
        this.haveSnap = false
        this.lastSecond = -1
      }
      if (room.phase === 'live') {
        if (this.predictor.round !== room.round) {
          this.predictor.reset(room.round)
          this.haveSnap = false
        }
        if (prev?.phase === 'countdown') {
          this.audio.play('go')
          this.hooks.banner('开涂！', 'go')
        }
        this.lastSecond = -1
      }
      if (room.phase === 'results' && room.result) {
        const winner = room.result.winner
        if (winner) this.avatars.get(winner)?.celebrate(true)
        // The results screen plays win/lose when it reveals the winner.
        if (prev?.phase === 'live') this.audio.play('end')
      }
    }
    this.syncAvatars()
  }

  onSnap(snap: SnapMsg): void {
    if (!this.room || snap.round !== this.room.round || snap.round < this.predictor.round) return
    this.predictor.apply(snap, this.present())
    if (!this.haveSnap) {
      // First picture of a round (or after reconnecting): adopt the grid without a pop storm.
      this.board.setGrid(this.predictor.grid, false)
    }
    this.haveSnap = true
    this.board.setBombs(snap.bombs)
    if (snap.round !== this.seenRound) {
      this.seen.clear()
      this.seenRound = snap.round
    }
    for (const event of snap.ev) {
      if (this.seen.has(event.id)) continue
      this.seen.add(event.id)
      this.onEvent(event)
    }
  }

  private name(seat: Seat): string {
    return this.room?.seats[seat]?.name ?? seat
  }

  private worldOf(seat: Seat): THREE.Vector3 {
    const a = this.avatars.get(seat)
    return a ? a.root.position.clone() : new THREE.Vector3()
  }

  private onEvent(e: GameEvent): void {
    const me = this.role
    switch (e.k) {
      case 'hit': {
        const at = this.worldOf(e.b)
        this.fx.ring(at, PALETTE[SEATS.indexOf(e.a)].main, 2.6, 0.4)
        this.fx.burst(at.clone().setY(0.6), PALETTE[SEATS.indexOf(e.a)].css, 26, 7)
        this.avatars.get(e.b)?.bump()
        this.audio.play('hit')
        const involved = e.a === me || e.b === me
        this.shake = Math.max(this.shake, involved ? 0.45 : 0.18)
        if (e.b === me) {
          this.audio.play('stunned')
          this.hooks.banner(`被 ${this.name(e.a)} 撞晕了！`, 'hit')
          navigator.vibrate?.(120)
        } else if (e.a === me) {
          this.hooks.toast(`漂亮！撞晕了 ${this.name(e.b)}`, 'good')
        }
        break
      }
      case 'bomb': {
        const at = cellWorld(e.cell)
        const color = PALETTE[SEATS.indexOf(e.a)]
        this.fx.ring(at, color.main, 3.4, 0.5)
        this.fx.burst(at.clone().setY(0.5), color.css, 46, 9)
        this.audio.play('bomb')
        this.shake = Math.max(this.shake, e.a === me ? 0.5 : 0.25)
        if (e.a === me) this.hooks.toast('颜料炸弹！炸开一片', 'good')
        else this.hooks.toast(`${this.name(e.a)} 吃到了颜料炸弹`, 'info')
        break
      }
      case 'spawn':
        this.fx.ring(cellWorld(e.cell), '#ffffff', 1.6, 0.6)
        this.audio.play('spawn')
        break
      case 'away':
        if (e.a !== me) this.hooks.toast(`${this.name(e.a)} 掉线了，座位保留 30 秒`, 'bad')
        break
      case 'back':
        if (e.a !== me) this.hooks.toast(`${this.name(e.a)} 回来了`, 'good')
        break
      case 'out':
        if (e.a !== me) this.hooks.toast(`${this.name(e.a)} 离开了本局`, 'bad')
        break
      case 'frenzy':
        this.hooks.banner('狂热时间！速度和笔刷加大', 'frenzy')
        this.audio.play('frenzy')
        break
    }
  }

  // ---------- local input ----------

  private present(): number {
    const room = this.room
    if (!room || room.phase !== 'live') return this.predictor.baseTick
    return tickAt(this.clock.serverNow(), room.live_at)
  }

  private steering(): boolean {
    return this.room?.phase === 'live' && this.haveSnap && this.role !== 'spectator' && Boolean(this.predictor.players[this.role as Seat])
  }

  private handleInput(): void {
    if (!this.steering()) return
    const present = this.present()
    for (const action of SCREEN_DIRS) {
      if (!this.input.consume(action as Action)) continue
      const dir = this.dirMap[action]
      const own = this.predictor.ownNow(present)
      if (!own) continue
      if (own.dir === dir && own.want === 0) continue
      const sent = this.predictor.turn(present, dir)
      if (sent) this.hooks.send({ type: 'turn', round: this.predictor.round, seq: sent.seq, dir: sent.dir, cell: sent.cell })
    }
    if (this.input.consume('dash')) {
      const sent = this.predictor.dash(present)
      if (sent) {
        this.hooks.send({ type: 'dash', round: this.predictor.round, seq: sent.seq, tick: sent.tick })
        this.audio.play('dash')
        const seat = this.role as Seat
        this.fx.puff(this.worldOf(seat), 0.6, PALETTE[SEATS.indexOf(seat)].css)
      }
    }
  }

  // ---------- presentation ----------

  private syncAvatars(): void {
    const seats = this.room?.seats ?? {}
    if (this.avatarRole !== this.role) {
      for (const avatar of this.avatars.values()) avatar.dispose()
      this.avatars.clear()
      this.avatarRole = this.role
    }
    for (const seat of SEATS) {
      const has = Boolean(seats[seat])
      const avatar = this.avatars.get(seat)
      if (has && !avatar) {
        const created = new Avatar(this.painterTemplate, this.clips, seat, seat === this.role)
        this.avatars.set(seat, created)
        this.scene.add(created.root)
      } else if (!has && avatar) {
        avatar.dispose()
        this.avatars.delete(seat)
      }
      let label = this.labels.get(seat)
      if (has && !label) {
        label = document.createElement('div')
        label.className = `name-tag seat-${seat}`
        this.labelLayer.appendChild(label)
        this.labels.set(seat, label)
      } else if (!has && label) {
        label.remove()
        this.labels.delete(seat)
      }
    }
  }

  private fitCamera(w: number, h: number): void {
    const touch = document.body.classList.contains('has-touch')
    const key = `${w}x${h}:${CONFIG.camera.tilt}:${CONFIG.camera.fov}:${touch}`
    if (key === this.fitKey) return
    this.fitKey = key
    const portrait = h > w * 1.08
    const tilt = THREE.MathUtils.degToRad(CONFIG.camera.tilt)
    const dir = portrait ? new THREE.Vector3(Math.cos(tilt), Math.sin(tilt), 0) : new THREE.Vector3(0, Math.sin(tilt), Math.cos(tilt))
    const target = new THREE.Vector3(0, 0, 0)
    const cam = this.camera
    cam.fov = CONFIG.camera.fov
    cam.aspect = w / h
    cam.clearViewOffset()
    cam.updateProjectionMatrix()
    const hx = COLS / 2 + 0.7
    const hz = ROWS / 2 + 0.7
    const points: THREE.Vector3[] = []
    for (const x of [-hx, hx]) for (const z of [-hz, hz]) for (const y of [0, 1.7]) points.push(new THREE.Vector3(x, y, z))
    const measure = (d: number) => {
      cam.position.copy(target).addScaledVector(dir, d)
      cam.lookAt(target)
      cam.updateMatrixWorld(true)
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const p of points) {
        const v = this.project.copy(p).project(cam)
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y)
      }
      return { minX, maxX, minY, maxY }
    }
    const topPx = w < 640 ? 96 : 108
    const bottomPx = touch ? 30 : 22
    const sidePx = 14
    const availW = ((w - sidePx * 2) / w) * 2
    const availH = ((h - topPx - bottomPx) / h) * 2
    let lo = 4
    let hi = 400
    for (let i = 0; i < 32; i += 1) {
      const mid = (lo + hi) / 2
      const b = measure(mid)
      if (b.maxX - b.minX <= availW && b.maxY - b.minY <= availH) hi = mid
      else lo = mid
    }
    const b = measure(hi)
    const desired = ((1 - (2 * topPx) / h) + (-1 + (2 * bottomPx) / h)) / 2
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    cam.setViewOffset(w, h, (cx * w) / 2, ((cy - desired) * h) / 2, w, h)
    cam.updateProjectionMatrix()
    this.basePosition.copy(cam.position)
    // Screen direction -> grid direction, whichever way the board is turned.
    const origin = new THREE.Vector3().project(cam)
    const screen: Record<ScreenDir, THREE.Vector2> = { up: new THREE.Vector2(0, 1), down: new THREE.Vector2(0, -1), left: new THREE.Vector2(-1, 0), right: new THREE.Vector2(1, 0) }
    for (const sd of SCREEN_DIRS) {
      let best: Dir = 1
      let bestDot = -Infinity
      for (const g of [1, 2, 3, 4] as const) {
        const v = GRID_VECTORS[g].clone().project(cam)
        const d = new THREE.Vector2((v.x - origin.x) * w, (v.y - origin.y) * h).normalize().dot(screen[sd])
        if (d > bestDot) { bestDot = d; best = g }
      }
      this.dirMap[sd] = best
    }
  }

  /** Called once per rendered frame. */
  frame(dt: number): void {
    const room = this.room
    const phase = room?.phase ?? 'lobby'
    this.handleInput()
    this.predictor.decay(dt)
    const present = this.present()
    const live = phase === 'live' && this.haveSnap

    // Board colours: server grid + predicted paint.
    if (live || (phase === 'results' && this.haveSnap)) {
      const grid = live ? this.predictor.displayGrid(present) : this.predictor.grid
      const changed = this.board.setGrid(grid, true)
      if (live) this.paintFeedback(changed)
      this.countShares(grid)
    } else {
      this.shares = []
    }

    // Painters.
    const shown = (live || phase === 'results') && this.haveSnap ? this.predictor.shown(present) : {}
    const own = this.role !== 'spectator' ? shown[this.role] : undefined
    this.dashReady = own ? 1 - own.cd / DASH_COOLDOWN : 1
    this.stunned = Boolean(own && own.stun > 0 && phase === 'live')
    for (const [seat, avatar] of this.avatars) {
      const s = shown[seat]
      if (s) {
        avatar.root.visible = true
        avatar.set({ wx: worldX(s.x), wz: worldZ(s.y), face: s.face, moving: phase === 'live' && s.moving && s.stun === 0, stun: phase === 'live' ? s.stun : 0, dash: phase === 'live' ? s.dash : 0, away: s.away, idleOnly: phase !== 'live' }, dt)
      } else {
        // Lobby, countdown, or benched until the next round: stand on the spawn.
        const spawn = SPAWNS[seat]
        const info = room?.seats[seat]
        const benched = (phase === 'live' || phase === 'results') && this.haveSnap
        avatar.root.visible = !benched
        avatar.set({ wx: worldX(centerX(spawn.cell)), wz: worldZ(centerY(spawn.cell)), face: spawn.dir, moving: false, stun: 0, dash: 0, away: Boolean(info && !info.connected) }, dt)
      }
      avatar.update(dt)
    }

    this.timers(present, dt)
    this.board.update(dt)
    this.fx.update(dt)

    // Camera fit and shake.
    const w = this.renderer.canvas.clientWidth || window.innerWidth
    const h = this.renderer.canvas.clientHeight || window.innerHeight
    this.fitCamera(w, h)
    this.shake = Math.max(0, this.shake - dt * 1.6)
    const amp = this.shake * this.shake * CONFIG.look.shake
    this.camera.position.copy(this.basePosition).add(new THREE.Vector3((Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp))
    this.renderer.render(this.scene, this.camera)
    this.placeLabels(w, h, shown)
  }

  private paintFeedback(changed: Array<{ cell: number; value: number; was: number }>): void {
    const me = this.role === 'spectator' ? 0 : SEATS.indexOf(this.role) + 1
    let mine = 0
    for (const c of changed) {
      if (c.value === 0) continue
      const at = cellWorld(c.cell).setY(0.15)
      const palette = PALETTE[c.value - 1]
      this.fx.burst(at, palette.css, c.value === me ? 5 : 3, c.value === me ? 3.4 : 2.4)
      if (c.value === me) mine += 1
    }
    if (mine > 0) {
      this.combo += mine
      this.comboTimer = 0.55
      this.audio.paint(this.combo)
    }
  }

  private countShares(grid: Uint8Array): void {
    const counts = [0, 0, 0, 0, 0]
    for (let i = 0; i < CELLS; i += 1) if (grid[i] !== WALL && grid[i] <= 4) counts[grid[i]] += 1
    const seats = this.room?.result && this.room.phase === 'results' ? this.room.result.order.map(r => r.seat) : SEATS.filter(s => this.predictor.players[s])
    this.shares = seats.map(seat => {
      const cells = counts[SEATS.indexOf(seat) + 1]
      return { seat, cells, pct: (cells / PLAYABLE) * 100 }
    })
  }

  private timers(present: number, dt: number): void {
    const room = this.room
    this.comboTimer -= dt
    if (this.comboTimer <= 0) this.combo = 0
    if (!room) { this.audio.setMusic('lobby'); return }
    const now = this.clock.serverNow()
    if (room.phase === 'countdown') {
      const second = Math.ceil((room.ends_at - now) / 1000)
      if (second !== this.lastSecond && second >= 1 && second <= 3) this.audio.play('count')
      this.lastSecond = second
      this.audio.setMusic('lobby')
    } else if (room.phase === 'live') {
      const second = Math.ceil((room.ends_at - now) / 1000)
      if (second !== this.lastSecond && second <= 10 && second >= 1) this.audio.play('tick')
      this.lastSecond = second
      this.audio.setMusic(isFrenzy(Math.floor(present)) ? 'frenzy' : 'live')
    } else {
      this.audio.setMusic('lobby')
    }
  }

  private placeLabels(w: number, h: number, shown: ReturnType<Predictor['shown']>): void {
    const room = this.room
    for (const [seat, label] of this.labels) {
      const avatar = this.avatars.get(seat)
      const info = room?.seats[seat]
      if (!avatar || !info || !avatar.root.visible) { label.style.display = 'none'; continue }
      const p = this.project.copy(avatar.root.position).setY(1.95).project(this.camera)
      label.style.display = ''
      label.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -100%)`
      const away = Boolean(shown[seat]?.away) || !info.connected
      const mine = seat === this.role
      const ready = room.phase !== 'live' && info.ready
      const text = `${info.name}${mine ? '（你）' : ''}`
      const status = away ? '重连中…' : ready ? '已准备' : ''
      const html = `<b>${escapeHtml(text)}</b>${status ? `<i>${status}</i>` : ''}`
      if (label.dataset.html !== html) {
        label.innerHTML = html
        label.dataset.html = html
      }
      label.classList.toggle('is-away', away)
      label.classList.toggle('is-mine', mine)
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.fx.reduced = reduced
  }

  hud(): Hud {
    const room = this.room
    const now = this.clock.serverNow()
    const remainingMs = room && (room.phase === 'live' || room.phase === 'countdown') ? Math.max(0, room.ends_at - now) : 0
    return {
      remainingMs,
      frenzy: room?.phase === 'live' && isFrenzy(Math.floor(this.present())),
      shares: this.shares,
      dashReady: Math.max(0, Math.min(1, this.dashReady)),
      stunned: this.stunned,
      playing: this.steering(),
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
