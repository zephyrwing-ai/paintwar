/**
 * Client-side prediction on top of the authoritative snapshots.
 *
 * Every snapshot is the truth at server tick T. To draw the present (tick P > T, from the server
 * clock), the browser re-runs the shared simulation from T to P:
 *  - its own painter with every intent the server has not acknowledged yet, so input feels
 *    instant (the server later reaches the same path: late turns are rewound on the server);
 *  - other painters with their last known heading and queued turn (a turn they made in the last
 *    few ticks is not known yet and gets corrected when the next snapshot arrives).
 * Hits, stuns, bombs and scores are never predicted; they only come from the server.
 * Visual corrections are blended out over a short time instead of popping.
 */
import {
  CELL, HALF, SEATS, TICK_MS, WALL, applyDash, applyTurn, atCenter, blocked, brushCells, cellOf, centerX, centerY,
  cloneMover, createGrid, decodeGrid, isFrenzy, neighbor, step, type Dir, type Mover, type Seat,
} from '../../shared/rules.ts'
import type { PlayerSnap, SnapMsg } from '../../shared/protocol.ts'

export type Pending =
  | { kind: 'turn'; seq: number; tick: number; dir: Dir; cell: number }
  | { kind: 'dash'; seq: number; tick: number }

export type Shown = { x: number; y: number; dir: Dir; face: Dir; dash: number; stun: number; cd: number; away: boolean; moving: boolean }

/** Furthest the present may run ahead of the newest snapshot before painters wait for data. */
export const MAX_AHEAD_TICKS = 10
/** A correction longer than this (units) is applied at once instead of blended. */
export const SNAP_DISTANCE = CELL * 2.5
/** Turns pressed this soon after passing a centre are attributed to that centre. */
export const CORNER_GRACE = 4

const WALLS = createGrid()

export function moverFromSnap(p: PlayerSnap): Mover {
  return { x: p.x, y: p.y, dir: p.dir, face: p.face, want: p.want, wantCell: p.wc, segX: p.sx, segY: p.sy, dash: p.dash, cd: p.cd, stun: p.stun }
}

export class Predictor {
  self: Seat | null = null
  round = 0
  baseTick = 0
  grid: Uint8Array = createGrid()
  players: Partial<Record<Seat, PlayerSnap>> = {}
  pending: Pending[] = []
  seq = 0
  /** Visual error per seat (units), blended toward zero. */
  private error = new Map<Seat, { x: number; y: number }>()
  private cache = new Map<number, SimResult>()

  reset(round: number): void {
    this.round = round
    this.baseTick = 0
    this.players = {}
    this.pending = []
    this.grid = createGrid()
    this.error.clear()
    this.cache.clear()
  }

  /** New connection: intent numbering restarts and unacknowledged intents are void. */
  resetIntents(): void {
    this.seq = 0
    this.pending = []
    this.cache.clear()
  }

  /**
   * Adopts a snapshot. `presentTick` is where the painters are drawn now: the predicted positions
   * before and after are compared so the change becomes a blended correction, not a jump.
   */
  apply(snap: SnapMsg, presentTick: number): void {
    const grid = decodeGrid(snap.grid)
    if (!grid) return
    const fresh = snap.round !== this.round
    const before = fresh ? null : this.positions(presentTick)
    if (fresh) this.reset(snap.round)
    this.baseTick = snap.tick
    this.grid = grid
    this.players = snap.players
    const own = this.self ? snap.players[this.self] : undefined
    if (own) this.pending = this.pending.filter(p => p.seq > own.ack)
    this.cache.clear()
    if (!before) return
    const after = this.positions(presentTick)
    for (const seat of SEATS) {
      const a = before[seat]
      const b = after[seat]
      if (!a || !b) { this.error.delete(seat); continue }
      const e = this.error.get(seat) ?? { x: 0, y: 0 }
      e.x += a.x - b.x
      e.y += a.y - b.y
      if (Math.hypot(e.x, e.y) > SNAP_DISTANCE) { e.x = 0; e.y = 0 }
      this.error.set(seat, e)
    }
  }

  /** Blends visual corrections out; own painter faster (it should feel exact). */
  decay(dt: number): void {
    for (const [seat, e] of this.error) {
      const k = Math.exp(-dt / (seat === this.self ? 0.07 : 0.11))
      e.x *= k
      e.y *= k
    }
  }

  clampTick(presentTick: number): number {
    return Math.max(this.baseTick, Math.min(presentTick, this.baseTick + MAX_AHEAD_TICKS))
  }

  /** Simulates from the snapshot to the integer tick `to` (cached per tick). */
  simulate(to: number): SimResult {
    const cached = this.cache.get(to)
    if (cached) return cached
    const movers: Partial<Record<Seat, Mover>> = {}
    for (const seat of SEATS) {
      const p = this.players[seat]
      if (p) movers[seat] = moverFromSnap(p)
    }
    const painted: Array<{ cell: number; seat: Seat }> = []
    const mine = this.self ? this.pending : []
    for (let k = this.baseTick; k < to; k += 1) {
      const frenzy = isFrenzy(k)
      const own = this.self ? movers[this.self] : undefined
      if (own && this.self) {
        const seat = this.self
        const enter = (cell: number, dir: Dir) => { for (const c of brushCells(WALLS, cell, dir, frenzy)) painted.push({ cell: c, seat }) }
        for (const intent of mine) {
          if (Math.max(intent.tick, this.baseTick) !== k) continue
          if (intent.kind === 'turn') applyTurn(own, WALLS, intent.dir, intent.cell, enter)
          else applyDash(own, WALLS, k - intent.tick, frenzy, enter)
        }
      }
      for (const seat of SEATS) {
        const m = movers[seat]
        if (!m || this.players[seat]?.away) continue
        step(m, WALLS, frenzy, (cell, dir) => { for (const c of brushCells(WALLS, cell, dir, frenzy)) painted.push({ cell: c, seat }) })
      }
    }
    const result = { movers, painted }
    if (this.cache.size > 6) this.cache.clear()
    this.cache.set(to, result)
    return result
  }

  /** Display positions at a fractional tick (interpolated between whole ticks), without error. */
  positions(presentTick: number): Partial<Record<Seat, Shown>> {
    const p = this.clampTick(presentTick)
    const k = Math.floor(p)
    const frac = p - k
    const a = this.simulate(k).movers
    const b = frac > 0 ? this.simulate(k + 1).movers : a
    const out: Partial<Record<Seat, Shown>> = {}
    for (const seat of SEATS) {
      const ma = a[seat]
      const mb = b[seat]
      if (!ma || !mb) continue
      const jump = Math.abs(mb.x - ma.x) + Math.abs(mb.y - ma.y) > CELL * 1.5
      out[seat] = {
        x: jump ? mb.x : ma.x + (mb.x - ma.x) * frac,
        y: jump ? mb.y : ma.y + (mb.y - ma.y) * frac,
        dir: mb.dir, face: mb.face || ma.face, dash: mb.dash, stun: ma.stun, cd: ma.cd,
        away: Boolean(this.players[seat]?.away),
        moving: ma.x !== mb.x || ma.y !== mb.y || (mb.dir !== 0 && ma.stun === 0),
      }
    }
    return out
  }

  /** Display positions including blended corrections. */
  shown(presentTick: number): Partial<Record<Seat, Shown>> {
    const out = this.positions(presentTick)
    for (const seat of SEATS) {
      const s = out[seat]
      const e = this.error.get(seat)
      if (s && e) { s.x += e.x; s.y += e.y }
    }
    return out
  }

  /** The server grid plus paint predicted between the snapshot and the present. */
  displayGrid(presentTick: number): Uint8Array {
    const k = Math.floor(this.clampTick(presentTick))
    const grid = this.grid.slice()
    for (const { cell, seat } of this.simulate(k).painted) {
      if (grid[cell] !== WALL) grid[cell] = SEATS.indexOf(seat) + 1
    }
    return grid
  }

  /** The own painter's state at the current whole tick (what an intent is applied to). */
  ownNow(presentTick: number): Mover | null {
    if (!this.self) return null
    const m = this.simulate(Math.floor(this.clampTick(presentTick))).movers[this.self]
    return m ? cloneMover(m) : null
  }

  /**
   * Chooses the cell a turn pressed now belongs to: the centre the painter is on, the centre it
   * passed a moment ago (cornering grace), or the next centre ahead.
   */
  turnCell(m: Mover, dir: Dir): number {
    const here = cellOf(m)
    if (m.dir === 0 || atCenter(m)) return here
    const lastCenter = centerCellBehind(m)
    const past = Math.abs(m.x - centerX(lastCenter)) + Math.abs(m.y - centerY(lastCenter))
    if (past <= CORNER_GRACE && dir !== m.dir && !blocked(WALLS, lastCenter, dir)) return lastCenter
    const next = neighbor(lastCenter, m.dir)
    return next >= 0 ? next : here
  }

  /** Records a local intent and returns the message to send, or null when it changes nothing. */
  turn(presentTick: number, dir: Dir): { seq: number; dir: Dir; cell: number; tick: number } | null {
    const m = this.ownNow(presentTick)
    if (!m) return null
    const tick = Math.floor(this.clampTick(presentTick))
    const cell = this.turnCell(m, dir)
    this.seq += 1
    this.pending.push({ kind: 'turn', seq: this.seq, tick, dir, cell })
    this.cache.clear()
    return { seq: this.seq, dir, cell, tick }
  }

  dash(presentTick: number): { seq: number; tick: number } | null {
    const m = this.ownNow(presentTick)
    if (!m || m.cd > 0 || m.stun > 0 || m.dash > 0 || m.dir === 0) return null
    const tick = Math.floor(this.clampTick(presentTick))
    this.seq += 1
    this.pending.push({ kind: 'dash', seq: this.seq, tick })
    this.cache.clear()
    return { seq: this.seq, tick }
  }
}

export type SimResult = { movers: Partial<Record<Seat, Mover>>; painted: Array<{ cell: number; seat: Seat }> }

/** The centre most recently passed along the heading (the current centre when on one). */
function centerCellBehind(m: Mover): number {
  const horizontal = m.dir === 2 || m.dir === 4
  const pos = horizontal ? m.x : m.y
  const off = (((pos - HALF) % CELL) + CELL) % CELL
  const forward = m.dir === 2 || m.dir === 3
  const last = off === 0 ? pos : forward ? pos - off : pos - off + CELL
  return horizontal ? cellOf({ x: last, y: m.y }) : cellOf({ x: m.x, y: last })
}

/** Converts a server-clock time to a fractional simulation tick of the live round. */
export const tickAt = (serverNow: number, liveAt: number): number => Math.max(0, (serverNow - liveAt) / TICK_MS)
