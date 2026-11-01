/**
 * Web Audio mixer with music and SFX buses. Browsers only allow audio after a user gesture, so
 * `unlock()` is called from the first click/key press. Every sound is synthesized: no files.
 */
export type Sfx =
  | 'dash' | 'hit' | 'stunned' | 'bomb' | 'spawn' | 'count' | 'go' | 'join' | 'leave' | 'ui'
  | 'ready' | 'win' | 'lose' | 'tick' | 'frenzy' | 'end' | 'error'

export type MusicMode = 'off' | 'lobby' | 'live' | 'frenzy'

export class Audio {
  readonly ctx: AudioContext
  private master: GainNode
  private music: GainNode
  private sfx: GainNode
  private noise: AudioBuffer
  private mode: MusicMode = 'off'
  private timer = 0
  private nextNote = 0
  private stepIndex = 0
  private lastPaint = 0

  constructor() {
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.music = this.ctx.createGain()
    this.sfx = this.ctx.createGain()
    this.music.connect(this.master)
    this.sfx.connect(this.master)
    this.master.connect(this.ctx.destination)
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.5, this.ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1
  }

  unlock(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  /** Volumes in 0..1. */
  setVolumes(music: number, sfx: number, muted = false): void {
    const t = this.ctx.currentTime
    this.music.gain.setTargetAtTime(muted ? 0 : music * 0.4, t, 0.05)
    this.sfx.gain.setTargetAtTime(muted ? 0 : sfx * 0.8, t, 0.05)
  }

  private tone(freq: number, end: number, dur: number, type: OscillatorType, vol: number, delay = 0, bus = this.sfx): void {
    const t = this.ctx.currentTime + delay
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(end, 20), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(bus)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  private hiss(dur: number, vol: number, freq: number, delay = 0, bus = this.sfx, q = 1): void {
    const t = this.ctx.currentTime + delay
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = freq
    filter.Q.value = q
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(filter).connect(g).connect(bus)
    src.start(t)
    src.stop(t + dur + 0.05)
  }

  /** A wet "splat" whose pitch climbs with consecutive new cells (combo). */
  paint(combo: number): void {
    if (this.ctx.state !== 'running') return
    const now = this.ctx.currentTime
    if (now - this.lastPaint < 0.045) return
    this.lastPaint = now
    const step = Math.min(combo, 24)
    const scale = [0, 2, 4, 7, 9]
    const semis = Math.floor(step / 5) * 12 + scale[step % 5]
    const f = 330 * Math.pow(2, semis / 12 / 2)
    this.tone(f, f * 1.5, 0.07, 'triangle', 0.12)
    this.hiss(0.05, 0.05, 2400, 0, this.sfx, 2)
  }

  play(name: Sfx): void {
    if (this.ctx.state !== 'running') return
    switch (name) {
      case 'dash': this.hiss(0.22, 0.25, 1400, 0, this.sfx, 0.7); this.tone(300, 900, 0.16, 'sawtooth', 0.06); break
      case 'hit': this.tone(160, 50, 0.25, 'sine', 0.6); this.hiss(0.18, 0.35, 900); this.tone(900, 300, 0.12, 'square', 0.08); break
      case 'stunned': [880, 1175, 880, 1175].forEach((f, i) => this.tone(f, f, 0.08, 'sine', 0.12, i * 0.09)); break
      case 'bomb': this.tone(120, 40, 0.5, 'sine', 0.6); this.hiss(0.45, 0.45, 600, 0, this.sfx, 0.5); this.tone(600, 1400, 0.25, 'triangle', 0.12, 0.05); break
      case 'spawn': this.tone(700, 1400, 0.18, 'sine', 0.12); this.tone(1050, 2100, 0.18, 'sine', 0.08, 0.06); break
      case 'count': this.tone(660, 660, 0.14, 'triangle', 0.3); break
      case 'go': this.tone(880, 1320, 0.32, 'triangle', 0.35); this.tone(440, 660, 0.32, 'square', 0.08); break
      case 'join': this.tone(660, 990, 0.14, 'sine', 0.25); this.tone(990, 1320, 0.16, 'sine', 0.2, 0.08); break
      case 'leave': this.tone(660, 440, 0.18, 'sine', 0.2); this.tone(440, 330, 0.2, 'sine', 0.15, 0.1); break
      case 'ui': this.tone(660, 700, 0.06, 'triangle', 0.18); break
      case 'ready': this.tone(523, 523, 0.08, 'triangle', 0.22); this.tone(784, 784, 0.12, 'triangle', 0.22, 0.07); break
      case 'tick': this.tone(1200, 1200, 0.05, 'square', 0.06); break
      case 'frenzy': [392, 523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.12, 'square', 0.09, i * 0.06)); this.hiss(0.6, 0.15, 3000, 0.1, this.sfx, 0.4); break
      case 'end': this.tone(880, 220, 0.6, 'sawtooth', 0.12); this.hiss(0.4, 0.2, 1200); break
      case 'win': [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, f * 1.01, 0.32, 'triangle', 0.25, i * 0.1)); break
      case 'lose': [392, 330, 262].forEach((f, i) => this.tone(f, f * 0.98, 0.38, 'sine', 0.25, i * 0.16)); break
      case 'error': this.tone(220, 180, 0.2, 'square', 0.1); break
    }
  }

  /** Step sequencer: calm in the lobby, driving in a round, faster in frenzy time. */
  setMusic(mode: MusicMode): void {
    if (mode === this.mode) return
    this.mode = mode
    clearTimeout(this.timer)
    if (mode === 'off') return
    this.nextNote = this.ctx.currentTime + 0.08
    const schedule = () => {
      if (this.mode === 'off') return
      const bpm = this.mode === 'frenzy' ? 152 : this.mode === 'live' ? 124 : 92
      const sixteenth = 60 / bpm / 4
      while (this.nextNote < this.ctx.currentTime + 0.15) {
        this.note(this.stepIndex, this.nextNote - this.ctx.currentTime)
        this.nextNote += sixteenth
        this.stepIndex = (this.stepIndex + 1) % 64
      }
      this.timer = window.setTimeout(schedule, 40)
    }
    schedule()
  }

  private note(i: number, delay: number): void {
    if (this.ctx.state !== 'running') return
    const roots = [220, 174.6, 261.6, 196]
    const root = roots[Math.floor(i / 16) % 4]
    const s = i % 16
    if (this.mode === 'lobby') {
      if (s % 4 === 0) this.tone(root, root, 0.5, 'sine', 0.12, delay, this.music)
      if (s === 6 || s === 14) this.tone(root * 3, root * 3, 0.25, 'triangle', 0.05, delay, this.music)
      return
    }
    // Bass on eighths, kick on beats, hats off-beat, a small arpeggio.
    if (s % 2 === 0) this.tone(root / 2, root / 2, 0.14, 'triangle', 0.22, delay, this.music)
    if (s % 4 === 0) this.tone(140, 45, 0.18, 'sine', 0.45, delay, this.music)
    if (s % 4 === 2) this.hiss(0.04, 0.12, 7000, delay, this.music, 0.8)
    if (s === 4 || s === 12) this.hiss(0.12, 0.18, 1800, delay, this.music, 0.6)
    const arp = [1, 1.26, 1.5, 2, 1.5, 1.26]
    if (s % 2 === 1 || this.mode === 'frenzy') this.tone(root * 2 * arp[(i >> 1) % arp.length], root * 2 * arp[(i >> 1) % arp.length], 0.1, 'square', this.mode === 'frenzy' ? 0.045 : 0.03, delay, this.music)
  }
}
