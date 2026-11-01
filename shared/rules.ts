/**
 * 涂地大作战 — shared game rules.
 *
 * Pure TypeScript with erasable syntax only: the browser bundles this file through Vite and the
 * Node server runs the very same file with built-in type stripping. Both sides therefore step an
 * identical simulation: the server's result is the truth, the browser uses it to predict its own
 * painter without waiting for a round trip.
 *
 * Units: one grid cell is `CELL` integer units wide and every speed divides evenly into integers,
 * so positions never accumulate floating-point drift and both sides compute bit-identical results.
 */

export const PROTOCOL = 'paint-war-v1'

export const TICK_MS = 50
export const COLS = 24
export const ROWS = 16
export const CELLS = COLS * ROWS
export const CELL = 12
export const HALF = CELL / 2

/** Units per tick: 5 cells/s normally, 6.7 cells/s during the frenzy, 20 cells/s while dashing. */
export const SPEED = 3
export const FRENZY_SPEED = 4
export const DASH_SPEED = 12
export const DASH_TICKS = 4
export const DASH_COOLDOWN = 60
export const STUN_TICKS = 20

export const ROUND_TICKS = 1800
export const FRENZY_TICKS = 300
export const COUNTDOWN_MS = 3000
export const BOMB_FIRST_TICK = 100
export const BOMB_EVERY = 140
export const MAX_BOMBS = 2

/** A turn may arrive this many units after the painter passed the requested cell centre. */
export const TURN_TOLERANCE = CELL
/** A dash request older than this many ticks is applied without catching up. */
export const DASH_CATCHUP = 6
/** Distance (units) between a dashing painter's path and another painter that counts as a hit. */
export const HIT_RADIUS = 10

export const SEATS = ['p1', 'p2', 'p3', 'p4'] as const
export type Seat = (typeof SEATS)[number]
export const MAX_PLAYERS = SEATS.length
export const MIN_PLAYERS = 2

/** Grid values: 0 = unpainted, 1..4 = painted by seat index + 1, WALL = obstacle. */
export const WALL = 9
export const seatColor = (seat: Seat): number => SEATS.indexOf(seat) + 1
export const colorSeat = (value: number): Seat | '' => (value >= 1 && value <= 4 ? SEATS[value - 1] : '')

/** 0 = none, 1 = up, 2 = right, 3 = down, 4 = left (screen orientation, +y points down). */
export type Dir = 0 | 1 | 2 | 3 | 4
export const DX: readonly number[] = [0, 0, 1, 0, -1]
export const DY: readonly number[] = [0, -1, 0, 1, 0]
export const isDir = (value: unknown): value is Dir => value === 1 || value === 2 || value === 3 || value === 4

// One quadrant of the arena; it is mirrored on both axes so every corner plays the same.
const QUADRANT = [
  '............',
  '............',
  '...##.......',
  '...#....##..',
  '........#...',
  '.....#......',
  '.....#......',
  '..........##',
]

export function createGrid(): Uint8Array {
  const grid = new Uint8Array(CELLS)
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      const qx = x < COLS / 2 ? x : COLS - 1 - x
      const qy = y < ROWS / 2 ? y : ROWS - 1 - y
      if (QUADRANT[qy][qx] === '#') grid[y * COLS + x] = WALL
    }
  }
  return grid
}

/** Cells a painter can stand on (the denominator of every percentage). */
export const PLAYABLE = createGrid().reduce((n, v) => n + (v === WALL ? 0 : 1), 0)

export const cellX = (cell: number): number => cell % COLS
export const cellY = (cell: number): number => Math.floor(cell / COLS)
export const centerX = (cell: number): number => cellX(cell) * CELL + HALF
export const centerY = (cell: number): number => cellY(cell) * CELL + HALF
export const validCell = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < CELLS

export function neighbor(cell: number, dir: Dir): number {
  const x = cellX(cell) + DX[dir]
  const y = cellY(cell) + DY[dir]
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return -1
  return y * COLS + x
}

export function blocked(grid: Uint8Array, cell: number, dir: Dir): boolean {
  if (dir === 0) return true
  const next = neighbor(cell, dir)
  return next < 0 || grid[next] === WALL
}

export const SPAWNS: Record<Seat, { cell: number; dir: Dir }> = {
  p1: { cell: 1 * COLS + 1, dir: 2 },
  p2: { cell: (ROWS - 2) * COLS + (COLS - 2), dir: 4 },
  p3: { cell: 1 * COLS + (COLS - 2), dir: 3 },
  p4: { cell: (ROWS - 2) * COLS + 1, dir: 1 },
}

/** Everything the simulation needs to move one painter. Plain data so it can be sent and cloned. */
export type Mover = {
  x: number
  y: number
  dir: Dir
  /** Last non-zero direction: the way the painter faces while stopped. */
  face: Dir
  /** Queued turn, applied at the centre of `wantCell` (or the next centre when -1). */
  want: Dir
  wantCell: number
  /** Where the current straight segment started; a late turn may rewind only within it. */
  segX: number
  segY: number
  dash: number
  cd: number
  stun: number
}

export function spawnMover(seat: Seat): Mover {
  const { cell, dir } = SPAWNS[seat]
  const x = centerX(cell)
  const y = centerY(cell)
  return { x, y, dir, face: dir, want: 0, wantCell: -1, segX: x, segY: y, dash: 0, cd: 0, stun: 0 }
}

export const cloneMover = (m: Mover): Mover => ({ ...m })
export const cellOf = (m: { x: number; y: number }): number => Math.floor(m.y / CELL) * COLS + Math.floor(m.x / CELL)
export const atCenter = (m: Mover): boolean => (m.x - HALF) % CELL === 0 && (m.y - HALF) % CELL === 0
export const isFrenzy = (tick: number): boolean => tick >= ROUND_TICKS - FRENZY_TICKS

/** Called whenever a painter's position crosses into a new cell. */
export type EnterHook = (cell: number, dir: Dir) => void

function distToNextCenter(m: Mover): number {
  const horizontal = DX[m.dir] !== 0
  const pos = horizontal ? m.x : m.y
  const sign = horizontal ? DX[m.dir] : DY[m.dir]
  const off = (((pos - HALF) % CELL) + CELL) % CELL
  if (off === 0) return CELL
  return sign > 0 ? CELL - off : off
}

/** Signed distance from the painter to a cell centre along its heading (positive = ahead). */
function alongTo(m: Mover, dir: Dir, cell: number): { along: number; onLine: boolean } {
  const cx = centerX(cell)
  const cy = centerY(cell)
  const onLine = DX[dir] !== 0 ? cy === m.y : cx === m.x
  return { along: (cx - m.x) * DX[dir] + (cy - m.y) * DY[dir], onLine }
}

/** Moves a painter `units` along the grid, turning and stopping only at cell centres. */
export function move(m: Mover, grid: Uint8Array, units: number, onEnter?: EnterHook): void {
  let rem = units
  for (let guard = 0; rem > 0 && guard < 16; guard += 1) {
    if (atCenter(m)) {
      const here = cellOf(m)
      if (m.want !== 0) {
        if (m.wantCell >= 0 && m.wantCell !== here && m.dir !== 0) {
          const { along, onLine } = alongTo(m, m.dir, m.wantCell)
          if (!onLine || along < 0) m.wantCell = -1
        }
        if (m.wantCell < 0 || m.wantCell === here || m.dir === 0) {
          if (!blocked(grid, here, m.want)) {
            if (m.want !== m.dir) {
              m.dir = m.want
              m.segX = m.x
              m.segY = m.y
            }
            m.face = m.dir
            m.want = 0
          }
          // A blocked turn stays queued and is tried again at the following centres.
          m.wantCell = -1
        }
      }
      if (m.dir === 0) return
      if (blocked(grid, here, m.dir)) {
        // Stopping keeps the segment start: a late turn may still rewind along it.
        m.dir = 0
        return
      }
    }
    if (m.dir === 0) return
    const step = Math.min(rem, distToNextCenter(m))
    const before = cellOf(m)
    m.x += DX[m.dir] * step
    m.y += DY[m.dir] * step
    const after = cellOf(m)
    if (after !== before) onEnter?.(after, m.dir)
    rem -= step
  }
}

export const speedFor = (m: Mover, frenzy: boolean): number => (m.dash > 0 ? DASH_SPEED : frenzy ? FRENZY_SPEED : SPEED)

/** One simulation tick for one painter. Returns true when the painter was dashing this tick. */
export function step(m: Mover, grid: Uint8Array, frenzy: boolean, onEnter?: EnterHook): boolean {
  if (m.cd > 0) m.cd -= 1
  if (m.stun > 0) {
    m.stun -= 1
    return false
  }
  const dashing = m.dash > 0
  const units = speedFor(m, frenzy)
  if (dashing) m.dash -= 1
  move(m, grid, units, onEnter)
  return dashing
}

/**
 * Applies "turn to `dir` at the centre of `cell`". Ahead on the current line: queued for that
 * centre. Already passed by at most `TURN_TOLERANCE` on the same straight segment (the request
 * was delayed by the network): the painter is rewound to that centre, turned, and moved forward
 * again by the distance it overshot, so the result matches what its player saw. Otherwise the
 * turn is queued for the next centre. Returns 'rewind' when a rewind happened.
 */
export function applyTurn(
  m: Mover, grid: Uint8Array, dir: Dir, cell: number,
  onEnter?: EnterHook, onRewind?: (cell: number, oldDir: Dir) => void,
): 'queued' | 'rewind' {
  if (!isDir(dir) || !validCell(cell)) return 'queued'
  if (m.stun > 0) {
    m.want = dir
    m.wantCell = -1
    return 'queued'
  }
  const heading = m.dir !== 0 ? m.dir : m.face
  if (heading !== 0 && dir !== heading) {
    const { along, onLine } = alongTo(m, heading, cell)
    if (onLine && along >= 0 && m.dir !== 0) {
      m.want = dir
      m.wantCell = cell
      return 'queued'
    }
    if (onLine && along < 0) {
      const back = -along
      const seg = (m.segX - m.x) * DX[heading] + (m.segY - m.y) * DY[heading]
      if (back <= TURN_TOLERANCE && -seg >= back && !blocked(grid, cell, dir)) {
        m.x = centerX(cell)
        m.y = centerY(cell)
        onRewind?.(cell, heading)
        m.dir = dir
        m.face = dir
        m.segX = m.x
        m.segY = m.y
        m.want = 0
        m.wantCell = -1
        move(m, grid, back, onEnter)
        return 'rewind'
      }
    }
  }
  m.want = dir
  m.wantCell = -1
  return 'queued'
}

/** Whether a dash may start now (both sides check the same conditions). */
export const canDash = (m: Mover): boolean => m.cd === 0 && m.stun === 0 && m.dash === 0 && m.dir !== 0

/**
 * Starts a dash that the player pressed `ticksAgo` ticks earlier. Missed dash ticks are caught up
 * at once (bounded), so a delayed request covers the same distance its player saw.
 */
export function applyDash(m: Mover, grid: Uint8Array, ticksAgo: number, frenzy: boolean, onEnter?: EnterHook): boolean {
  if (!canDash(m)) return false
  m.dash = DASH_TICKS
  m.cd = DASH_COOLDOWN
  const late = ticksAgo > DASH_CATCHUP ? 0 : Math.max(0, Math.min(Math.floor(ticksAgo), DASH_TICKS - 1))
  const base = frenzy ? FRENZY_SPEED : SPEED
  for (let i = 0; i < late; i += 1) {
    move(m, grid, DASH_SPEED - base, onEnter)
    m.dash -= 1
    m.cd -= 1
  }
  return true
}

/** Cells painted when a painter enters `cell`: the frenzy brush is three cells wide. */
export function brushCells(grid: Uint8Array, cell: number, dir: Dir, frenzy: boolean): number[] {
  const out = [cell]
  if (!frenzy || dir === 0) return out
  const sides: Dir[] = DX[dir] !== 0 ? [1, 3] : [2, 4]
  for (const side of sides) {
    const next = neighbor(cell, side)
    if (next >= 0 && grid[next] !== WALL) out.push(next)
  }
  return out
}

/** The 3×3 burst of a paint bomb. */
export function bombCells(grid: Uint8Array, cell: number): number[] {
  const out: number[] = []
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = cellX(cell) + dx
      const y = cellY(cell) + dy
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue
      const c = y * COLS + x
      if (grid[c] !== WALL) out.push(c)
    }
  }
  return out
}

/** The plus-shaped splat a dash hit leaves under the stunned painter. */
export function splatCells(grid: Uint8Array, cell: number): number[] {
  const out = grid[cell] === WALL ? [] : [cell]
  for (const dir of [1, 2, 3, 4] as Dir[]) {
    const next = neighbor(cell, dir)
    if (next >= 0 && grid[next] !== WALL) out.push(next)
  }
  return out
}

/** Shortest distance from point (px, py) to the segment (ax, ay)-(bx, by). */
export function segmentDistance(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const vx = bx - ax
  const vy = by - ay
  const len = vx * vx + vy * vy
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len)) : 0
  return Math.hypot(ax + vx * t - px, ay + vy * t - py)
}

export function countCells(grid: Uint8Array): Record<Seat, number> {
  const out: Record<Seat, number> = { p1: 0, p2: 0, p3: 0, p4: 0 }
  for (let i = 0; i < grid.length; i += 1) {
    const seat = colorSeat(grid[i])
    if (seat) out[seat] += 1
  }
  return out
}

export const encodeGrid = (grid: Uint8Array): string => String.fromCharCode(...Array.from(grid, v => 48 + v))

export function decodeGrid(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || text.length !== CELLS) return null
  const grid = new Uint8Array(CELLS)
  for (let i = 0; i < CELLS; i += 1) {
    const v = text.charCodeAt(i) - 48
    if (!(v >= 0 && v <= 4) && v !== WALL) return null
    grid[i] = v
  }
  return grid
}

export type Standing = { seat: Seat; cells: number; hits: number; bombs: number }

/** Most cells wins; ties fall back to dash hits, then bombs collected; still equal is a draw. */
export function rank(standings: Standing[]): { order: Standing[]; winner: Seat | '' } {
  const cmp = (a: Standing, b: Standing) => b.cells - a.cells || b.hits - a.hits || b.bombs - a.bombs
  const order = [...standings].sort((a, b) => cmp(a, b) || SEATS.indexOf(a.seat) - SEATS.indexOf(b.seat))
  if (order.length === 0) return { order, winner: '' }
  if (order.length === 1 || cmp(order[0], order[1]) !== 0) return { order, winner: order[0].seat }
  return { order, winner: '' }
}
