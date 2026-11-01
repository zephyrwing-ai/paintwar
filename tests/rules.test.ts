import { describe, expect, it } from 'vitest'
import {
  CELL, COLS, DASH_SPEED, DASH_TICKS, PLAYABLE, SPEED, WALL, applyDash, applyTurn, brushCells, cellOf, centerX, centerY,
  createGrid, decodeGrid, encodeGrid, rank, spawnMover, step, type Dir, type Mover,
} from '../shared/rules'
import { cleanName, cleanRoom, parseClientMessage } from '../shared/protocol'
import { Predictor } from '../src/game/predict'
import type { PlayerSnap, SnapMsg } from '../shared/protocol'

const grid = createGrid()
const run = (m: Mover, ticks: number) => { for (let i = 0; i < ticks; i += 1) step(m, grid, false) }

describe('arena', () => {
  it('is mirrored, keeps spawns free and encodes losslessly', () => {
    for (let i = 0; i < grid.length; i += 1) {
      const x = i % COLS
      const y = Math.floor(i / COLS)
      expect(grid[i]).toBe(grid[(15 - y) * COLS + (23 - x)])
    }
    for (const seat of ['p1', 'p2', 'p3', 'p4'] as const) expect(grid[cellOf(spawnMover(seat))]).not.toBe(WALL)
    expect(PLAYABLE).toBeGreaterThan(300)
    expect(decodeGrid(encodeGrid(grid))).toEqual(grid)
    expect(decodeGrid('x')).toBeNull()
  })
})

describe('movement', () => {
  it('moves whole units, turns only at centres and stops at walls', () => {
    const m = spawnMover('p1')
    run(m, 4)
    expect(m.x).toBe(centerX(COLS + 1) + 4 * SPEED)
    applyTurn(m, grid, 3, COLS + 3) // down at (3,1): (3,2) and (4,2) are walls -> stays queued
    run(m, 4)
    expect(m.dir).toBe(2)
    expect(m.want).toBe(3)
    run(m, 9) // passes (4,1), turns at (5,1) where down is open, then moves one tick down
    expect(m.dir).toBe(3)
    expect(m.x).toBe(centerX(COLS + 5))
    expect(m.y).toBe(centerY(COLS + 5) + SPEED)
  })

  it('rewinds a late turn within one cell of the same segment', () => {
    const m = spawnMover('p1')
    run(m, 8) // x = 6 + 24 + 24 -> 2 cells + 0 past (5 is (3,1))
    const target = COLS + 3
    const ref = spawnMover('p1')
    run(ref, 4)
    applyTurn(ref, grid, 1, target)
    run(ref, 4)
    // Same request 4 ticks late (12 units past the centre): rewound to the same result.
    applyTurn(m, grid, 1, target)
    expect(m).toEqual(ref)
  })

  it('does not rewind beyond the tolerance', () => {
    const m = spawnMover('p1')
    run(m, 12)
    expect(applyTurn(m, grid, 1, COLS + 2)).toBe('queued')
  })

  it('dash catch-up covers the same distance as an on-time dash', () => {
    const a = spawnMover('p1')
    const b = spawnMover('p1')
    applyDash(a, grid, 0, false)
    run(a, 6)
    run(b, 2)
    applyDash(b, grid, 2, false)
    run(b, 4)
    expect(b.x).toBe(a.x)
    expect(a.x).toBe(centerX(COLS + 1) + DASH_TICKS * DASH_SPEED + 2 * SPEED)
  })

  it('frenzy brush paints three cells across the heading', () => {
    expect(brushCells(grid, 5 * COLS + 10, 2, true).sort()).toEqual([4 * COLS + 10, 5 * COLS + 10, 6 * COLS + 10].sort())
    expect(brushCells(grid, 5 * COLS + 10, 2, false)).toEqual([5 * COLS + 10])
  })
})

describe('ranking', () => {
  it('breaks ties by hits, then bombs, then calls a draw', () => {
    expect(rank([{ seat: 'p1', cells: 10, hits: 0, bombs: 0 }, { seat: 'p2', cells: 12, hits: 0, bombs: 0 }]).winner).toBe('p2')
    expect(rank([{ seat: 'p1', cells: 10, hits: 2, bombs: 0 }, { seat: 'p2', cells: 10, hits: 1, bombs: 5 }]).winner).toBe('p1')
    expect(rank([{ seat: 'p1', cells: 10, hits: 1, bombs: 1 }, { seat: 'p2', cells: 10, hits: 1, bombs: 2 }]).winner).toBe('p2')
    expect(rank([{ seat: 'p1', cells: 10, hits: 1, bombs: 1 }, { seat: 'p2', cells: 10, hits: 1, bombs: 1 }]).winner).toBe('')
    expect(rank([{ seat: 'p3', cells: 0, hits: 0, bombs: 0 }]).winner).toBe('p3')
  })
})

describe('protocol validation', () => {
  it('cleans room codes and names', () => {
    expect(cleanRoom(' abcd ')).toBe('ABCD')
    expect(cleanRoom('ABC0')).toBe('') // 0/O/1/I are excluded to avoid confusion
    expect(cleanName('  小<b>红\u0000  ')).toBe('小b红')
    expect(cleanName('一二三四五六七八九十')).toBe('一二三四五六七八')
  })

  it('accepts only well-formed intents', () => {
    expect(parseClientMessage({ type: 'turn', round: 1, seq: 1, dir: 2, cell: 30 })).toBeTruthy()
    expect(parseClientMessage({ type: 'turn', round: 1, seq: 1, dir: 5, cell: 30 })).toBeNull()
    expect(parseClientMessage({ type: 'turn', round: 1, seq: 1, dir: 2, cell: 9999 })).toBeNull()
    expect(parseClientMessage({ type: 'dash', round: 1, seq: 0, tick: 3 })).toBeNull()
    expect(parseClientMessage({ type: 'move', x: 5 })).toBeNull() // positions are never accepted
    expect(parseClientMessage({ type: 'ready', ready: 'yes' })).toBeNull()
  })
})

// ---- prediction converges with the authoritative result ----

const snapOf = (m: Mover, tick: number, ack: number): SnapMsg => ({
  type: 'snap', marker: 'paint-war-v1', room: 'TEST', seq: tick + 1, round: 1, tick, grid: encodeGrid(createGrid()), bombs: [], ev: [],
  players: { p1: { x: m.x, y: m.y, dir: m.dir, face: m.face, want: m.want, wc: m.wantCell, sx: m.segX, sy: m.segY, dash: m.dash, cd: m.cd, stun: m.stun, away: false, ack, cells: 0, hits: 0, bombs: 0 } as PlayerSnap },
})

function scenario(latency: number, presses: Array<{ tick: number; dir?: Dir; dash?: boolean }>, ticks = 80) {
  const server = spawnMover('p1')
  const client = new Predictor()
  client.self = 'p1'
  client.apply(snapOf(server, 0, 0), 0)
  const inbox: Array<{ at: number; msg: { kind: 'turn'; seq: number; dir: Dir; cell: number } | { kind: 'dash'; seq: number; tick: number } }> = []
  const snaps: Array<{ at: number; snap: SnapMsg }> = []
  let ack = 0
  for (let tick = 0; tick < ticks; tick += 1) {
    // Client: snapshots that have arrived by now, then presses at this tick.
    while (snaps.length && snaps[0].at <= tick) client.apply(snaps.shift()!.snap, tick)
    for (const press of presses.filter(p => p.tick === tick)) {
      if (press.dash) {
        const sent = client.dash(tick)
        if (sent) inbox.push({ at: tick + latency, msg: { kind: 'dash', seq: sent.seq, tick: sent.tick } })
      } else {
        const sent = client.turn(tick, press.dir!)
        if (sent) inbox.push({ at: tick + latency, msg: { kind: 'turn', seq: sent.seq, dir: sent.dir, cell: sent.cell } })
      }
    }
    // Server: intents that arrived by this tick, then one step.
    while (inbox.length && inbox[0].at <= tick) {
      const { msg } = inbox.shift()!
      if (msg.kind === 'turn') applyTurn(server, grid, msg.dir, msg.cell)
      else applyDash(server, grid, tick - msg.tick, false)
      ack = msg.seq
    }
    step(server, grid, false)
    snaps.push({ at: tick + 1 + latency, snap: snapOf(server, tick + 1, ack) })
  }
  // Let every message settle, then compare the client's present with the server.
  while (snaps.length) client.apply(snaps.shift()!.snap, ticks)
  return { server, predicted: client.positions(ticks).p1! }
}

describe('prediction', () => {
  for (const latency of [0, 1, 2, 3, 4]) {
    it(`matches the server with ${latency * 50} ms one-way latency`, () => {
      const { server, predicted } = scenario(latency, [
        { tick: 5, dir: 3 }, { tick: 14, dir: 2 }, { tick: 22, dash: true }, { tick: 30, dir: 1 }, { tick: 41, dir: 4 }, { tick: 55, dir: 3 },
      ])
      expect({ x: predicted.x, y: predicted.y }).toEqual({ x: server.x, y: server.y })
    })
  }

  it('own turns are shown immediately (no round trip)', () => {
    const client = new Predictor()
    client.self = 'p1'
    const m = spawnMover('p1')
    run(m, 6) // between centres of (2,1) and (3,1)
    client.apply(snapOf(m, 6, 0), 6)
    client.turn(6, 3) // down at the next centre; (3,2) is a wall so it stays queued, fine for heading
    client.turn(6, 1)
    const later = client.positions(10).p1!
    expect(later.y).toBeLessThan(centerY(COLS + 1)) // already moving up before any server reply
    expect(later.x % CELL).toBe(6)
  })
})
