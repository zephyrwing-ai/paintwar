/**
 * Client side of the wire protocol: decodes and sanity-checks server messages. Server rules live
 * in shared/; this module only guards shapes, the build marker and message order.
 */
import { MARKER, MAX_SERVER_MESSAGE_BYTES, isSeat, type ErrorMsg, type PongMsg, type RoomMsg, type RtcMsg, type ServerMessage, type SnapMsg, type WelcomeMsg } from '../../shared/protocol.ts'

export const BUILD = MARKER

export type Envelope = { type?: unknown; marker?: unknown; room?: unknown; seq?: unknown }

export function parseEnvelope(text: string): Envelope | null {
  if (text.length > MAX_SERVER_MESSAGE_BYTES) return null
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Envelope) : null
  } catch {
    return null
  }
}

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)

/**
 * Returns the message when it belongs to this room and build, and (for ordered kinds) is newer
 * than `lastSeq`. Stale or reordered room/snap messages are dropped instead of rolling state back.
 */
export function decode(text: string, room: string, lastSeq: number): ServerMessage | null {
  const m = parseEnvelope(text) as Record<string, unknown> | null
  if (!m || m.marker !== BUILD) return null
  if (m.type === 'error') return typeof m.code === 'string' ? (m as unknown as ErrorMsg) : null
  if (m.room !== room) return null
  switch (m.type) {
    case 'welcome':
      return typeof m.role === 'string' && typeof m.resume_token === 'string' && num(m.now) ? (m as unknown as WelcomeMsg) : null
    case 'room':
      if (!num(m.seq) || (m.seq as number) <= lastSeq || typeof m.phase !== 'string' || !m.seats || typeof m.seats !== 'object') return null
      return m as unknown as RoomMsg
    case 'snap':
      if (!num(m.seq) || (m.seq as number) <= lastSeq || !num(m.tick) || typeof m.grid !== 'string' || !m.players || !Array.isArray(m.ev)) return null
      return m as unknown as SnapMsg
    case 'pong':
      return num(m.t) && num(m.s) ? (m as unknown as PongMsg) : null
    case 'rtc':
      return isSeat(m.from) && typeof m.kind === 'string' && typeof m.data === 'string' ? (m as unknown as RtcMsg) : null
    default:
      return null
  }
}
