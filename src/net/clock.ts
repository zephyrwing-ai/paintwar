/**
 * Server clock estimate. Every pong carries the client send time `t` and the server time `s`;
 * the sample with the smallest round trip among the recent ones gives the best offset.
 * Countdowns, the round timer and the simulation tick are all derived from `serverNow()`.
 */
const WINDOW = 12

export const clientNow = (): number => performance.timeOrigin + performance.now()

export class ServerClock {
  private samples: Array<{ rtt: number; offset: number }> = []
  offset = 0
  rtt = -1

  reset(): void {
    this.samples = []
    this.rtt = -1
  }

  /** Coarse offset from the `now` field of welcome, until pongs arrive. */
  seed(serverNow: number): void {
    if (this.samples.length === 0) this.offset = serverNow - clientNow()
  }

  sample(sentAt: number, serverAt: number, receivedAt = clientNow()): void {
    const rtt = receivedAt - sentAt
    if (!(rtt >= 0) || rtt > 5000) return
    this.samples.push({ rtt, offset: serverAt - (sentAt + rtt / 2) })
    if (this.samples.length > WINDOW) this.samples.shift()
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a))
    this.offset = best.offset
    this.rtt = this.rtt < 0 ? rtt : this.rtt + (rtt - this.rtt) * 0.25
  }

  get ready(): boolean {
    return this.samples.length > 0
  }

  serverNow(): number {
    return clientNow() + this.offset
  }
}
