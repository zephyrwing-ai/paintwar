/**
 * Connection lifecycle only: discovery, open, idle timeout and retry. It owns no room, seat or
 * game protocol; the caller confirms activity after it has validated a message.
 */
export type ConnectionState = 'stopped' | 'discovering' | 'connecting' | 'open' | 'retry' | 'unavailable'

export type ConnectionHooks = {
  state(state: ConnectionState): void
  text(text: string): void
  /** The socket closed. `wasOpen` is false when it never opened. */
  lost(code: number, wasOpen: boolean): void
}

const ENDPOINT = /^wss:\/\/[^/@?#:]+(:[0-9]+)?\/ws$|^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?\/ws$/
const IDLE_SECONDS = 10
const DISCOVERY_TIMEOUT_MS = 10_000
const MAX_BOOTSTRAP_BYTES = 4096

/** Same lookup as the Godot starter: `multiplayer/bootstrap.json` next to the game's index page. */
export function bootstrapUrl(href: string): string {
  const page = new URL(href)
  const marker = page.pathname.indexOf('/__manus__/game-preview/')
  if (marker >= 0) page.pathname = page.pathname.slice(0, marker + 1)
  page.search = ''
  page.hash = ''
  return new URL('multiplayer/bootstrap.json', page).href
}

export function validEndpoint(value: string): boolean {
  return ENDPOINT.test(value)
}

/**
 * `signalingUrl` may be the relative path `/ws`: the game page and its server share one origin
 * (Manus hosting routes `/ws` to the container), so the published domain never needs hard-coding.
 */
export function resolveEndpoint(value: string, href: string): string {
  if (!value.startsWith('/')) return value
  const page = new URL(href)
  return `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}${value}`
}

/** Development only: `?lag=150` delays every message both ways to exercise prediction. */
const ARTIFICIAL_LAG_MS = import.meta.env.DEV ? Math.min(1000, Math.max(0, Number(new URLSearchParams(location.search).get('lag')) || 0)) : 0

export class Connection {
  state: ConnectionState = 'stopped'
  endpoint = ''
  private socket?: WebSocket
  private generation = 0
  private idle = 0
  private retryDelay = 0.5
  private retryElapsed = 0
  private makeUrl: (endpoint: string) => string = endpoint => endpoint

  constructor(private readonly hooks: ConnectionHooks) {}

  /** Reads `bootstrap.json`, checks it belongs to this client build, then connects. */
  discover(url: string, build: string, makeUrl: (endpoint: string) => string): void {
    this.stop()
    this.makeUrl = makeUrl
    this.set('discovering')
    const generation = this.generation
    const abort = new AbortController()
    const timer = window.setTimeout(() => abort.abort(), DISCOVERY_TIMEOUT_MS)
    void fetch(url, { cache: 'no-store', signal: abort.signal })
      .then(async response => {
        const text = await response.text()
        if (!response.ok || text.length > MAX_BOOTSTRAP_BYTES) return null
        return JSON.parse(text) as unknown
      })
      .catch(() => null)
      .then(config => {
        window.clearTimeout(timer)
        if (generation !== this.generation || this.state !== 'discovering') return
        const value = config as { version?: unknown; build?: unknown; signalingUrl?: unknown } | null
        if (!value || value.version !== 1 || value.build !== build || typeof value.signalingUrl !== 'string') {
          this.set('unavailable')
          return
        }
        this.accept(resolveEndpoint(value.signalingUrl, location.href))
      })
  }

  /** Called by the game every frame; drives the idle timeout and the retry backoff. */
  poll(seconds: number): void {
    if (this.state === 'retry') {
      this.retryElapsed += seconds
      if (this.retryElapsed >= this.retryDelay) this.open()
      return
    }
    if (this.state !== 'open') return
    this.idle += seconds
    if (this.idle > IDLE_SECONDS) this.reconnect(4000)
  }

  confirmActivity(): void {
    this.idle = 0
  }

  send(text: string): boolean {
    if (this.state !== 'open' || this.socket?.readyState !== WebSocket.OPEN) return false
    if (ARTIFICIAL_LAG_MS > 0) {
      const socket = this.socket
      window.setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send(text) }, ARTIFICIAL_LAG_MS)
    } else {
      this.socket.send(text)
    }
    return true
  }

  reconnect(code = 1000): void {
    if (this.state !== 'connecting' && this.state !== 'open') return
    const wasOpen = this.state === 'open'
    this.close(code)
    this.generation += 1
    this.retryElapsed = 0
    this.retryDelay = Math.min(4, this.retryDelay * 1.65)
    this.set('retry')
    this.hooks.lost(code, wasOpen)
  }

  stop(): void {
    this.generation += 1
    this.close(1000)
    this.endpoint = ''
    this.idle = 0
    this.retryDelay = 0.5
    this.retryElapsed = 0
    this.set('stopped')
  }

  private accept(value: string): void {
    if (!validEndpoint(value)) {
      this.set('unavailable')
      return
    }
    this.endpoint = value
    this.open()
  }

  private open(): void {
    this.idle = 0
    const generation = this.generation
    let socket: WebSocket
    try {
      socket = new WebSocket(this.makeUrl(this.endpoint))
    } catch {
      this.set('connecting')
      this.reconnect()
      return
    }
    this.socket = socket
    this.set('connecting')
    socket.onopen = () => {
      if (generation !== this.generation) return
      this.retryDelay = 0.5
      this.idle = 0
      this.set('open')
    }
    socket.onmessage = event => {
      if (generation !== this.generation || typeof event.data !== 'string') return
      const text = event.data
      if (ARTIFICIAL_LAG_MS > 0) window.setTimeout(() => { if (generation === this.generation) this.hooks.text(text) }, ARTIFICIAL_LAG_MS)
      else this.hooks.text(text)
    }
    socket.onclose = event => {
      if (generation === this.generation) this.reconnect(event.code)
    }
  }

  private close(code: number): void {
    const socket = this.socket
    this.socket = undefined
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onclose = null
    // Browsers only accept 1000 and 3000-4999 from scripts.
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000)
  }

  private set(state: ConnectionState): void {
    this.state = state
    this.hooks.state(state)
  }
}
