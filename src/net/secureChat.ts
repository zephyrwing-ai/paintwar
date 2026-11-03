/**
 * Room chat over WebRTC: text on an RTCDataChannel and voice on an audio track, peer to peer.
 *
 * Security model (see docs/secure-chat.md):
 * - Content is protected by the browser's standard WebRTC stack (DTLS 1.2+ for the data channel,
 *   DTLS-SRTP for voice). We do not implement any cryptographic primitive or protocol ourselves.
 * - The game server only relays opaque offer/answer/ICE signaling between seats of one room. It
 *   could try to swap DTLS fingerprints (man in the middle), so every pair shows a safety code
 *   derived from BOTH fingerprints the browsers actually negotiated. Different codes on the two
 *   screens mean the connection is not end to end with that person.
 * - Each tab generates one ephemeral ECDSA P-256 certificate held only in memory. A reload makes
 *   a new key, and the code changes; a verified peer whose code changes is flagged, not trusted.
 * - Messages live only in memory (at most MAX_HISTORY), are never logged, stored, or notified,
 *   and are dropped on leave. Rendering always uses textContent.
 */
import { SEATS, type Seat } from '../../shared/rules.ts'
import type { Role, RoomMsg, RtcMsg, SignalKind } from '../../shared/protocol.ts'

export const MAX_TEXT = 300
const MAX_HISTORY = 100
const MAX_INCOMING_PER_SECOND = 8
const RETRY_MS = 4000
/** Public STUN for NAT traversal. It and each peer learn the player's public IP (documented). */
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

export type PeerStatus = 'connecting' | 'secure' | 'failed'
export type PeerView = { seat: Seat; name: string; status: PeerStatus; code: string; verified: boolean; changed: boolean; voice: boolean }
export type ChatLine = { id: string; seat: Seat | 'me' | 'system'; name: string; text: string }

type Peer = {
  seat: Seat
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  audio: RTCRtpTransceiver | null
  pending: RTCIceCandidateInit[]
  status: PeerStatus
  code: string
  voice: boolean
  window: number
  count: number
  seen: Set<string>
  retry: number
}

let certificate: Promise<RTCCertificate> | null = null
/** One ephemeral key per tab, in memory only: stable across reconnects, new after a reload. */
function tabCertificate(): Promise<RTCCertificate> {
  certificate ??= RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' } as EcKeyGenParams)
  return certificate
}

function fingerprint(sdp: string | undefined): string {
  const m = /a=fingerprint:(\S+) (\S+)/i.exec(sdp ?? '')
  return m ? `${m[1].toLowerCase()} ${m[2].toUpperCase()}` : ''
}

/** 20-digit safety code from both negotiated DTLS fingerprints (order independent). */
export async function safetyCode(a: string, b: string): Promise<string> {
  const input = new TextEncoder().encode(`paintwar-chat-v1\n${[a, b].sort().join('\n')}`)
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', input)).slice(0, 8)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value.toString().padStart(20, '0').replace(/(\d{4})(?=\d)/g, '$1 ')
}

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(9))
  return btoa(String.fromCharCode(...b))
}

export type ChatHooks = {
  signal(to: Seat, kind: SignalKind, data: string): void
  changed(): void
}

export class SecureChat {
  lines: ChatLine[] = []
  unread = 0
  micOn = false
  micError = ''
  private peers = new Map<Seat, Peer>()
  private opening = new Set<Seat>()
  private names: Partial<Record<Seat, string>> = {}
  /** Safety codes the local user confirmed in this tab; cleared on leave. */
  private verified = new Map<Seat, string>()
  private changedCodes = new Set<Seat>()
  private role: Role = 'spectator'
  private room = ''
  private mic: MediaStream | null = null
  private audioBox: HTMLElement

  constructor(private readonly hooks: ChatHooks) {
    this.audioBox = document.createElement('div')
    this.audioBox.hidden = true
    document.body.appendChild(this.audioBox)
  }

  get enabled(): boolean {
    return this.role !== 'spectator'
  }

  views(): PeerView[] {
    return [...this.peers.values()].map(p => ({
      seat: p.seat, name: this.names[p.seat] ?? p.seat, status: p.status, code: p.code,
      verified: p.status === 'secure' && this.verified.get(p.seat) === p.code,
      changed: this.changedCodes.has(p.seat), voice: p.voice,
    }))
  }

  /** Follows the authoritative room: one connection per other connected seat. */
  sync(room: RoomMsg | null, role: Role, code: string): void {
    if (code !== this.room) { this.reset(); this.room = code }
    this.role = role
    if (!room || role === 'spectator') { this.closeAll(); return }
    for (const seat of SEATS) this.names[seat] = room.seats[seat]?.name ?? this.names[seat]
    for (const seat of SEATS) {
      const info = room.seats[seat]
      const wanted = seat !== role && info?.connected === true
      const peer = this.peers.get(seat)
      if (!wanted && peer) this.close(seat)
      else if (wanted && !peer && this.initiates(seat)) void this.open(seat)
      else if (wanted && peer?.status === 'failed' && this.initiates(seat) && performance.now() > peer.retry) {
        this.close(seat)
        void this.open(seat)
      }
    }
  }

  async onSignal(msg: RtcMsg): Promise<void> {
    if (!this.enabled || msg.from === this.role) return
    try {
      if (msg.kind === 'offer') {
        // A new offer replaces any older connection with that seat (the other tab reconnected).
        if (this.peers.has(msg.from)) this.close(msg.from)
        const peer = await this.create(msg.from)
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: msg.data })
        peer.audio = peer.pc.getTransceivers().find(t => t.receiver.track.kind === 'audio') ?? null
        if (peer.audio) {
          peer.audio.direction = 'sendrecv'
          await peer.audio.sender.replaceTrack(this.micTrack())
        }
        await this.flush(peer)
        const answer = await peer.pc.createAnswer()
        await peer.pc.setLocalDescription(answer)
        this.hooks.signal(msg.from, 'answer', peer.pc.localDescription!.sdp)
      } else {
        const peer = this.peers.get(msg.from)
        if (!peer) return
        if (msg.kind === 'answer') {
          if (peer.pc.signalingState !== 'have-local-offer') return
          await peer.pc.setRemoteDescription({ type: 'answer', sdp: msg.data })
          await this.flush(peer)
        } else {
          const candidate = JSON.parse(msg.data) as RTCIceCandidateInit
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate)
          else if (peer.pending.length < 50) peer.pending.push(candidate)
        }
      }
    } catch {
      const peer = this.peers.get(msg.from)
      if (peer) this.fail(peer)
    }
  }

  send(text: string): boolean {
    const clean = text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_TEXT)
    if (!clean) return false
    const open = [...this.peers.values()].filter(p => p.dc?.readyState === 'open')
    if (!open.length) return false
    const id = randomId()
    const payload = JSON.stringify({ t: 'msg', id, text: clean })
    for (const p of open) p.dc!.send(payload)
    this.push({ id, seat: 'me', name: '我', text: clean })
    return true
  }

  verify(seat: Seat): void {
    const peer = this.peers.get(seat)
    if (!peer || peer.status !== 'secure') return
    this.verified.set(seat, peer.code)
    this.changedCodes.delete(seat)
    this.hooks.changed()
  }

  async setMic(on: boolean): Promise<void> {
    this.micError = ''
    if (on && !this.mic) {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      } catch {
        this.micError = '无法使用麦克风：请在浏览器中允许麦克风权限'
        this.micOn = false
        this.hooks.changed()
        return
      }
    }
    if (!on && this.mic) {
      for (const track of this.mic.getTracks()) track.stop()
      this.mic = null
    }
    this.micOn = Boolean(this.mic)
    for (const peer of this.peers.values()) await peer.audio?.sender.replaceTrack(this.micTrack()).catch(() => undefined)
    this.hooks.changed()
  }

  /** Leave: close every connection, stop the microphone and forget history, codes and keys' trust. */
  reset(): void {
    this.closeAll()
    void this.setMic(false)
    this.lines = []
    this.unread = 0
    this.verified.clear()
    this.changedCodes.clear()
    this.names = {}
    this.room = ''
    this.hooks.changed()
  }

  markRead(): void {
    if (this.unread) { this.unread = 0; this.hooks.changed() }
  }

  // ---------- internals ----------

  private initiates(seat: Seat): boolean {
    return this.role !== 'spectator' && SEATS.indexOf(this.role) < SEATS.indexOf(seat)
  }

  private micTrack(): MediaStreamTrack | null {
    return this.mic?.getAudioTracks()[0] ?? null
  }

  private async open(seat: Seat): Promise<void> {
    if (this.opening.has(seat)) return
    this.opening.add(seat)
    let peer: Peer
    try { peer = await this.create(seat) } finally { this.opening.delete(seat) }
    this.bindChannel(peer, peer.pc.createDataChannel('chat', { ordered: true }))
    peer.audio = peer.pc.addTransceiver('audio', { direction: 'sendrecv' })
    await peer.audio.sender.replaceTrack(this.micTrack())
    try {
      const offer = await peer.pc.createOffer()
      await peer.pc.setLocalDescription(offer)
      this.hooks.signal(seat, 'offer', peer.pc.localDescription!.sdp)
    } catch {
      this.fail(peer)
    }
  }

  private async create(seat: Seat): Promise<Peer> {
    // Placeholder entry first so concurrent room updates do not open a second connection.
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, certificates: [await tabCertificate()] })
    const existing = this.peers.get(seat)
    if (existing) this.close(seat)
    const peer: Peer = { seat, pc, dc: null, audio: null, pending: [], status: 'connecting', code: '', voice: false, window: 0, count: 0, seen: new Set(), retry: 0 }
    this.peers.set(seat, peer)
    pc.onicecandidate = e => { if (e.candidate) this.hooks.signal(seat, 'ice', JSON.stringify(e.candidate.toJSON())) }
    pc.ondatachannel = e => { if (e.channel.label === 'chat') this.bindChannel(peer, e.channel) }
    pc.ontrack = e => {
      if (e.track.kind !== 'audio') return
      const el = document.createElement('audio')
      el.autoplay = true
      el.dataset.seat = seat
      el.srcObject = new MediaStream([e.track])
      this.audioBox.querySelector(`audio[data-seat="${seat}"]`)?.remove()
      this.audioBox.appendChild(el)
      void el.play().catch(() => undefined)
      e.track.onunmute = () => { peer.voice = true; this.hooks.changed() }
      e.track.onmute = () => { peer.voice = false; this.hooks.changed() }
    }
    pc.onconnectionstatechange = () => {
      if (this.peers.get(seat) !== peer) return
      if (pc.connectionState === 'connected') void this.secured(peer)
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.fail(peer)
    }
    this.hooks.changed()
    return peer
  }

  private async secured(peer: Peer): Promise<void> {
    const local = fingerprint(peer.pc.currentLocalDescription?.sdp)
    const remote = fingerprint(peer.pc.currentRemoteDescription?.sdp)
    if (!local || !remote) { this.fail(peer); return }
    const code = await safetyCode(local, remote)
    if (this.peers.get(peer.seat) !== peer) return
    const confirmed = this.verified.get(peer.seat)
    if (confirmed && confirmed !== code) {
      // Key change after the user verified: never carry trust over silently.
      this.verified.delete(peer.seat)
      this.changedCodes.add(peer.seat)
      this.push({ id: randomId(), seat: 'system', name: '', text: `${this.names[peer.seat] ?? peer.seat} 的安全码已变化（可能刷新了页面，也可能有人在中间拦截），请重新核对。` })
    }
    peer.code = code
    peer.status = 'secure'
    this.hooks.changed()
  }

  private bindChannel(peer: Peer, dc: RTCDataChannel): void {
    peer.dc = dc
    dc.onopen = () => this.hooks.changed()
    dc.onclose = () => this.hooks.changed()
    dc.onmessage = e => {
      if (typeof e.data !== 'string' || e.data.length > 2048 || peer.pc.connectionState !== 'connected') return
      const now = performance.now()
      if (now - peer.window > 1000) { peer.window = now; peer.count = 0 }
      if (++peer.count > MAX_INCOMING_PER_SECOND) return
      let m: { t?: unknown; id?: unknown; text?: unknown }
      try { m = JSON.parse(e.data) } catch { return }
      if (m.t !== 'msg' || typeof m.id !== 'string' || typeof m.text !== 'string' || m.id.length > 24) return
      if (peer.seen.has(m.id)) return // duplicate delivery: show once
      peer.seen.add(m.id)
      if (peer.seen.size > 500) peer.seen = new Set([...peer.seen].slice(-250))
      const text = m.text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_TEXT)
      if (!text) return
      this.push({ id: m.id, seat: peer.seat, name: this.names[peer.seat] ?? peer.seat, text })
      this.unread += 1
      this.hooks.changed()
    }
  }

  private async flush(peer: Peer): Promise<void> {
    const queued = peer.pending.splice(0)
    for (const c of queued) await peer.pc.addIceCandidate(c).catch(() => undefined)
  }

  private fail(peer: Peer): void {
    if (this.peers.get(peer.seat) !== peer) return
    peer.status = 'failed'
    peer.retry = performance.now() + RETRY_MS
    this.hooks.changed()
  }

  private push(line: ChatLine): void {
    this.lines.push(line)
    if (this.lines.length > MAX_HISTORY) this.lines.splice(0, this.lines.length - MAX_HISTORY)
    this.hooks.changed()
  }

  private close(seat: Seat): void {
    const peer = this.peers.get(seat)
    if (!peer) return
    this.peers.delete(seat)
    peer.pc.onconnectionstatechange = peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.ondatachannel = null
    peer.dc?.close()
    peer.pc.close()
    this.audioBox.querySelector(`audio[data-seat="${seat}"]`)?.remove()
    this.hooks.changed()
  }

  private closeAll(): void {
    for (const seat of [...this.peers.keys()]) this.close(seat)
  }
}
