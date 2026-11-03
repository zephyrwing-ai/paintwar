#!/usr/bin/env node
/**
 * 涂地大作战 authoritative server. One process owns every room: seats, phases, the 20 Hz paint
 * simulation, scores and winners. Browsers only send intents (ready / turn / dash); positions,
 * paint, hits, bombs and the clock are decided here and broadcast as snapshots.
 *
 * Run with Node 22.18+ (built-in TypeScript type stripping): `node server.ts`.
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { stat, realpath } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import {
  BOMB_EVERY, BOMB_FIRST_TICK, CELLS, COUNTDOWN_MS, FRENZY_TICKS, HIT_RADIUS, MAX_BOMBS, MIN_PLAYERS, PLAYABLE,
  ROUND_TICKS, SEATS, SPAWNS, STUN_TICKS, TICK_MS, WALL,
  applyDash, applyTurn, bombCells, brushCells, cellOf, cellX, cellY, countCells, createGrid, encodeGrid,
  isFrenzy, neighbor, rank, seatColor, segmentDistance, spawnMover, splatCells, step,
  type Dir, type Mover, type Seat,
} from '../shared/rules.ts'
import {
  CHAT_CAPABILITY, CLOSE, MARKER, MAX_MESSAGE_BYTES, MAX_SIGNAL_BYTES, MAX_SOCKET_BYTES, RECONNECT_GRACE_MS,
  cleanName, cleanRoom, parseClientMessage, utf8ByteLength,
  type DashIntent, type ErrorCode, type EventInput, type GameEvent, type Phase, type PlayerSnap, type RoomMsg, type RoundResult,
  type SeatInfo, type SnapMsg, type TurnIntent,
} from '../shared/protocol.ts'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8787)
const STATIC_ROOT = resolve(process.env.STATIC_ROOT || join(dirname(fileURLToPath(import.meta.url)), '../dist'))
const ROOM_EMPTY_MS = Number(process.env.ROOM_EMPTY_MS || 5 * 60_000)
const GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || RECONNECT_GRACE_MS)
const LOOP_MS = 25
const MAX_ROOMS = 200
const MAX_CLIENTS = 600
const MAX_SPECTATORS = 8
const MAX_BUFFERED_BYTES = 128 * 1024
const MAX_MESSAGES_PER_SECOND = 60
const MAX_INTENTS_PER_TICK = 8
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean))
const allowedSuffixes = (process.env.ALLOWED_ORIGIN_SUFFIXES || '').split(',').map(v => v.trim()).filter(Boolean)
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('Invalid PORT')

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'], ['.ttf', 'font/ttf'], ['.woff2', 'font/woff2'], ['.glb', 'model/gltf-binary'],
  ['.ogg', 'audio/ogg'], ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.ico', 'image/x-icon'],
])

const token = () => randomBytes(18).toString('base64url')

function sendText(ws: WebSocket | null, text: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { ws.terminate(); return }
  ws.send(text)
}

type SeatState = {
  token: string
  socket: WebSocket | null
  name: string
  ready: boolean
  wins: number
  joined: number
  disconnectedAt: number
  /** Still painting in the current live round (false = watching until the next round). */
  inRound: boolean
  mover: Mover | null
  /** Highest intent seq received on the current socket; acknowledged once processed. */
  lastSeq: number
  ack: number
  intents: Array<TurnIntent | DashIntent>
  hits: number
  bombs: number
  /** Recent paint writes, so a rewound late turn can undo the cell it overshot into. */
  recent: Array<{ cell: number; prev: number; anchor: number }>
  hitTargets: Set<Seat>
}

const emptySeat = (): SeatState => ({
  token: '', socket: null, name: '', ready: false, wins: 0, joined: 0, disconnectedAt: 0, inRound: false, mover: null,
  lastSeq: 0, ack: 0, intents: [], hits: 0, bombs: 0, recent: [], hitTargets: new Set(),
})

type Client = { ws: WebSocket; room: Room; role: Seat | 'spectator'; name: string; alive: boolean; window: number; count: number }
const clients = new Map<WebSocket, Client>()
const rooms = new Map<string, Room>()

class Room {
  readonly code: string
  seq = 0
  round = 0
  phase: Phase = 'lobby'
  endsAt = 0
  liveAt = 0
  tick = 0
  countdownFrom: Phase = 'lobby'
  joinCounter = 0
  eventId = 0
  emptySince = 0
  seats: Record<Seat, SeatState> = { p1: emptySeat(), p2: emptySeat(), p3: emptySeat(), p4: emptySeat() }
  spectators: WebSocket[] = []
  grid = createGrid()
  bombs: number[] = []
  events: GameEvent[] = []
  result: RoundResult | null = null
  lastSnap = ''
  dirty = false

  constructor(code: string) {
    this.code = code
  }

  connected(seat: Seat): boolean {
    return this.seats[seat].socket?.readyState === WebSocket.OPEN
  }

  seated(): Seat[] {
    return SEATS.filter(seat => this.seats[seat].token)
  }

  host(): Seat | '' {
    const seated = this.seated()
    if (!seated.length) return ''
    return seated.reduce((a, b) => (this.seats[a].joined <= this.seats[b].joined ? a : b))
  }

  inRound(): Seat[] {
    return SEATS.filter(seat => this.seats[seat].inRound)
  }

  hasSockets(): boolean {
    return SEATS.some(seat => this.connected(seat)) || this.spectators.length > 0
  }

  emit(event: EventInput): void {
    this.eventId += 1
    this.events.push({ ...event, id: this.eventId } as GameEvent)
  }

  // ---------- membership ----------

  claim(ws: WebSocket, resume: string, name: string, now: number): void {
    let role: Seat | 'spectator' | '' = ''
    if (resume) {
      for (const seat of SEATS) {
        const s = this.seats[seat]
        if (!s.token || s.token !== resume) continue
        if (s.socket && s.socket !== ws) {
          const old = s.socket
          const oldClient = clients.get(old)
          if (oldClient) oldClient.role = 'spectator'
          old.close(CLOSE.replaced, 'seat resumed elsewhere')
        }
        this.attach(seat, ws)
        if (this.phase === 'live' && s.inRound) this.emit({ k: 'back', a: seat })
        role = seat
        break
      }
    }
    if (!role) role = this.seatNewcomer(ws, name)
    if (!role) {
      if (this.spectators.length >= MAX_SPECTATORS) {
        reject(ws, this.code, 'room_full', CLOSE.full)
        return
      }
      this.spectators.push(ws)
      role = 'spectator'
    }
    const client = clients.get(ws)
    if (client) client.role = role
    this.welcome(ws, role, now)
    this.evaluate(now)
    this.broadcastRoom()
  }

  private seatNewcomer(ws: WebSocket, name: string): Seat | '' {
    const seat = SEATS.find(s => !this.seats[s].token)
    if (!seat) return ''
    this.joinCounter += 1
    Object.assign(this.seats[seat], emptySeat(), { token: token(), name: name || `玩家${SEATS.indexOf(seat) + 1}`, joined: this.joinCounter })
    this.attach(seat, ws)
    return seat
  }

  private attach(seat: Seat, ws: WebSocket): void {
    const s = this.seats[seat]
    s.socket = ws
    s.disconnectedAt = 0
    s.lastSeq = 0
    s.ack = 0
    s.intents = []
  }

  private welcome(ws: WebSocket, role: Seat | 'spectator', now: number): void {
    const s = role === 'spectator' ? null : this.seats[role]
    sendText(ws, JSON.stringify({
      type: 'welcome', marker: MARKER, room: this.code, role, resume_token: s?.token ?? '', name: s?.name ?? '', now,
      capabilities: [CHAT_CAPABILITY],
    }))
    // Full state at once: the room, then the latest board (live, or the last round's final paint).
    sendText(ws, JSON.stringify(this.roomMessage()))
    if (this.phase === 'live') sendText(ws, JSON.stringify(this.snapMessage(false)))
    else if (this.lastSnap) sendText(ws, this.lastSnap)
  }

  /** Spectators take free seats in arrival order; during a round they watch until the next one. */
  private fillSeats(now: number): void {
    while (this.spectators.length) {
      const ws = this.spectators[0]
      if (ws.readyState !== WebSocket.OPEN) { this.spectators.shift(); continue }
      const client = clients.get(ws)
      const seat = this.seatNewcomer(ws, client?.name ?? '')
      if (!seat) break
      this.spectators.shift()
      if (client) client.role = seat
      this.welcome(ws, seat, now)
    }
  }

  release(ws: WebSocket, now: number): void {
    const client = clients.get(ws)
    if (client && client.role !== 'spectator' && this.seats[client.role].socket === ws) {
      const seat = client.role
      const s = this.seats[seat]
      s.socket = null
      s.disconnectedAt = now
      s.intents = []
      if (this.phase === 'live' && s.inRound) this.emit({ k: 'away', a: seat })
    } else {
      this.spectators = this.spectators.filter(socket => socket !== ws)
    }
    this.evaluate(now)
    this.broadcastRoom()
  }

  /** Explicit leave: the seat is freed at once instead of being held for a reconnect. */
  leave(ws: WebSocket, now: number): void {
    const client = clients.get(ws)
    if (client && client.role !== 'spectator' && this.seats[client.role].socket === ws) {
      const seat = client.role
      client.role = 'spectator'
      this.freeSeat(seat, now)
    } else {
      this.spectators = this.spectators.filter(socket => socket !== ws)
    }
    ws.close(CLOSE.left, 'left')
    this.fillSeats(now)
    this.evaluate(now)
    this.broadcastRoom()
  }

  private freeSeat(seat: Seat, now: number): void {
    const s = this.seats[seat]
    if (this.phase === 'live' && s.inRound) this.removeFromRound(seat, now)
    Object.assign(this.seats[seat], emptySeat())
  }

  // ---------- phases ----------

  private eligible(): Seat[] {
    return SEATS.filter(seat => this.seats[seat].token && this.connected(seat))
  }

  private canStart(): boolean {
    const eligible = this.eligible()
    return eligible.length >= MIN_PLAYERS && eligible.every(seat => this.seats[seat].ready)
  }

  /** Starts the countdown when every connected seat is ready, and aborts it when that stops. */
  evaluate(now: number): void {
    if ((this.phase === 'lobby' || this.phase === 'results') && this.canStart()) {
      this.countdownFrom = this.phase
      this.phase = 'countdown'
      this.endsAt = now + COUNTDOWN_MS
      this.dirty = true
    } else if (this.phase === 'countdown' && !this.canStart()) {
      this.phase = this.countdownFrom
      this.endsAt = 0
      this.dirty = true
    }
  }

  private startRound(at: number): void {
    this.round += 1
    this.tick = 0
    this.liveAt = at
    this.endsAt = at + ROUND_TICKS * TICK_MS
    this.phase = 'live'
    this.grid = createGrid()
    this.bombs = []
    this.events = []
    this.result = null
    for (const seat of SEATS) {
      const s = this.seats[seat]
      const playing = Boolean(s.token) && this.connected(seat) && s.ready
      Object.assign(s, { ready: false, inRound: playing, mover: playing ? spawnMover(seat) : null, hits: 0, bombs: 0, recent: [], intents: [], hitTargets: new Set() })
      if (playing) this.grid[SPAWNS[seat].cell] = seatColor(seat)
    }
    this.dirty = true
  }

  private removeFromRound(seat: Seat, now: number): void {
    const s = this.seats[seat]
    if (!s.inRound) return
    s.inRound = false
    s.mover = null
    const color = seatColor(seat)
    for (let i = 0; i < CELLS; i += 1) if (this.grid[i] === color) this.grid[i] = 0
    this.emit({ k: 'out', a: seat })
    if (this.inRound().length < MIN_PLAYERS) this.finish('forfeit', now)
  }

  private finish(reason: 'time' | 'forfeit', now: number): void {
    if (this.phase !== 'live') return
    const counts = countCells(this.grid)
    const standings = this.inRound().map(seat => ({ seat, cells: counts[seat], hits: this.seats[seat].hits, bombs: this.seats[seat].bombs }))
    const { order, winner } = rank(standings)
    if (winner) this.seats[winner].wins += 1
    this.result = {
      round: this.round, winner, reason, playable: PLAYABLE,
      order: order.map(row => ({ ...row, name: this.seats[row.seat].name })),
    }
    this.lastSnap = JSON.stringify(this.snapMessage(true))
    this.broadcastText(this.lastSnap)
    for (const seat of SEATS) Object.assign(this.seats[seat], { inRound: false, ready: false, intents: [] })
    this.phase = 'results'
    this.endsAt = 0
    this.fillSeats(now)
    this.dirty = true
  }

  // ---------- simulation ----------

  intent(seat: Seat, ws: WebSocket, message: TurnIntent | DashIntent): void {
    const s = this.seats[seat]
    if (this.phase !== 'live' || !s.inRound || s.socket !== ws || message.round !== this.round) return
    if (message.seq <= s.lastSeq) return // duplicate or out of order: dedupe by seq, not content
    s.lastSeq = message.seq
    if (s.intents.length < MAX_INTENTS_PER_TICK) s.intents.push(message)
  }

  private stepTick(now: number): void {
    const tick = this.tick
    const frenzy = isFrenzy(tick)
    if (tick === ROUND_TICKS - FRENZY_TICKS) this.emit({ k: 'frenzy' })
    const paints = new Map<number, { seats: Set<Seat>; anchor: Map<Seat, number> }>()
    const request = (seat: Seat, cells: number[], anchor: number) => {
      for (const cell of cells) {
        let entry = paints.get(cell)
        if (!entry) { entry = { seats: new Set(), anchor: new Map() }; paints.set(cell, entry) }
        entry.seats.add(seat)
        entry.anchor.set(seat, anchor)
      }
    }
    const active = SEATS.filter(seat => this.seats[seat].inRound && this.seats[seat].mover && this.seats[seat].socket)
    const start = new Map<Seat, { x: number; y: number }>()
    const dashing = new Set<Seat>()

    // 1) Intents that arrived since the last tick, in seat order: they count as simultaneous.
    for (const seat of active) {
      const s = this.seats[seat]
      const m = s.mover!
      start.set(seat, { x: m.x, y: m.y })
      const enter = (cell: number, dir: Dir) => request(seat, brushCells(this.grid, cell, dir, frenzy), cell)
      for (const intent of s.intents) {
        if (intent.type === 'turn') {
          applyTurn(m, this.grid, intent.dir, intent.cell, enter, (cell, oldDir) => this.undoOvershoot(seat, cell, oldDir))
        } else if (applyDash(m, this.grid, tick - intent.tick, frenzy, enter)) {
          s.hitTargets = new Set()
          dashing.add(seat)
        }
      }
      s.intents = []
      s.ack = s.lastSeq
    }

    // 2) Movement.
    for (const seat of active) {
      const m = this.seats[seat].mover!
      if (step(m, this.grid, frenzy, (cell, dir) => request(seat, brushCells(this.grid, cell, dir, frenzy), cell))) dashing.add(seat)
    }

    // 3) Dash hits, all judged against the same post-move positions (mutual hits are allowed).
    const hits: Array<[Seat, Seat]> = []
    for (const a of dashing) {
      const from = start.get(a)!
      const ma = this.seats[a].mover!
      for (const b of active) {
        if (b === a || this.seats[a].hitTargets.has(b)) continue
        const mb = this.seats[b].mover!
        if (mb.stun > 0) continue
        if (segmentDistance(from.x, from.y, ma.x, ma.y, mb.x, mb.y) < HIT_RADIUS) hits.push([a, b])
      }
    }
    for (const [a, b] of hits) {
      const mb = this.seats[b].mover!
      mb.stun = STUN_TICKS
      mb.dash = 0
      this.seats[a].hits += 1
      this.seats[a].hitTargets.add(b)
      const cell = cellOf(mb)
      request(a, splatCells(this.grid, cell), -1)
      this.emit({ k: 'hit', a, b, cell })
    }

    // 4) Paint bombs: picked up only by a painter alone on the bomb's cell.
    for (const bomb of [...this.bombs]) {
      const here = active.filter(seat => cellOf(this.seats[seat].mover!) === bomb && this.seats[seat].mover!.stun === 0)
      if (here.length !== 1) continue
      const seat = here[0]
      this.bombs = this.bombs.filter(cell => cell !== bomb)
      this.seats[seat].bombs += 1
      request(seat, bombCells(this.grid, bomb), -1)
      this.emit({ k: 'bomb', a: seat, cell: bomb })
    }

    // 5) Paint. A cell requested by two painters in the same tick keeps its colour.
    for (const [cell, entry] of paints) {
      if (entry.seats.size !== 1) continue
      const seat = [...entry.seats][0]
      const color = seatColor(seat)
      const prev = this.grid[cell]
      if (prev === WALL || prev === color) continue
      this.grid[cell] = color
      const s = this.seats[seat]
      s.recent.push({ cell, prev, anchor: entry.anchor.get(seat) ?? -1 })
      if (s.recent.length > 9) s.recent.splice(0, s.recent.length - 9)
    }

    // 6) New bombs on a fixed schedule.
    if (tick >= BOMB_FIRST_TICK && (tick - BOMB_FIRST_TICK) % BOMB_EVERY === 0 && this.bombs.length < MAX_BOMBS) this.spawnBomb()

    this.tick += 1
    if (this.tick >= ROUND_TICKS) this.finish('time', now)
  }

  /** A rewound turn: undo the paint of the one cell the painter wrongly ran into. */
  private undoOvershoot(seat: Seat, cell: number, oldDir: Dir): void {
    const s = this.seats[seat]
    const over = neighbor(cell, oldDir)
    if (over < 0) return
    const color = seatColor(seat)
    for (let i = s.recent.length - 1; i >= 0; i -= 1) {
      const entry = s.recent[i]
      if (entry.anchor !== over) continue
      if (this.grid[entry.cell] === color) this.grid[entry.cell] = entry.prev
      s.recent.splice(i, 1)
    }
  }

  private spawnBomb(): void {
    const painters = this.inRound().map(seat => this.seats[seat].mover).filter((m): m is Mover => Boolean(m))
    const options: number[] = []
    for (let cell = 0; cell < CELLS; cell += 1) {
      if (this.grid[cell] === WALL || this.bombs.includes(cell)) continue
      const far = painters.every(m => Math.abs(cellX(cellOf(m)) - cellX(cell)) + Math.abs(cellY(cellOf(m)) - cellY(cell)) >= 4)
      if (far) options.push(cell)
    }
    if (!options.length) return
    const cell = options[Math.floor(Math.random() * options.length)]
    this.bombs.push(cell)
    this.emit({ k: 'spawn', cell })
  }

  // ---------- housekeeping ----------

  update(now: number): void {
    for (const seat of SEATS) {
      const s = this.seats[seat]
      if (s.token && !s.socket && s.disconnectedAt && now - s.disconnectedAt > GRACE_MS) {
        this.freeSeat(seat, now)
        this.fillSeats(now)
        this.evaluate(now)
        this.dirty = true
      }
    }
    if (this.phase === 'countdown' && now >= this.endsAt) this.startRound(this.endsAt)
    if (this.phase === 'live') {
      const due = Math.min(ROUND_TICKS, Math.floor((now - this.liveAt) / TICK_MS))
      let stepped = false
      for (let i = 0; i < 6 && this.phase === 'live' && this.tick < due; i += 1) {
        this.stepTick(now)
        stepped = true
      }
      if (stepped && this.phase === 'live') this.broadcastText(JSON.stringify(this.snapMessage(false)))
    }
    if (this.dirty) this.broadcastRoom()
    if (this.hasSockets()) this.emptySince = 0
    else if (!this.emptySince) this.emptySince = now
  }

  // ---------- messages ----------

  roomMessage(): RoomMsg {
    this.seq += 1
    const seats: Partial<Record<Seat, SeatInfo>> = {}
    for (const seat of this.seated()) {
      const s = this.seats[seat]
      seats[seat] = { name: s.name, connected: this.connected(seat), ready: s.ready, playing: s.inRound, wins: s.wins }
    }
    return {
      type: 'room', marker: MARKER, room: this.code, seq: this.seq, round: this.round, phase: this.phase,
      ends_at: this.endsAt, live_at: this.liveAt, host: this.host(), seats,
      spectators: this.spectators.filter(ws => ws.readyState === WebSocket.OPEN).length, result: this.result,
    }
  }

  snapMessage(final: boolean): SnapMsg {
    this.seq += 1
    const counts = countCells(this.grid)
    const players: Partial<Record<Seat, PlayerSnap>> = {}
    for (const seat of SEATS) {
      const s = this.seats[seat]
      const m = s.mover
      if (!m || (!s.inRound && !final)) continue
      players[seat] = {
        x: m.x, y: m.y, dir: m.dir, face: m.face, want: m.want, wc: m.wantCell, sx: m.segX, sy: m.segY,
        dash: m.dash, cd: m.cd, stun: m.stun, away: !s.socket, ack: s.ack,
        cells: counts[seat], hits: s.hits, bombs: s.bombs,
      }
    }
    const ev = this.events
    this.events = []
    return { type: 'snap', marker: MARKER, room: this.code, seq: this.seq, round: this.round, tick: this.tick, players, grid: encodeGrid(this.grid), bombs: [...this.bombs], ev }
  }

  broadcastText(text: string): void {
    for (const seat of SEATS) sendText(this.seats[seat].socket, text)
    for (const ws of this.spectators) sendText(ws, text)
  }

  broadcastRoom(): void {
    this.dirty = false
    this.broadcastText(JSON.stringify(this.roomMessage()))
  }
}

function reject(ws: WebSocket, room: string, code: ErrorCode, close: number): void {
  sendText(ws, JSON.stringify({ type: 'error', marker: MARKER, room, code }))
  ws.close(close, code)
}

// ---------- HTTP + WebSocket ----------

const httpServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost')
    if (url.pathname === '/healthz' || url.pathname === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, marker: MARKER, rooms: rooms.size, clients: clients.size, uptime: Math.round(process.uptime()) }))
      return
    }
    if (!['GET', 'HEAD'].includes(request.method || '')) { response.writeHead(405); response.end(); return }
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/index.html'
    const relative = normalize(pathname).replace(/^([/\\])+/, '')
    const filePath = resolve(STATIC_ROOT, relative)
    if (!filePath.startsWith(STATIC_ROOT + '/') || relative.split('/').some(part => part.startsWith('.'))) throw new Error('invalid path')
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('not a file')
    const physicalRoot = await realpath(STATIC_ROOT)
    const physicalFile = await realpath(filePath)
    if (!physicalFile.startsWith(physicalRoot + '/')) throw new Error('invalid path')
    response.writeHead(200, {
      'content-type': MIME.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
      'cache-control': filePath.endsWith('index.html') || filePath.endsWith('bootstrap.json') ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-length': info.size,
    })
    if (request.method === 'HEAD') response.end()
    else await pipeline(createReadStream(physicalFile), response)
  } catch {
    if (response.headersSent) { response.destroy(); return }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  }
})

function originAllowed(origin: string | undefined, hosts: string[]): boolean {
  if (!origin) return true // non-browser clients (tests, tools); there is no ambient credential to protect
  if (allowedOrigins.has(origin)) return true
  try {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    if (hosts.includes(url.host)) return true
    return allowedSuffixes.some(suffix => url.hostname.endsWith(suffix))
  } catch {
    return false
  }
}

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_SOCKET_BYTES })

httpServer.on('upgrade', (request, socket, head) => {
  let url: URL
  try { url = new URL(request.url || '/', 'http://localhost') } catch { socket.destroy(); return }
  const forwarded = String(request.headers['x-forwarded-host'] || '').split(',').map(v => v.trim()).filter(Boolean)
  const hosts = [request.headers.host || '', ...forwarded]
  if (url.pathname !== '/ws' || clients.size >= MAX_CLIENTS) { socket.destroy(); return }
  if (!originAllowed(request.headers.origin, hosts)) {
    console.log(JSON.stringify({ marker: MARKER, rejected: 'origin', origin: request.headers.origin, hosts }))
    socket.destroy()
    return
  }
  websocketServer.handleUpgrade(request, socket, head, ws => {
    websocketServer.emit('connection', ws, request, url)
  })
})

websocketServer.on('connection', (ws: WebSocket, _request: unknown, url: URL) => {
  const now = Date.now()
  const code = cleanRoom(url.searchParams.get('room'))
  const create = url.searchParams.get('create') === '1'
  const resume = (url.searchParams.get('resume') || '').slice(0, 64)
  const name = cleanName(url.searchParams.get('name'))
  if (!code) { reject(ws, '', 'invalid_message', 1008); return }
  let room = rooms.get(code)
  if (!room) {
    if (!create) { reject(ws, code, 'room_not_found', CLOSE.notFound); return }
    if (rooms.size >= MAX_ROOMS) { reject(ws, code, 'server_full', CLOSE.full); return }
    room = new Room(code)
    rooms.set(code, room)
  } else if (create && !SEATS.some(seat => resume && room!.seats[seat].token === resume)) {
    reject(ws, code, 'room_exists', CLOSE.exists)
    return
  }
  const client: Client = { ws, room, role: 'spectator', name, alive: true, window: now, count: 0 }
  clients.set(ws, client)
  ws.on('pong', () => { client.alive = true })
  room.claim(ws, resume, name, now)
  ws.on('message', data => {
    const at = Date.now()
    if (at - client.window >= 1000) { client.window = at; client.count = 0 }
    if (++client.count > MAX_MESSAGES_PER_SECOND) { ws.close(1008, 'message rate exceeded'); return }
    const text = String(data)
    const frameBytes = utf8ByteLength(text)
    if (frameBytes > MAX_SOCKET_BYTES) return
    if (client.role === 'spectator' && frameBytes > MAX_MESSAGE_BYTES) return
    let message
    try { message = parseClientMessage(JSON.parse(text)) } catch { message = null }
    if (!message) return
    if (message.type === 'rtc') {
      if (utf8ByteLength(message.data) > MAX_SIGNAL_BYTES) return
    } else if (frameBytes > MAX_MESSAGE_BYTES) return
    const r = client.room
    const seat = client.role !== 'spectator' && r.seats[client.role].socket === ws ? client.role : null
    switch (message.type) {
      case 'rtc':
        // Relay only: the server never parses, logs or stores SDP/ICE, and cannot read chat content.
        if (seat && message.to !== seat && r.connected(message.to)) {
          sendText(r.seats[message.to].socket, JSON.stringify({ type: 'rtc', marker: MARKER, room: r.code, from: seat, kind: message.kind, data: message.data }))
        }
        break
      case 'ping':
        sendText(ws, JSON.stringify({ type: 'pong', marker: MARKER, room: r.code, t: message.t, s: at }))
        break
      case 'turn':
      case 'dash':
        if (seat) r.intent(seat, ws, message)
        break
      case 'ready':
        if (seat && r.phase !== 'live' && r.seats[seat].ready !== message.ready) {
          r.seats[seat].ready = message.ready
          r.evaluate(at)
          r.broadcastRoom()
        }
        break
      case 'name':
        if (seat && r.phase !== 'live' && r.seats[seat].name !== message.name) {
          r.seats[seat].name = message.name
          r.broadcastRoom()
        }
        break
      case 'leave':
        r.leave(ws, at)
        break
    }
  })
  const closed = () => {
    if (!clients.has(ws)) return
    client.room.release(ws, Date.now())
    clients.delete(ws)
  }
  ws.on('close', closed)
  ws.on('error', closed)
})

setInterval(() => {
  for (const client of clients.values()) {
    if (!client.alive) { client.ws.terminate(); continue }
    client.alive = false
    client.ws.ping()
  }
}, 15_000).unref()

setInterval(() => {
  const now = Date.now()
  for (const [code, room] of rooms) {
    room.update(now)
    if (room.emptySince && now - room.emptySince > ROOM_EMPTY_MS) rooms.delete(code)
  }
}, LOOP_MS)

httpServer.listen(PORT, HOST, () => {
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : PORT
  console.log(JSON.stringify({ marker: MARKER, status: 'listening', host: HOST, port }))
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const client of clients.values()) client.ws.close(CLOSE.restart, 'server restart')
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 3000).unref()
  })
}
