/**
 * Integration tests: start an isolated server on port 0 and drive it with real WebSocket clients.
 * Run: pnpm --dir server test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { CHAT_CAPABILITY, MAX_MESSAGE_BYTES, MAX_SIGNAL_BYTES, MAX_SOCKET_BYTES } from '../shared/protocol.ts'
import { decode } from '../src/net/protocol.ts'

type Msg = Record<string, any>

async function startServer(env: Record<string, string> = {}): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.ts'], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = ''
    proc.stdout!.on('data', chunk => {
      buffer += String(chunk)
      const line = buffer.split('\n').find(l => l.includes('"listening"'))
      if (line) resolve(JSON.parse(line).port)
    })
    proc.on('exit', code => reject(new Error(`server exited ${code}`)))
  })
  return { proc, url: `ws://127.0.0.1:${port}/ws` }
}

class TestClient {
  ws: WebSocket
  messages: Msg[] = []
  closeCode = 0
  private waiters: Array<() => void> = []
  constructor(url: string, origin?: string) {
    this.ws = new WebSocket(url, origin ? { origin } : {})
    this.ws.on('message', data => {
      this.messages.push(JSON.parse(String(data)))
      for (const w of this.waiters.splice(0)) w()
    })
    this.ws.on('close', code => {
      this.closeCode = code
      for (const w of this.waiters.splice(0)) w()
    })
    this.ws.on('error', () => {})
  }
  send(message: Msg): void {
    this.ws.send(JSON.stringify(message))
  }
  last(type: string): Msg | undefined {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) if (this.messages[i].type === type) return this.messages[i]
    return undefined
  }
  count(type: string): number {
    return this.messages.filter(message => message.type === type).length
  }
  async waitFor(predicate: (m: Msg) => boolean, timeout = 5000, label = 'message'): Promise<Msg> {
    const start = Date.now()
    let seen = 0
    for (;;) {
      for (; seen < this.messages.length; seen += 1) if (predicate(this.messages[seen])) return this.messages[seen]
      if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`)
      await new Promise<void>(resolve => {
        this.waiters.push(resolve)
        setTimeout(resolve, 100)
      })
    }
  }
  async closed(timeout = 3000): Promise<number> {
    const start = Date.now()
    while (this.ws.readyState !== WebSocket.CLOSED) {
      if (Date.now() - start > timeout) throw new Error('timeout waiting for close')
      await new Promise(r => setTimeout(r, 30))
    }
    return this.closeCode
  }
  close(): void {
    this.ws.close()
  }
}

const join = (url: string, room: string, opts: { create?: boolean; name?: string; resume?: string; origin?: string } = {}) =>
  new TestClient(`${url}?room=${room}&create=${opts.create ? 1 : 0}&name=${encodeURIComponent(opts.name ?? '')}${opts.resume ? `&resume=${opts.resume}` : ''}`, opts.origin)

async function liveRoom(url: string, room: string) {
  const a = join(url, room, { create: true, name: '甲' })
  const wa = await a.waitFor(m => m.type === 'welcome')
  const b = join(url, room, { name: '乙' })
  const wb = await b.waitFor(m => m.type === 'welcome')
  a.send({ type: 'ready', ready: true })
  b.send({ type: 'ready', ready: true })
  await a.waitFor(m => m.type === 'room' && m.phase === 'countdown', 3000, 'countdown')
  const live = await a.waitFor(m => m.type === 'room' && m.phase === 'live', 5000, 'live')
  return { a, b, wa, wb, live }
}

test('create, join, errors, spectators', async () => {
  const { proc, url } = await startServer()
  try {
    const missing = join(url, 'ZZZZ')
    const err = await missing.waitFor(m => m.type === 'error')
    assert.equal(err.code, 'room_not_found')
    assert.equal(await missing.closed(), 4004)

    const a = join(url, 'ABCD', { create: true, name: '小红<b>' })
    const wa = await a.waitFor(m => m.type === 'welcome')
    assert.equal(wa.role, 'p1')
    assert.equal(wa.name, '小红b')
    assert.deepEqual(wa.capabilities, [CHAT_CAPABILITY])
    assert.ok(wa.resume_token.length > 10)

    const dup = join(url, 'ABCD', { create: true })
    assert.equal((await dup.waitFor(m => m.type === 'error')).code, 'room_exists')

    const others = [join(url, 'ABCD', { name: 'B' }), join(url, 'ABCD', { name: 'C' }), join(url, 'ABCD', { name: 'D' })]
    const roles = await Promise.all(others.map(c => c.waitFor(m => m.type === 'welcome').then(m => m.role)))
    assert.deepEqual(roles.sort(), ['p2', 'p3', 'p4'])
    const fifth = join(url, 'ABCD', { name: 'E' })
    assert.equal((await fifth.waitFor(m => m.type === 'welcome')).role, 'spectator')
    const room = await a.waitFor(m => m.type === 'room' && m.spectators === 1)
    assert.equal(room.host, 'p1')
    assert.equal(Object.keys(room.seats).length, 4)

    // A seated player leaves: the spectator takes the free seat at once (lobby).
    others[0].send({ type: 'leave' })
    const promoted = await fifth.waitFor(m => m.type === 'welcome' && m.role !== 'spectator')
    assert.ok(['p2', 'p3', 'p4'].includes(promoted.role))
    // The host leaves: host moves to the next earliest seat.
    a.send({ type: 'leave' })
    const after = await fifth.waitFor(m => m.type === 'room' && m.host && m.host !== 'p1')
    assert.ok(after.host)
    for (const c of [...others, fifth]) c.close()
  } finally {
    proc.kill()
  }
})

test('ready, countdown, live snapshots, intents, dedupe', async () => {
  const { proc, url } = await startServer()
  try {
    const { a, b, live } = await liveRoom(url, 'LVXY')
    assert.equal(live.round, 1)
    assert.ok(live.ends_at - live.live_at === 90_000)
    const s1 = await a.waitFor(m => m.type === 'snap' && m.tick >= 2)
    assert.ok(s1.players.p1 && s1.players.p2)
    assert.equal(s1.grid.length, 384)
    // p1 starts at (1,1) heading right: it is moving along y = 18.
    assert.equal(s1.players.p1.y, 18)
    const s2 = await a.waitFor(m => m.type === 'snap' && m.tick >= s1.tick + 4)
    assert.ok(s2.players.p1.x > s1.players.p1.x, 'server moves p1')
    // Snapshots arrive at about 20 Hz.
    const count0 = a.messages.filter(m => m.type === 'snap').length
    await new Promise(r => setTimeout(r, 1000))
    const perSecond = a.messages.filter(m => m.type === 'snap').length - count0
    assert.ok(perSecond >= 15 && perSecond <= 25, `snap rate ${perSecond}`)

    // Dash while p1 is still running along the open top row: cooldown starts, then it ends.
    a.send({ type: 'dash', round: 1, seq: 1, tick: a.last('snap')!.tick })
    const dashed = await a.waitFor(m => m.type === 'snap' && m.players.p1.cd > 0, 2000, 'dash cooldown')
    assert.ok(dashed.players.p1.cd <= 60)
    a.send({ type: 'dash', round: 1, seq: 2, tick: a.last('snap')!.tick }) // on cooldown: no effect
    await a.waitFor(m => m.type === 'snap' && m.players.p1.dash === 0 && m.players.p1.ack === 2, 2000, 'dash over')
    assert.ok(a.last('snap')!.players.p1.cd > 40, 'second dash did not restart the cooldown')

    // Turn down at a cell ahead of p1.
    const now = a.last('snap')!
    const cx = Math.floor(now.players.p1.x / 12) + 2
    const cell = 1 * 24 + cx
    a.send({ type: 'turn', round: 1, seq: 3, dir: 3, cell })
    a.send({ type: 'turn', round: 1, seq: 3, dir: 1, cell }) // duplicate seq: ignored
    a.send({ type: 'turn', round: 99, seq: 4, dir: 1, cell }) // wrong round: ignored
    const turned = await a.waitFor(m => m.type === 'snap' && m.players.p1.dir === 3, 3000, 'p1 heading down')
    assert.equal(turned.players.p1.x, cx * 12 + 6)
    assert.equal(turned.players.p1.ack, 3)
    // Malformed intents are dropped silently; the connection stays open.
    a.send({ type: 'turn', round: 1, seq: 5, dir: 7, cell: 5 })
    a.ws.send('not json')
    await new Promise(r => setTimeout(r, 200))
    assert.equal(a.ws.readyState, WebSocket.OPEN)
    a.close()
    b.close()
  } finally {
    proc.kill()
  }
})

test('disconnect freezes, resume restores the seat, leaving forfeits, rematch', async () => {
  const { proc, url } = await startServer()
  try {
    const { a, b, wb } = await liveRoom(url, 'RCNX')
    await a.waitFor(m => m.type === 'snap' && m.tick >= 4)
    b.ws.terminate()
    const away = await a.waitFor(m => m.type === 'snap' && m.players.p2?.away === true, 3000, 'p2 away')
    const frozenX = away.players.p2.x
    await new Promise(r => setTimeout(r, 400))
    assert.equal(a.last('snap')!.players.p2.x, frozenX, 'away painter is frozen')
    assert.ok(away.ev.some((e: Msg) => e.k === 'away' && e.a === 'p2'))

    const b2 = join(url, 'RCNX', { resume: wb.resume_token })
    const w2 = await b2.waitFor(m => m.type === 'welcome')
    assert.equal(w2.role, 'p2')
    assert.equal(w2.resume_token, wb.resume_token)
    // Full state on reconnect: room + current snapshot right away.
    assert.ok(await b2.waitFor(m => m.type === 'room' && m.phase === 'live'))
    const back = await b2.waitFor(m => m.type === 'snap' && m.players.p2?.away === false)
    assert.ok(back.players.p1)

    // p2 leaves explicitly: fewer than two painters -> the round ends at once, p1 wins.
    b2.send({ type: 'leave' })
    const results = await a.waitFor(m => m.type === 'room' && m.phase === 'results', 3000, 'results')
    assert.equal(results.result.winner, 'p1')
    assert.equal(results.result.reason, 'forfeit')
    assert.equal(results.seats.p1.wins, 1)
    assert.equal(await b2.closed(), 4010)

    // A new player joins and both ready again: rematch without going back to the lobby.
    const c = join(url, 'RCNX', { name: '丙' })
    assert.equal((await c.waitFor(m => m.type === 'welcome')).role, 'p2')
    a.send({ type: 'ready', ready: true })
    c.send({ type: 'ready', ready: true })
    await a.waitFor(m => m.type === 'room' && m.phase === 'countdown')
    // Cancelling ready aborts the countdown back to results.
    c.send({ type: 'ready', ready: false })
    const aborted = await a.waitFor(m => m.type === 'room' && m.phase === 'results' && m.seats.p2 && !m.seats.p2.ready)
    assert.equal(aborted.seats.p1.wins, 1)
    a.close()
    c.close()
  } finally {
    proc.kill()
  }
})

test('seat hold expires and ends the round; resume tab replacement', async () => {
  const { proc, url } = await startServer({ RECONNECT_GRACE_MS: '1200' })
  try {
    const { a, b, wa } = await liveRoom(url, 'GNXY')
    // Same seat opened in a second tab: the first socket is closed with 4001.
    const a2 = join(url, 'GNXY', { resume: wa.resume_token })
    assert.equal((await a2.waitFor(m => m.type === 'welcome')).role, 'p1')
    assert.equal(await a.closed(), 4001)
    b.ws.terminate()
    const results = await a2.waitFor(m => m.type === 'room' && m.phase === 'results', 5000, 'results after grace')
    assert.equal(results.result.winner, 'p1')
    assert.equal(results.seats.p2, undefined, 'expired seat is freed')
    a2.close()
  } finally {
    proc.kill()
  }
})

test('origin allowlist', async () => {
  const { proc, url } = await startServer({ ALLOWED_ORIGINS: 'https://friend.example' })
  try {
    const bad = join(url, 'ABRG', { create: true, origin: 'https://evil.example' })
    await bad.closed()
    assert.equal(bad.messages.length, 0)
    const good = join(url, 'ABRG', { create: true, origin: 'https://friend.example' })
    assert.equal((await good.waitFor(m => m.type === 'welcome')).role, 'p1')
    good.close()
  } finally {
    proc.kill()
  }
})

test('client decoder normalizes capabilities and validates rtc', () => {
  const welcome = (capabilities?: unknown) => JSON.stringify({
    type: 'welcome', marker: 'paint-war-v1', room: 'DECX', role: 'p1', resume_token: 'token', name: 'A', now: 1,
    ...(capabilities === undefined ? {} : { capabilities }),
  })
  assert.deepEqual((decode(welcome(), 'DECX', -1) as Msg).capabilities, [])
  assert.deepEqual((decode(welcome([CHAT_CAPABILITY]), 'DECX', -1) as Msg).capabilities, [CHAT_CAPABILITY])
  assert.equal(decode(welcome([CHAT_CAPABILITY, 1]), 'DECX', -1), null)

  const rtc = (kind: unknown, data: string) => JSON.stringify({
    type: 'rtc', marker: 'paint-war-v1', room: 'DECX', from: 'p1', kind, data,
  })
  assert.equal((decode(rtc('offer', 'sdp'), 'DECX', -1) as Msg).from, 'p1')
  assert.equal(decode(rtc('closed', 'sdp'), 'DECX', -1), null)
  assert.equal(decode(rtc('offer', '你'.repeat(Math.floor(MAX_SIGNAL_BYTES / 3) + 1)), 'DECX', -1), null)
})

test('welcome capabilities and rtc relay authorization', async () => {
  const { proc, url } = await startServer()
  try {
    const a = join(url, 'RTCX', { create: true, name: 'A' })
    const wa = await a.waitFor(m => m.type === 'welcome')
    assert.equal(wa.marker, 'paint-war-v1')
    assert.deepEqual(wa.capabilities, [CHAT_CAPABILITY])

    const b = join(url, 'RTCX', { name: 'B' })
    const c = join(url, 'RTCX', { name: 'C' })
    const d = join(url, 'RTCX', { name: 'D' })
    assert.equal((await b.waitFor(m => m.type === 'welcome')).role, 'p2')
    assert.deepEqual((await Promise.all([
      c.waitFor(m => m.type === 'welcome').then(m => m.role),
      d.waitFor(m => m.type === 'welcome').then(m => m.role),
    ])).sort(), ['p3', 'p4'])
    const spectator = join(url, 'RTCX', { name: 'E' })
    assert.equal((await spectator.waitFor(m => m.type === 'welcome')).role, 'spectator')

    a.send({ type: 'rtc', to: 'p2', from: 'p4', kind: 'offer', data: 'offer-from-p1' })
    const relayed = await b.waitFor(m => m.type === 'rtc')
    assert.deepEqual(relayed, {
      type: 'rtc', marker: 'paint-war-v1', room: 'RTCX', from: 'p1', kind: 'offer', data: 'offer-from-p1',
    })

    const p1Signals = a.count('rtc')
    const p2Signals = b.count('rtc')
    a.send({ type: 'rtc', to: 'p1', kind: 'offer', data: 'self' })
    a.send({ type: 'rtc', to: 'p2', kind: 'closed', data: 'invalid-kind' })
    spectator.send({ type: 'rtc', to: 'p1', kind: 'offer', data: 'spectator' })
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(a.count('rtc'), p1Signals)
    assert.equal(b.count('rtc'), p2Signals)
    assert.equal(a.ws.readyState, WebSocket.OPEN)

    for (const client of [a, b, c, d, spectator]) client.close()
  } finally {
    proc.kill()
  }
})

test('message byte limits and rtc payload limits', async () => {
  const { proc, url } = await startServer()
  try {
    const a = join(url, 'BNDX', { create: true, name: 'A' })
    const b = join(url, 'BNDX', { name: 'B' })
    const c = join(url, 'BNDX', { name: 'C' })
    const d = join(url, 'BNDX', { name: 'D' })
    await a.waitFor(m => m.type === 'welcome')
    await b.waitFor(m => m.type === 'welcome')
    assert.deepEqual((await Promise.all([
      c.waitFor(m => m.type === 'welcome').then(m => m.role),
      d.waitFor(m => m.type === 'welcome').then(m => m.role),
    ])).sort(), ['p3', 'p4'])
    const spectator = join(url, 'BNDX', { name: 'E' })
    assert.equal((await spectator.waitFor(m => m.type === 'welcome')).role, 'spectator')

    // A multibyte game message exceeds 4 KiB after UTF-8 encoding even though its code-point count is lower.
    const pongs = a.count('pong')
    a.ws.send(JSON.stringify({ type: 'ping', t: 1, padding: '你'.repeat(Math.floor(MAX_MESSAGE_BYTES / 3) + 1) }))
    const p2Signals = b.count('rtc')
    a.send({ type: 'rtc', to: 'p2', kind: 'offer', data: '你'.repeat(Math.floor(MAX_SIGNAL_BYTES / 3) + 1) })
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(a.count('pong'), pongs)
    assert.equal(b.count('rtc'), p2Signals)
    assert.equal(a.ws.readyState, WebSocket.OPEN)

    // Spectators cannot use the larger signal budget to bypass the 4 KiB frame limit.
    const p1Signals = a.count('rtc')
    spectator.ws.send(JSON.stringify({
      type: 'rtc', to: 'p1', kind: 'offer', data: '你'.repeat(Math.floor(MAX_MESSAGE_BYTES / 3) + 1),
    }))
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(a.count('rtc'), p1Signals)
    spectator.send({ type: 'ping', t: 2 })
    assert.equal((await spectator.waitFor(m => m.type === 'pong' && m.t === 2)).t, 2)

    // The WebSocket transport rejects a frame beyond its absolute payload ceiling.
    a.ws.send(JSON.stringify({ type: 'ping', t: 3, padding: 'x'.repeat(MAX_SOCKET_BYTES) }))
    assert.equal(await a.closed(), 1009)

    for (const client of [b, c, d, spectator]) client.close()
  } finally {
    proc.kill()
  }
})
