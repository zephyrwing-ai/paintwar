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
import {
  CHAT_CAPABILITY,
  isSignalKind,
  type Role,
  type RoomMsg,
  type RtcMsg,
  type SignalKind,
} from '../../shared/protocol.ts'

export const MAX_TEXT = 300
const MAX_HISTORY = 100
const MAX_MESSAGES_PER_SECOND = 8
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15_000
const DISCONNECTED_TIMEOUT_MS = 5000
/** Public STUN for NAT traversal. It and each peer learn the player's public IP (documented). */
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

export type PeerStatus = 'connecting' | 'secure' | 'failed'
export type PeerView = { seat: Seat; name: string; status: PeerStatus; code: string; verified: boolean; changed: boolean; voice: boolean }
export type PeerDiagnostic = {
  seat: Seat
  status: PeerStatus
  verified: boolean
  changed: boolean
  micOn: boolean
  outboundTrack: boolean
  inboundAudio: boolean
  bytesSent: number
  bytesReceived: number
}
export type ChatLine = { id: string; seat: Seat | 'me' | 'system'; name: string; text: string }

type Peer = {
  seat: Seat
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  audio: RTCRtpTransceiver | null
  remoteTrack: MediaStreamTrack | null
  remoteAudio: HTMLAudioElement | null
  pending: RTCIceCandidateInit[]
  status: PeerStatus
  code: string
  voice: boolean
  window: number
  count: number
  seen: Set<string>
  securing: boolean
  voiceRevision: number
  voiceQueue: Promise<void>
  disconnectedTimer: number | null
}

let certificate: Promise<RTCCertificate> | null = null
/** One ephemeral key per tab, in memory only: stable across reconnects, new after a reload. */
function tabCertificate(): Promise<RTCCertificate> {
  certificate ??= RTCPeerConnection
    .generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' } as EcKeyGenParams)
    .catch(error => {
      certificate = null
      throw error
    })
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

function candidate(value: string): RTCIceCandidateInit | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' ? parsed as RTCIceCandidateInit : null
  } catch {
    return null
  }
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
  private opening = new Map<Seat, number>()
  private wantedSeats = new Set<Seat>()
  private operations = new Map<Seat, number>()
  private operationSerial = 0
  private retryTimers = new Map<Seat, number>()
  private retryAttempts = new Map<Seat, number>()
  private earlyIce = new Map<Seat, RTCIceCandidateInit[]>()
  private names: Partial<Record<Seat, string>> = {}
  /** Safety codes the local user confirmed in this tab; cleared on leave. */
  private verified = new Map<Seat, string>()
  private changedCodes = new Set<Seat>()
  private role: Role = 'spectator'
  private room = ''
  private capabilities = new Set<string>()
  private mic: MediaStream | null = null
  private desiredMicOn = false
  private micTask: Promise<void> | null = null
  private permissionRequest: Promise<MediaStream> | null = null
  private permissionRequestSession = -1
  private sessionGeneration = 0
  private sendWindow = 0
  private sendCount = 0
  private audioBox: HTMLElement

  constructor(private readonly hooks: ChatHooks) {
    this.audioBox = document.createElement('div')
    this.audioBox.hidden = true
    this.audioBox.setAttribute('aria-hidden', 'true')
    document.body.appendChild(this.audioBox)
  }

  get enabled(): boolean {
    return this.role !== 'spectator' && this.capabilities.has(CHAT_CAPABILITY)
  }

  get micPending(): boolean {
    return this.desiredMicOn && !this.micOn && this.micTask !== null
  }

  views(): PeerView[] {
    return [...this.peers.values()].map(p => ({
      seat: p.seat, name: this.names[p.seat] ?? p.seat, status: p.status, code: p.code,
      verified: p.status === 'secure' && this.verified.get(p.seat) === p.code,
      changed: this.changedCodes.has(p.seat), voice: p.voice,
    }))
  }

  async diagnostics(): Promise<PeerDiagnostic[]> {
    const rows: PeerDiagnostic[] = []
    for (const peer of this.peers.values()) {
      let bytesSent = 0
      let bytesReceived = 0
      try {
        const stats = await peer.pc.getStats()
        stats.forEach(report => {
          const value = report as RTCStats & { kind?: string; bytesSent?: number; bytesReceived?: number }
          if (value.kind !== 'audio') return
          if (value.type === 'outbound-rtp') bytesSent = Math.max(bytesSent, value.bytesSent ?? 0)
          if (value.type === 'inbound-rtp') bytesReceived = Math.max(bytesReceived, value.bytesReceived ?? 0)
        })
      } catch {
        // A closed peer keeps its last observable diagnostics.
      }
      rows.push({
        seat: peer.seat,
        status: peer.status,
        verified: this.trusted(peer),
        changed: this.changedCodes.has(peer.seat),
        micOn: this.micOn,
        outboundTrack: peer.audio?.sender.track?.readyState === 'live',
        inboundAudio: peer.remoteAudio !== null,
        bytesSent,
        bytesReceived,
      })
    }
    return rows
  }

  /** Capabilities are tied to the current server session, not to a particular room state. */
  setCapabilities(capabilities: readonly string[]): void {
    this.capabilities = new Set(capabilities.filter(value => typeof value === 'string'))
    if (!this.capabilities.has(CHAT_CAPABILITY) && this.role !== 'spectator') this.suspendConnections()
    this.hooks.changed()
  }

  /** Follows the authoritative room: one connection per other connected seat. */
  sync(room: RoomMsg | null, role: Role, code: string): void {
    if (code !== this.room) { this.reset(); this.room = code }
    this.role = role
    if (!room || !this.enabled) {
      this.suspendConnections()
      this.hooks.changed()
      return
    }
    for (const seat of SEATS) this.names[seat] = room.seats[seat]?.name ?? this.names[seat]
    this.wantedSeats.clear()
    for (const seat of SEATS) {
      const info = room.seats[seat]
      const wanted = seat !== role && info?.connected === true
      if (wanted) this.wantedSeats.add(seat)
      else this.retryAttempts.delete(seat)
      const peer = this.peers.get(seat)
      if (!wanted) this.close(seat)
      else if (!peer && !this.opening.has(seat) && this.initiates(seat)) void this.open(seat)
      else if (peer?.status === 'failed') this.scheduleRetry(seat)
    }
    this.enforceVoiceTrust()
    this.hooks.changed()
  }

  async onSignal(msg: RtcMsg): Promise<void> {
    if (!this.enabled || msg.from === this.role || !this.wantedSeats.has(msg.from) || !isSignalKind(msg.kind)) return
    const active = this.peers.get(msg.from)
    if (msg.kind === 'ice' && (!active || active.status === 'failed')) {
      const queued = candidate(msg.data)
      if (!queued) return
      const pending = this.earlyIce.get(msg.from) ?? []
      if (pending.length < 50) pending.push(queued)
      this.earlyIce.set(msg.from, pending)
      return
    }
    try {
      if (msg.kind === 'offer') await this.acceptOffer(msg)
      else await this.acceptPeerSignal(msg)
    } catch {
      const peer = this.peers.get(msg.from)
      if (peer) this.fail(peer)
      else this.scheduleRetry(msg.from)
    }
  }

  send(text: string): boolean {
    const clean = text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_TEXT)
    if (!clean) return false
    const open = [...this.peers.values()].filter(p =>
      p.status === 'secure' && !this.changedCodes.has(p.seat) && p.dc?.readyState === 'open')
    if (!open.length) return false
    const now = performance.now()
    if (now - this.sendWindow > 1000) { this.sendWindow = now; this.sendCount = 0 }
    if (++this.sendCount > MAX_MESSAGES_PER_SECOND) return false
    const id = randomId()
    const payload = JSON.stringify({ t: 'msg', id, text: clean })
    let sent = false
    for (const peer of open) {
      try {
        peer.dc!.send(payload)
        sent = true
      } catch {
        this.fail(peer)
      }
    }
    if (!sent) return false
    this.push({ id, seat: 'me', name: '我', text: clean })
    return true
  }

  verify(seat: Seat): void {
    const peer = this.peers.get(seat)
    if (!peer || peer.status !== 'secure') return
    this.verified.set(seat, peer.code)
    this.changedCodes.delete(seat)
    this.refreshVoice(peer)
    this.hooks.changed()
  }

  async setMic(on: boolean): Promise<void> {
    if (on && !this.enabled) {
      this.micError = '聊天功能尚未启用'
      this.hooks.changed()
      return
    }
    if (on && !this.hasVerifiedPeer()) {
      this.micError = '请先与队友核对安全码，再开启语音'
      this.hooks.changed()
      return
    }
    this.micError = ''
    this.desiredMicOn = on
    if (on) {
      if (this.mic) this.micOn = true
      else this.startMicrophone()
    } else {
      this.stopMicrophone()
    }
    this.refreshAllVoice()
    this.hooks.changed()
    if (on) await this.micTask
  }

  /** Leave: close every connection, stop the microphone and forget history, codes and keys' trust. */
  reset(): void {
    this.sessionGeneration += 1
    this.desiredMicOn = false
    this.micError = ''
    this.stopMicrophone()
    this.wantedSeats.clear()
    this.opening.clear()
    this.closeAll()
    this.retryAttempts.clear()
    this.lines = []
    this.unread = 0
    this.verified.clear()
    this.changedCodes.clear()
    this.names = {}
    this.room = ''
    this.role = 'spectator'
    this.hooks.changed()
  }

  markRead(): void {
    this.unread = 0
  }

  // ---------- internals ----------

  private initiates(seat: Seat): boolean {
    return this.role !== 'spectator' && SEATS.indexOf(this.role) < SEATS.indexOf(seat)
  }

  private micTrack(): MediaStreamTrack | null {
    return this.micOn ? this.mic?.getAudioTracks()[0] ?? null : null
  }

  private async open(seat: Seat): Promise<void> {
    if (this.opening.has(seat) || !this.initiates(seat) || !this.canConnect(seat)) return
    const session = this.sessionGeneration
    const token = this.claimOperation(seat)
    this.opening.set(seat, token)
    let peer: Peer | null = null
    try {
      peer = await this.create(seat, token, session)
      if (!peer || !this.currentPeer(peer) || !this.operationCurrent(seat, token, session)) return
      this.bindChannel(peer, peer.pc.createDataChannel('chat', { ordered: true }))
      peer.audio = peer.pc.addTransceiver('audio', { direction: 'sendrecv' })
      const offer = await peer.pc.createOffer()
      await peer.pc.setLocalDescription(offer)
      if (!this.currentPeer(peer) || !this.operationCurrent(seat, token, session) || !this.canConnect(seat)) return
      this.hooks.signal(seat, 'offer', peer.pc.localDescription!.sdp)
    } catch {
      if (!this.operationCurrent(seat, token, session)) return
      if (peer && this.currentPeer(peer)) this.fail(peer)
      else this.scheduleRetry(seat)
    } finally {
      if (this.opening.get(seat) === token) this.opening.delete(seat)
    }
  }

  private async acceptOffer(msg: RtcMsg): Promise<void> {
    const seat = msg.from
    const session = this.sessionGeneration
    const token = this.claimOperation(seat)
    this.opening.set(seat, token)
    try {
      const peer = await this.create(seat, token, session)
      if (!peer || !this.operationCurrent(seat, token, session)) return
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: msg.data })
      if (!this.currentPeer(peer) || !this.operationCurrent(seat, token, session)) return
      peer.audio = peer.pc.getTransceivers().find(transceiver => transceiver.receiver.track.kind === 'audio') ?? null
      if (peer.audio) peer.audio.direction = 'sendrecv'
      this.queueSenderTrack(peer, null)
      await this.flush(peer)
      const answer = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(answer)
      if (!this.currentPeer(peer) || !this.operationCurrent(seat, token, session)) return
      this.hooks.signal(seat, 'answer', peer.pc.localDescription!.sdp)
    } catch (error) {
      if (this.operationCurrent(seat, token, session)) throw error
    } finally {
      if (this.opening.get(seat) === token) this.opening.delete(seat)
    }
  }

  private async acceptPeerSignal(msg: RtcMsg): Promise<void> {
    const peer = this.peers.get(msg.from)
    if (!peer) return
    if (msg.kind === 'answer') {
      if (peer.pc.signalingState !== 'have-local-offer') return
      try {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: msg.data })
      } catch {
        return
      }
      if (this.currentPeer(peer)) await this.flush(peer)
      return
    }
    const incoming = candidate(msg.data)
    if (!incoming) return
    if (peer.pc.remoteDescription) {
      if (!this.matchesRemoteCandidate(peer, incoming)) return
      await peer.pc.addIceCandidate(incoming).catch(() => undefined)
    } else if (peer.pending.length < 50) {
      peer.pending.push(incoming)
    }
  }

  private async create(seat: Seat, token: number, session: number): Promise<Peer | null> {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, certificates: [await tabCertificate()] })
    if (!this.operationCurrent(seat, token, session) || !this.canConnect(seat)) {
      pc.close()
      return null
    }
    const existing = this.peers.get(seat)
    if (existing) {
      this.clearRetry(seat)
      this.destroyPeer(seat)
    }
    const queued = this.earlyIce.get(seat) ?? []
    this.earlyIce.delete(seat)
    const peer: Peer = {
      seat,
      pc,
      dc: null,
      audio: null,
      remoteTrack: null,
      remoteAudio: null,
      pending: queued,
      status: 'connecting',
      code: '',
      voice: false,
      window: 0,
      count: 0,
      seen: new Set(),
      securing: false,
      voiceRevision: 0,
      voiceQueue: Promise.resolve(),
      disconnectedTimer: null,
    }
    this.peers.set(seat, peer)
    this.bindPeerEvents(peer)
    this.hooks.changed()
    return peer
  }

  private bindPeerEvents(peer: Peer): void {
    const { pc, seat } = peer
    pc.onicecandidate = event => {
      if (event.candidate && this.currentPeer(peer) && this.canConnect(seat)) {
        this.hooks.signal(seat, 'ice', JSON.stringify(event.candidate.toJSON()))
      }
    }
    pc.ondatachannel = event => {
      if (this.currentPeer(peer) && event.channel.label === 'chat') this.bindChannel(peer, event.channel)
    }
    pc.ontrack = e => {
      if (e.track.kind !== 'audio' || !this.currentPeer(peer)) return
      this.teardownRemoteAudio(peer, true)
      peer.remoteTrack = e.track
      e.track.enabled = false
      e.track.onunmute = () => { this.refreshRemoteAudio(peer); this.hooks.changed() }
      e.track.onmute = () => { this.refreshRemoteAudio(peer); this.hooks.changed() }
      e.track.onended = () => {
        if (peer.remoteTrack !== e.track) return
        this.teardownRemoteAudio(peer, false)
        peer.remoteTrack = null
        this.hooks.changed()
      }
      this.refreshRemoteAudio(peer)
    }
    pc.onconnectionstatechange = () => {
      if (!this.currentPeer(peer)) return
      if (pc.connectionState === 'connected') {
        this.clearDisconnectedTimer(peer)
        void this.secured(peer)
      } else if (pc.connectionState === 'disconnected') {
        this.startDisconnectedTimer(peer)
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.fail(peer)
      }
    }
    pc.oniceconnectionstatechange = () => {
      if (!this.currentPeer(peer)) return
      if (pc.iceConnectionState === 'failed') this.fail(peer)
      else if (pc.iceConnectionState === 'disconnected') this.startDisconnectedTimer(peer)
      else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.clearDisconnectedTimer(peer)
      }
    }
  }

  private async secured(peer: Peer): Promise<void> {
    const pc = peer.pc
    if (
      !this.currentPeer(peer) ||
      peer.status !== 'connecting' ||
      peer.securing ||
      pc.connectionState !== 'connected'
    ) return
    peer.securing = true
    try {
      const local = fingerprint(pc.currentLocalDescription?.sdp)
      const remote = fingerprint(pc.currentRemoteDescription?.sdp)
      if (!local || !remote) throw new Error('missing DTLS fingerprint')
      const code = await safetyCode(local, remote)
      if (
        !this.currentPeer(peer) ||
        peer.pc !== pc ||
        peer.status !== 'connecting' ||
        pc.connectionState !== 'connected'
      ) {
        peer.securing = false
        return
      }
      const confirmed = this.verified.get(peer.seat)
      const changed = Boolean(confirmed && confirmed !== code)
      if (changed) {
        // A confirmed peer's key changed: require a fresh local check before voice returns.
        this.verified.delete(peer.seat)
        this.changedCodes.add(peer.seat)
        if (!this.hasVerifiedPeer()) {
          this.desiredMicOn = false
          this.stopMicrophone()
        }
      }
      peer.code = code
      peer.status = 'secure'
      peer.securing = false
      this.clearRetry(peer.seat)
      this.retryAttempts.delete(peer.seat)
      this.refreshVoice(peer)
      if (changed) {
        this.push({
          id: randomId(),
          seat: 'system',
          name: '',
          text: `${this.names[peer.seat] ?? peer.seat} 的安全码已变化（可能刷新了页面，也可能有人在中间拦截），文字与语音已暂停，请重新核对。`,
        })
      } else {
        this.hooks.changed()
      }
    } catch {
      peer.securing = false
      if (this.currentPeer(peer) && peer.pc === pc && peer.status === 'connecting' && pc.connectionState === 'connected') {
        this.fail(peer)
      }
    }
  }

  private bindChannel(peer: Peer, dc: RTCDataChannel): void {
    if (peer.dc && peer.dc !== dc) {
      peer.dc.onopen = peer.dc.onclose = peer.dc.onerror = peer.dc.onmessage = null
      peer.dc.close()
    }
    peer.dc = dc
    dc.onopen = () => { if (this.currentPeer(peer) && peer.dc === dc) this.hooks.changed() }
    dc.onclose = () => {
      if (this.currentPeer(peer) && peer.dc === dc && peer.status !== 'failed') this.fail(peer)
    }
    dc.onerror = () => {
      if (this.currentPeer(peer) && peer.dc === dc && peer.status !== 'failed') this.fail(peer)
    }
    dc.onmessage = e => {
      if (
        !this.currentPeer(peer) ||
        peer.dc !== dc ||
        peer.status !== 'secure' ||
        this.changedCodes.has(peer.seat) ||
        typeof e.data !== 'string' ||
        e.data.length > 2048 ||
        peer.pc.connectionState !== 'connected'
      ) return
      const now = performance.now()
      if (now - peer.window > 1000) { peer.window = now; peer.count = 0 }
      if (++peer.count > MAX_MESSAGES_PER_SECOND) return
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
    for (const c of queued) {
      if (!this.matchesRemoteCandidate(peer, c)) continue
      await peer.pc.addIceCandidate(c).catch(() => undefined)
    }
  }

  private matchesRemoteCandidate(peer: Peer, value: RTCIceCandidateInit): boolean {
    const ufrag = value.usernameFragment
    if (!ufrag) return true
    return Boolean(peer.pc.remoteDescription?.sdp.includes(`a=ice-ufrag:${ufrag}`))
  }

  private fail(peer: Peer): void {
    if (!this.currentPeer(peer)) return
    if (peer.status === 'failed') {
      this.scheduleRetry(peer.seat)
      return
    }
    peer.status = 'failed'
    peer.securing = false
    this.earlyIce.delete(peer.seat)
    this.closePeerTransport(peer)
    this.enforceVoiceTrust()
    this.scheduleRetry(peer.seat)
    this.hooks.changed()
  }

  private push(line: ChatLine): void {
    this.lines.push(line)
    if (this.lines.length > MAX_HISTORY) this.lines.splice(0, this.lines.length - MAX_HISTORY)
    this.hooks.changed()
  }

  private claimOperation(seat: Seat): number {
    const token = ++this.operationSerial
    this.operations.set(seat, token)
    return token
  }

  private operationCurrent(seat: Seat, token: number, session: number): boolean {
    return this.sessionGeneration === session && this.operations.get(seat) === token
  }

  private currentPeer(peer: Peer): boolean {
    return this.peers.get(peer.seat) === peer
  }

  private canConnect(seat: Seat): boolean {
    return this.enabled && this.wantedSeats.has(seat)
  }

  private scheduleRetry(seat: Seat): void {
    if (!this.canConnect(seat) || !this.initiates(seat) || this.retryTimers.has(seat)) return
    const attempt = this.retryAttempts.get(seat) ?? 0
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt)
    const session = this.sessionGeneration
    this.retryAttempts.set(seat, attempt + 1)
    const timer = window.setTimeout(() => {
      if (this.retryTimers.get(seat) !== timer) return
      this.retryTimers.delete(seat)
      if (this.sessionGeneration !== session || !this.canConnect(seat) || !this.initiates(seat)) return
      this.close(seat)
      void this.open(seat)
    }, delay)
    this.retryTimers.set(seat, timer)
  }

  private clearRetry(seat: Seat): void {
    const timer = this.retryTimers.get(seat)
    if (timer === undefined) return
    window.clearTimeout(timer)
    this.retryTimers.delete(seat)
  }

  private startDisconnectedTimer(peer: Peer): void {
    if (!this.currentPeer(peer) || peer.disconnectedTimer !== null) return
    peer.disconnectedTimer = window.setTimeout(() => {
      peer.disconnectedTimer = null
      if (
        !this.currentPeer(peer) ||
        (peer.pc.connectionState !== 'disconnected' && peer.pc.iceConnectionState !== 'disconnected')
      ) return
      this.fail(peer)
    }, DISCONNECTED_TIMEOUT_MS)
  }

  private clearDisconnectedTimer(peer: Peer): void {
    if (peer.disconnectedTimer === null) return
    window.clearTimeout(peer.disconnectedTimer)
    peer.disconnectedTimer = null
  }

  private trusted(peer: Peer): boolean {
    return peer.status === 'secure' && this.verified.get(peer.seat) === peer.code
  }

  private hasVerifiedPeer(): boolean {
    for (const peer of this.peers.values()) if (this.trusted(peer)) return true
    return false
  }

  private enforceVoiceTrust(): void {
    if (!this.desiredMicOn || this.hasVerifiedPeer()) return
    this.desiredMicOn = false
    this.stopMicrophone()
    this.refreshAllVoice()
  }

  private refreshAllVoice(): void {
    for (const peer of this.peers.values()) this.refreshVoice(peer)
  }

  private refreshVoice(peer: Peer): void {
    const trusted = this.trusted(peer)
    this.refreshRemoteAudio(peer)
    this.queueSenderTrack(peer, trusted ? this.micTrack() : null)
  }

  private queueSenderTrack(peer: Peer, track: MediaStreamTrack | null): void {
    const revision = ++peer.voiceRevision
    const apply = async (): Promise<void> => {
      if (!this.currentPeer(peer) || peer.status === 'failed' || revision !== peer.voiceRevision) return
      const sender = peer.audio?.sender
      if (!sender) return
      try {
        await sender.replaceTrack(track)
      } catch {
        if (this.currentPeer(peer) && revision === peer.voiceRevision) this.fail(peer)
      }
    }
    peer.voiceQueue = peer.voiceQueue.then(apply, apply)
  }

  private refreshRemoteAudio(peer: Peer): void {
    const track = peer.remoteTrack
    const allowed = this.trusted(peer) && track?.readyState === 'live'
    if (!track || !allowed) {
      if (track) track.enabled = false
      this.teardownRemoteAudio(peer, false)
      return
    }
    track.enabled = true
    if (!peer.remoteAudio) {
      const audio = document.createElement('audio')
      audio.autoplay = true
      audio.dataset.seat = peer.seat
      audio.srcObject = new MediaStream([track])
      peer.remoteAudio = audio
      this.audioBox.appendChild(audio)
    }
    peer.voice = !track.muted
    void peer.remoteAudio.play().catch(() => undefined)
  }

  private teardownRemoteAudio(peer: Peer, stopTrack: boolean): void {
    if (peer.remoteAudio) {
      peer.remoteAudio.pause()
      peer.remoteAudio.srcObject = null
      peer.remoteAudio.remove()
      peer.remoteAudio = null
    }
    const track = peer.remoteTrack
    if (track) {
      track.enabled = false
      if (stopTrack) {
        track.onmute = track.onunmute = track.onended = null
        track.stop()
        peer.remoteTrack = null
      }
    }
    peer.voice = false
  }

  private startMicrophone(): void {
    if (this.micTask || this.mic || !this.desiredMicOn) return
    const task = this.acquireMicrophone()
    this.micTask = task
    const finish = (failed: boolean): void => {
      if (this.micTask !== task) return
      this.micTask = null
      if (failed && this.desiredMicOn) this.microphoneFailed()
      else if (this.desiredMicOn && !this.mic) this.startMicrophone()
      this.hooks.changed()
    }
    void task.then(() => finish(false), () => finish(true))
  }

  private async acquireMicrophone(): Promise<void> {
    while (this.desiredMicOn && !this.mic) {
      const session = this.sessionGeneration
      let request = this.permissionRequest
      let requestSession = this.permissionRequestSession
      if (!request) {
        requestSession = session
        try {
          request = navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          })
        } catch {
          this.microphoneFailed()
          return
        }
        this.permissionRequest = request
        this.permissionRequestSession = requestSession
      }
      let stream: MediaStream
      try {
        stream = await request
      } catch {
        if (this.permissionRequest === request) {
          this.permissionRequest = null
          this.permissionRequestSession = -1
        }
        if (requestSession === this.sessionGeneration && this.desiredMicOn) this.microphoneFailed()
        continue
      }
      if (this.permissionRequest === request) {
        this.permissionRequest = null
        this.permissionRequestSession = -1
      }
      if (requestSession !== this.sessionGeneration || !this.desiredMicOn) {
        for (const track of stream.getTracks()) track.stop()
        continue
      }
      if (!stream.getAudioTracks().length) {
        for (const track of stream.getTracks()) track.stop()
        this.microphoneFailed()
        return
      }
      this.mic = stream
      this.micOn = true
      this.micError = ''
      const track = stream.getAudioTracks()[0]
      track.addEventListener('ended', () => {
        if (this.mic !== stream) return
        this.desiredMicOn = false
        this.stopMicrophone()
        this.micError = '麦克风已断开，请检查设备后重试'
        this.refreshAllVoice()
        this.hooks.changed()
      }, { once: true })
      this.refreshAllVoice()
      this.hooks.changed()
      return
    }
  }

  private microphoneFailed(): void {
    this.desiredMicOn = false
    this.stopMicrophone()
    this.micError = '无法使用麦克风：请在浏览器中允许麦克风权限'
    this.refreshAllVoice()
    this.hooks.changed()
  }

  private stopMicrophone(): void {
    const stream = this.mic
    this.mic = null
    this.micOn = false
    if (stream) for (const track of stream.getTracks()) track.stop()
  }

  private closePeerTransport(peer: Peer): void {
    peer.voiceRevision += 1
    this.clearDisconnectedTimer(peer)
    peer.pc.onconnectionstatechange = null
    peer.pc.oniceconnectionstatechange = null
    peer.pc.onicecandidate = null
    peer.pc.ontrack = null
    peer.pc.ondatachannel = null
    if (peer.dc) {
      peer.dc.onopen = peer.dc.onclose = peer.dc.onerror = peer.dc.onmessage = null
      peer.dc.close()
      peer.dc = null
    }
    this.teardownRemoteAudio(peer, true)
    peer.pending = []
    peer.audio = null
    peer.pc.close()
  }

  private destroyPeer(seat: Seat): void {
    const peer = this.peers.get(seat)
    if (!peer) return
    this.peers.delete(seat)
    this.closePeerTransport(peer)
  }

  private close(seat: Seat): void {
    this.claimOperation(seat)
    this.opening.delete(seat)
    this.clearRetry(seat)
    this.earlyIce.delete(seat)
    this.destroyPeer(seat)
    this.enforceVoiceTrust()
  }

  private closeAll(): void {
    for (const seat of SEATS) this.close(seat)
  }

  private suspendConnections(): void {
    this.sessionGeneration += 1
    this.desiredMicOn = false
    this.micError = ''
    this.stopMicrophone()
    this.wantedSeats.clear()
    this.opening.clear()
    this.retryAttempts.clear()
    this.earlyIce.clear()
    this.closeAll()
    this.lines = []
    this.unread = 0
    this.verified.clear()
    this.changedCodes.clear()
    this.names = {}
  }
}
