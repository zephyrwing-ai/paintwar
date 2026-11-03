/**
 * Wire protocol shared by the browser and the server. Clients send intents only (ready, turn,
 * dash); the server sends authoritative room state and 20 Hz snapshots of the live round.
 */
import { CELLS, PROTOCOL, SEATS, isDir, type Dir, type Seat } from './rules.ts'

export const MARKER = PROTOCOL
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_LENGTH = 4
export const NAME_MAX = 8
export const RECONNECT_GRACE_MS = 30_000
export const MAX_MESSAGE_BYTES = 4096
export const MAX_SERVER_MESSAGE_BYTES = 16_384
/** WebRTC signaling (SDP/ICE) is opaque to the server and may exceed a game intent's size. */
export const MAX_SIGNAL_BYTES = 12_288
export const MAX_SOCKET_BYTES = 16_384

export type Phase = 'lobby' | 'countdown' | 'live' | 'results'
export type Role = Seat | 'spectator'

export function cleanRoom(value: unknown): string {
  const code = String(value ?? '').trim().toUpperCase()
  if (code.length !== ROOM_LENGTH) return ''
  for (const ch of code) if (!ROOM_ALPHABET.includes(ch)) return ''
  return code
}

export function randomRoom(random: () => number = Math.random): string {
  let code = ''
  for (let i = 0; i < ROOM_LENGTH; i += 1) code += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)]
  return code
}

/** Nicknames: no control/format characters or markup, trimmed, at most NAME_MAX characters. */
export function cleanName(value: unknown): string {
  const text = String(value ?? '')
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>&"'`]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(text).slice(0, NAME_MAX).join('')
}

// ---------- client -> server ----------

export type ReadyIntent = { type: 'ready'; ready: boolean }
export type TurnIntent = { type: 'turn'; round: number; seq: number; dir: Dir; cell: number }
export type DashIntent = { type: 'dash'; round: number; seq: number; tick: number }
export type NameIntent = { type: 'name'; name: string }
export type LeaveIntent = { type: 'leave' }
export type PingIntent = { type: 'ping'; t: number }
export type SignalKind = 'offer' | 'answer' | 'ice'
/** Peer-to-peer chat signaling: relayed to one seat in the same room, never stored or parsed. */
export type RtcIntent = { type: 'rtc'; to: Seat; kind: SignalKind; data: string }
export type ClientMessage = ReadyIntent | TurnIntent | DashIntent | NameIntent | LeaveIntent | PingIntent | RtcIntent

const safeInt = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min

/** Strict validation of untrusted client JSON; anything malformed is null and gets dropped. */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const m = value as Record<string, unknown>
  switch (m.type) {
    case 'ready':
      return typeof m.ready === 'boolean' ? { type: 'ready', ready: m.ready } : null
    case 'turn':
      return safeInt(m.round, 1) && safeInt(m.seq, 1) && isDir(m.dir) && safeInt(m.cell) && (m.cell as number) < CELLS
        ? { type: 'turn', round: m.round, seq: m.seq, dir: m.dir, cell: m.cell as number } : null
    case 'dash':
      return safeInt(m.round, 1) && safeInt(m.seq, 1) && safeInt(m.tick) ? { type: 'dash', round: m.round, seq: m.seq, tick: m.tick } : null
    case 'name': {
      const name = cleanName(m.name)
      return name ? { type: 'name', name } : null
    }
    case 'leave':
      return { type: 'leave' }
    case 'ping':
      return safeInt(m.t) ? { type: 'ping', t: m.t } : null
    case 'rtc':
      return isSeat(m.to) && (m.kind === 'offer' || m.kind === 'answer' || m.kind === 'ice') && typeof m.data === 'string' && m.data.length > 0 && m.data.length <= MAX_SIGNAL_BYTES
        ? { type: 'rtc', to: m.to, kind: m.kind, data: m.data } : null
    default:
      return null
  }
}

// ---------- server -> client ----------

export type SeatInfo = { name: string; connected: boolean; ready: boolean; playing: boolean; wins: number }

export type ResultRow = { seat: Seat; name: string; cells: number; hits: number; bombs: number }
export type RoundResult = {
  round: number
  winner: Seat | ''
  /** 'time' = the 90 s ran out; 'forfeit' = fewer than two painters were left. */
  reason: 'time' | 'forfeit'
  order: ResultRow[]
  playable: number
}

export type WelcomeMsg = {
  type: 'welcome'; marker: string; room: string; role: Role; resume_token: string; name: string; now: number
}
export type RoomMsg = {
  type: 'room'; marker: string; room: string; seq: number; round: number; phase: Phase
  /** Server clock (ms since epoch): countdown end, or the live round's end. 0 when not timed. */
  ends_at: number
  /** Server clock when tick 0 of the current round began (0 before the first round). */
  live_at: number
  host: Seat | ''
  seats: Partial<Record<Seat, SeatInfo>>
  spectators: number
  result: RoundResult | null
}
export type PlayerSnap = {
  x: number; y: number; dir: Dir; face: Dir; want: Dir; wc: number; sx: number; sy: number
  dash: number; cd: number; stun: number
  /** Disconnected and frozen while its seat is held. */
  away: boolean
  /** Highest intent `seq` the server has applied for this painter on its current connection. */
  ack: number
  cells: number; hits: number; bombs: number
}
export type GameEvent =
  | { id: number; k: 'hit'; a: Seat; b: Seat; cell: number }
  | { id: number; k: 'bomb'; a: Seat; cell: number }
  | { id: number; k: 'spawn'; cell: number }
  | { id: number; k: 'out'; a: Seat }
  | { id: number; k: 'away'; a: Seat }
  | { id: number; k: 'back'; a: Seat }
  | { id: number; k: 'frenzy' }
/** A game event before the server numbers it. */
export type EventInput = { [K in GameEvent['k']]: Omit<Extract<GameEvent, { k: K }>, 'id'> }[GameEvent['k']]
export type SnapMsg = {
  type: 'snap'; marker: string; room: string; seq: number; round: number; tick: number
  players: Partial<Record<Seat, PlayerSnap>>
  grid: string
  bombs: number[]
  ev: GameEvent[]
}
export type PongMsg = { type: 'pong'; marker: string; room: string; t: number; s: number }
export type RtcMsg = { type: 'rtc'; marker: string; room: string; from: Seat; kind: SignalKind; data: string }
export type ErrorCode = 'room_not_found' | 'room_exists' | 'room_full' | 'server_full' | 'invalid_message'
export type ErrorMsg = { type: 'error'; marker: string; room: string; code: ErrorCode }
export type ServerMessage = WelcomeMsg | RoomMsg | SnapMsg | PongMsg | ErrorMsg | RtcMsg

export const isSeat = (value: unknown): value is Seat => typeof value === 'string' && (SEATS as readonly string[]).includes(value)

/** WebSocket close codes the client acts on. */
export const CLOSE = {
  replaced: 4001,
  notFound: 4004,
  exists: 4009,
  full: 4013,
  left: 4010,
  restart: 1012,
} as const
