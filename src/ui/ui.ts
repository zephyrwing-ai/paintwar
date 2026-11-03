import type { Audio } from '../engine/audio'
import type { Input } from '../engine/input'
import type { Quality, SaveData, SaveStore } from '../engine/save'
import { SEATS, type Seat } from '../../shared/rules.ts'
import { cleanName, cleanRoom, ROOM_LENGTH, type Role, type RoomMsg } from '../../shared/protocol.ts'
import type { Hud } from '../game/game'
import { SEAT_COLOR_NAME, SEAT_CSS } from '../game/palette'

export type Screen = 'boot' | 'home' | 'notice' | 'play' | 'menu' | 'settings'
export type NetStatus = 'connecting' | 'reconnecting' | 'online'

export type UiActions = {
  create(name: string): void
  join(room: string, name: string): void
  /** Lobby "ready" and results "play again" both set ready; only the button can cancel. */
  ready(ready: boolean): void
  leave(): void
  invite(): void
  settings(patch: Partial<SaveData>): void
  retryBoot(): void
  rename(name: string): void
}

export type NoticeAction = { label: string; primary?: boolean; run(): void }
export type PlayView = { room: RoomMsg | null; code: string; role: Role; status: NetStatus; hud: Hud; ping: number }

const ICON = {
  dice: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="8.5" cy="8.5" r="1.6" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.6" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.6" fill="currentColor"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="3" rx="1.5" fill="currentColor"/><rect x="4" y="10.5" width="16" height="3" rx="1.5" fill="currentColor"/><rect x="4" y="16" width="16" height="3" rx="1.5" fill="currentColor"/></svg>',
  crown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" fill="currentColor"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
}

const TITLE_HTML = [...'涂地大作战'].map((ch, i) => `<span style="--c:${['#ff4d6d', '#3a86ff', '#ffbe0b', '#9b5de5', '#ff4d6d'][i]};--i:${i}">${ch}</span>`).join('')

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const pct = (v: number) => `${v.toFixed(1)}%`

function clock(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * DOM UI layered over the canvas. Every screen works with mouse, keyboard and touch. The play
 * screen is driven per frame from the authoritative room message plus the local HUD snapshot.
 */
export class Ui {
  screen: Screen = 'boot'
  private readonly root: HTMLElement
  private readonly stack: Screen[] = []
  private cache = new Map<string, string>()
  private notices: NoticeAction[] = []
  private resultsRound = -1
  private resultsAt = 0
  private revealed = false
  private countTick = 0
  private roundSeen = -1
  private roundAt = 0
  private copiedUntil = 0
  private view: PlayView | null = null
  private readonly bannerEl: HTMLElement
  private bannerTimer = 0

  constructor(
    private readonly save: SaveStore,
    private readonly audio: Audio,
    private readonly input: Input,
    private readonly actions: UiActions,
  ) {
    this.root = document.getElementById('ui')!
    this.root.innerHTML = this.template()
    this.bannerEl = this.q('.banner')
    this.root.addEventListener('click', e => this.onClick(e))
    this.root.addEventListener('input', e => this.onInput(e))
    window.addEventListener('keydown', e => this.onKey(e))
    this.refreshSettings()
  }

  get labelLayer(): HTMLElement {
    return this.q('.labels')
  }

  // ─── screens ────────────────────────────────────────────────────────────

  show(screen: Screen): void {
    this.stack.length = 0
    this.setScreen(screen)
  }

  push(screen: Screen): void {
    this.stack.push(this.screen)
    this.setScreen(screen)
  }

  back(): void {
    const prev = this.stack.pop()
    if (prev) this.setScreen(prev)
  }

  private setScreen(screen: Screen): void {
    this.screen = screen
    const base = screen === 'menu' || screen === 'settings' ? this.stack.find(s => s !== 'menu' && s !== 'settings') : screen
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-screen]')) {
      const active = el.dataset.screen === screen || el.dataset.screen === base
      el.classList.toggle('is-active', active)
      el.setAttribute('aria-hidden', String(!active))
    }
    this.root.dataset.activeScreen = screen
    document.body.dataset.screen = screen
    if (screen === 'home' && this.input.method !== 'touch') {
      requestAnimationFrame(() => this.q<HTMLElement>(this.q('.invite-card').hidden ? '[data-action="create"]' : '[data-action="join-invite"]').focus({ preventScroll: true }))
    }
  }

  setBootProgress(progress: number, text = '正在加载画笔和颜料…'): void {
    this.q<HTMLElement>('.boot-bar i').style.transform = `scaleX(${Math.max(0.04, Math.min(1, progress))})`
    this.q('.boot-status').textContent = text
    this.q('.boot-retry').hidden = true
  }

  bootFailed(): void {
    this.q('.boot-status').textContent = '加载失败，请检查网络后重试'
    this.q('.boot-retry').hidden = false
  }

  /** Home screen, optionally with an invitation to a specific room. */
  home(name: string, invite: string): void {
    this.q<HTMLInputElement>('.name-input').value = name
    const card = this.q('.invite-card')
    card.hidden = !invite
    this.q('.invite-code').textContent = invite
    this.q('.home-actions').classList.toggle('is-secondary', Boolean(invite))
    this.q<HTMLInputElement>('.room-input').value = ''
    this.show('home')
  }

  notice(title: string, text: string, actions: NoticeAction[]): void {
    this.notices = actions
    this.q('.notice-title').textContent = title
    this.q('.notice-text').textContent = text
    this.q('.notice-actions').innerHTML = actions.map((a, i) => `<button class="btn ${a.primary ? 'primary' : ''}" data-notice="${i}">${esc(a.label)}</button>`).join('')
    this.show('notice')
  }

  copied(): void {
    this.copiedUntil = performance.now() + 1800
    this.toast('邀请链接已复制，发给朋友吧', 'good')
  }

  toast(text: string, tone: 'info' | 'good' | 'bad' = 'info'): void {
    const box = this.q('.toasts')
    const el = document.createElement('div')
    el.className = `toast is-${tone}`
    el.textContent = text
    box.appendChild(el)
    while (box.children.length > 3) box.firstElementChild!.remove()
    window.setTimeout(() => el.classList.add('is-out'), 2400)
    window.setTimeout(() => el.remove(), 2800)
  }

  banner(text: string, tone: 'frenzy' | 'hit' | 'go' = 'go'): void {
    const el = this.bannerEl
    el.querySelector('b')!.textContent = text
    el.className = `banner is-${tone}`
    void el.offsetWidth
    el.classList.add('is-active')
    window.clearTimeout(this.bannerTimer)
    this.bannerTimer = window.setTimeout(() => el.classList.remove('is-active'), tone === 'frenzy' ? 1800 : 1100)
  }

  // ─── play screen ────────────────────────────────────────────────────────

  private set(key: string, value: string, html = false): void {
    if (this.cache.get(key) === value) return
    this.cache.set(key, value)
    const el = this.q(`[data-k="${key}"]`)
    if (html) el.innerHTML = value
    else el.textContent = value
  }

  updatePlay(view: PlayView): void {
    this.view = view
    const { room, role, hud } = view
    const phase = room?.phase ?? 'lobby'
    const screen = this.q('[data-screen="play"]')
    screen.dataset.phase = view.status !== 'online' || !room ? 'connecting' : phase
    const seat = role === 'spectator' ? null : role
    const info = seat ? room?.seats[seat] : undefined

    this.set('code', view.code)
    this.set('invite', performance.now() < this.copiedUntil ? '已复制！' : '复制邀请链接')
    this.set('ping', view.ping >= 0 ? `${Math.round(view.ping)} ms` : '')
    this.q('.net').dataset.quality = view.ping < 0 ? 'none' : view.ping < 120 ? 'good' : view.ping < 250 ? 'ok' : 'bad'

    // Connection overlay.
    const connecting = view.status !== 'online' || !room
    this.q('.status-overlay').classList.toggle('is-active', connecting)
    this.set('status', view.status === 'reconnecting' ? '连接中断，正在重连…' : '正在进入房间…')
    this.set('status-sub', view.status === 'reconnecting' ? '你的座位会保留 30 秒，角色暂时原地不动' : '')
    if (!room) return

    // Timer and share bar.
    const timed = phase === 'live'
    this.set('timer', timed ? clock(hud.remainingMs) : '')
    const timer = this.q('.timer')
    timer.classList.toggle('is-active', timed)
    timer.classList.toggle('is-frenzy', hud.frenzy)
    timer.classList.toggle('is-final', timed && hud.remainingMs <= 10_000)
    this.set('timer-tag', hud.frenzy ? '狂热时间' : '')
    const showShares = (phase === 'live' || phase === 'results') && hud.shares.length > 0
    this.q('.sharebar').classList.toggle('is-active', showShares)
    if (showShares) {
      const total = hud.shares.reduce((n, s) => n + s.pct, 0)
      const bar = hud.shares.map(s => `<i class="seat-${s.seat}" style="flex-grow:${s.pct.toFixed(2)}"></i>`).join('') + `<i class="rest" style="flex-grow:${Math.max(0, 100 - total).toFixed(2)}"></i>`
      this.set('bar', bar, true)
      const chips = hud.shares.map(s => `<span class="chip seat-${s.seat}${s.seat === role ? ' is-mine' : ''}"><i></i>${esc(room.seats[s.seat]?.name ?? '')}<b>${pct(s.pct)}</b></span>`).join('')
      this.set('chips', chips, true)
    }

    // Countdown.
    const counting = phase === 'countdown'
    this.q('.countdown').classList.toggle('is-active', counting)
    if (counting) this.set('count', String(Math.max(1, Math.ceil((room.ends_at - Date.now() - 0) / 1000)) > 3 ? 3 : Math.max(1, Math.ceil(hud.remainingMs / 1000))))

    // Lobby panel.
    const lobby = phase === 'lobby' || phase === 'countdown'
    this.q('.lobby-panel').classList.toggle('is-active', lobby)
    if (lobby) this.renderLobby(room, role)

    // Results.
    const results = phase === 'results' && room.result
    this.q('.results-panel').classList.toggle('is-active', Boolean(results))
    if (results) this.renderResults(room, role)
    else this.resultsRound = -1

    // In-round extras.
    const live = phase === 'live'
    if (live && room.round !== this.roundSeen) {
      this.roundSeen = room.round
      this.roundAt = performance.now()
    }
    const benched = live && !hud.playing
    this.q('.spectate-tag').classList.toggle('is-active', benched)
    this.set('spectate', role === 'spectator' ? '观战中 · 本局结束后自动入座' : '本局进行中 · 下一局你将加入')
    const touch = this.input.method === 'touch' || document.body.classList.contains('has-touch')
    this.set('keys', touch ? '滑动屏幕转向 · 点一下冲刺' : '方向键 / WASD 转向 · 空格 冲刺')
    this.q('.hint-keys').classList.toggle('is-active', live && hud.playing && performance.now() - this.roundAt < 9000)
    const dash = this.q('.dash-meter')
    dash.classList.toggle('is-active', live && hud.playing)
    dash.style.setProperty('--ready', hud.dashReady.toFixed(3))
    dash.classList.toggle('is-ready', hud.dashReady >= 1)
    const touchDash = this.q('.touch-dash')
    touchDash.style.setProperty('--ready', hud.dashReady.toFixed(3))
    touchDash.classList.toggle('is-ready', hud.dashReady >= 1)
    document.body.classList.toggle('can-dash', live && hud.playing)
    screen.classList.toggle('is-stunned', live && hud.stunned)
    this.q('.stun-tag').classList.toggle('is-active', live && hud.stunned)
    void info
  }

  private renderLobby(room: RoomMsg, role: Role): void {
    const seated = SEATS.filter(s => room.seats[s])
    const mine = role === 'spectator' ? undefined : room.seats[role]
    const slots = SEATS.map(seat => {
      const s = room.seats[seat]
      if (!s) return `<li class="slot is-empty"><i class="dot"></i><span class="slot-name">空位</span><span class="slot-state">等待加入</span></li>`
      const state = !s.connected ? '重连中…' : s.ready ? '已准备' : '未准备'
      return `<li class="slot seat-${seat}${s.ready ? ' is-ready' : ''}${!s.connected ? ' is-away' : ''}${seat === role ? ' is-mine' : ''}"><i class="dot"></i>`
        + `<span class="slot-name">${room.host === seat ? `<em class="crown" title="房主">${ICON.crown}</em>` : ''}${esc(s.name)}${seat === role ? '<small>（你）</small>' : ''}</span>`
        + `<span class="slot-state">${state}${s.wins ? ` · 胜 ${s.wins}` : ''}</span></li>`
    }).join('')
    this.set('slots', slots, true)
    const connected = seated.filter(s => room.seats[s]!.connected)
    const ready = connected.filter(s => room.seats[s]!.ready).length
    let title = '等待玩家准备'
    let hint = ''
    if (room.phase === 'countdown') { title = '全员就绪，马上开始！'; hint = '取消准备可以中止倒计时' }
    else if (role === 'spectator') { title = '房间已满'; hint = `你正在观战，有空位时会自动入座（观众 ${room.spectators} 人）` }
    else if (connected.length < 2) { title = '等朋友加入'; hint = '还差 1 人 · 点上方「复制邀请链接」发给朋友' }
    else hint = `至少 2 人，全员准备后自动开始（已准备 ${ready}/${connected.length}）`
    this.set('lobby-title', title)
    this.set('lobby-hint', hint)
    const btn = this.q<HTMLButtonElement>('.ready-btn')
    btn.hidden = !mine
    if (mine) {
      btn.classList.toggle('is-on', mine.ready)
      this.set('ready', mine.ready ? '取消准备' : '准备！<kbd>空格</kbd>', true)
    }
    if (mine) this.set('my-color', `你是<b class="seat-text-${role}">${SEAT_COLOR_NAME[role as Seat]}</b>`, true)
    else this.set('my-color', '', true)
  }

  private renderResults(room: RoomMsg, role: Role): void {
    const result = room.result!
    const now = performance.now()
    if (this.resultsRound !== result.round) {
      this.resultsRound = result.round
      this.resultsAt = now
      this.revealed = false
      this.countTick = 0
      const rows = result.order.map((r, i) => `<li class="row seat-${r.seat}${r.seat === role ? ' is-mine' : ''}" style="--i:${i}">`
        + `<span class="rank">${i + 1}</span><span class="who"><i class="dot"></i>${esc(r.name)}${r.seat === role ? '<small>（你）</small>' : ''}</span>`
        + `<span class="meter"><i data-final="${((r.cells / result.playable) * 100).toFixed(2)}"></i></span>`
        + `<b class="pct" data-final="${((r.cells / result.playable) * 100).toFixed(2)}">0%</b>`
        + `<span class="stats">${r.cells} 格 · 撞晕 ${r.hits} 次 · 炸弹 ${r.bombs} 个</span></li>`).join('')
      this.q('.ranking').innerHTML = rows
      this.q('.results-panel').classList.remove('is-revealed')
      this.cache.delete('results-title')
    }
    const p = Math.min(1, (now - this.resultsAt) / 1600)
    const eased = 1 - Math.pow(1 - p, 3)
    for (const el of this.root.querySelectorAll<HTMLElement>('.ranking [data-final]')) {
      const final = Number(el.dataset.final)
      if (el.tagName === 'I') el.style.transform = `scaleX(${((final / 100) * eased * 1.6).toFixed(4)})`
      else el.textContent = pct(final * eased)
    }
    if (p < 1 && now - this.countTick > 90) {
      this.countTick = now
      this.audio.paint(Math.floor(p * 20))
    }
    if (p >= 1 && !this.revealed) {
      this.revealed = true
      this.q('.results-panel').classList.add('is-revealed')
      const mine = role !== 'spectator' && result.order.some(r => r.seat === role)
      if (mine) this.audio.play(result.winner === role ? 'win' : 'lose')
      else this.audio.play('win')
    }
    const winner = result.winner ? room.seats[result.winner]?.name ?? result.order[0]?.name ?? '' : ''
    const title = !this.revealed ? '统计中…' : !result.winner ? '平局！' : result.winner === role ? '你赢了！' : `${winner} 获胜！`
    this.set('results-title', title)
    const top = result.order
    let sub = '占地面积最多的人获胜'
    if (result.reason === 'forfeit') sub = '其他玩家离开了，本局提前结束'
    else if (top.length > 1 && top[0].cells === top[1].cells) sub = result.winner ? '面积相同！按撞晕次数、炸弹数决出胜负' : '面积、撞晕、炸弹全部相同'
    this.set('results-sub', sub)
    const series = SEATS.filter(s => room.seats[s]).map(s => `<span class="seat-text-${s}">${esc(room.seats[s]!.name)} <b>${room.seats[s]!.wins}</b></span>`).join('<i>:</i>')
    this.set('series', `房间比分 ${series}`, true)
    const mineSeat = role === 'spectator' ? undefined : room.seats[role]
    const btn = this.q<HTMLButtonElement>('.rematch-btn')
    btn.hidden = !mineSeat
    const connected = SEATS.filter(s => room.seats[s]?.connected)
    const ready = connected.filter(s => room.seats[s]!.ready).length
    if (mineSeat) {
      btn.classList.toggle('is-on', mineSeat.ready)
      this.set('rematch', mineSeat.ready ? `等待其他人（${ready}/${connected.length}）· 点击取消` : '再来一局！<kbd>空格</kbd>', true)
    }
    this.set('rematch-hint', connected.length < 2 ? '房间里只剩你了，邀请朋友回来再战' : mineSeat ? '所有人点「再来一局」后直接开始，比分累计' : '下一局你将自动入座')
  }

  // ─── settings ───────────────────────────────────────────────────────────

  refreshSettings(): void {
    const d = this.save.data
    this.q<HTMLInputElement>('[name="musicVolume"]').value = String(d.musicVolume)
    this.q<HTMLInputElement>('[name="sfxVolume"]').value = String(d.sfxVolume)
    for (const t of this.qa<HTMLButtonElement>('.toggle')) {
      const on = d[t.dataset.setting as 'muted' | 'reducedMotion'] === true
      t.setAttribute('aria-pressed', String(on))
      t.querySelector('span')!.textContent = on ? '开' : '关'
    }
    for (const b of this.qa<HTMLButtonElement>('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.value === d.quality))
    for (const r of this.qa<HTMLInputElement>('input[type="range"]')) r.style.setProperty('--fill', `${Number(r.value) * 100}%`)
  }

  // ─── events ─────────────────────────────────────────────────────────────

  private name(): string {
    const field = this.q<HTMLInputElement>('.name-input')
    const name = cleanName(field.value)
    field.value = name
    return name
  }

  private onClick(e: MouseEvent): void {
    this.audio.unlock()
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action], [data-notice], .toggle, .seg button')
    if (!target) return
    if (target.dataset.notice !== undefined) {
      this.audio.play('ui')
      this.notices[Number(target.dataset.notice)]?.run()
      return
    }
    if (target.matches('.toggle')) {
      const key = target.dataset.setting as 'muted' | 'reducedMotion'
      this.actions.settings({ [key]: !this.save.data[key] })
      this.refreshSettings()
      this.audio.play('ui')
      return
    }
    if (target.matches('.seg button')) {
      this.actions.settings({ quality: target.dataset.value as Quality })
      this.refreshSettings()
      this.audio.play('ui')
      return
    }
    this.audio.play('ui')
    switch (target.dataset.action) {
      case 'dice': {
        this.q<HTMLInputElement>('.name-input').value = ''
        this.actions.rename('')
        break
      }
      case 'create': this.actions.create(this.name()); break
      case 'join-invite': this.actions.join(this.q('.invite-code').textContent ?? '', this.name()); break
      case 'join': this.join(); break
      case 'ready': {
        const room = this.view?.room
        const role = this.view?.role
        const mine = role && role !== 'spectator' ? room?.seats[role] : undefined
        if (mine) this.actions.ready(!mine.ready)
        break
      }
      case 'rematch': {
        const role = this.view?.role
        const mine = role && role !== 'spectator' ? this.view?.room?.seats[role] : undefined
        if (mine) this.actions.ready(!mine.ready)
        break
      }
      case 'invite': this.actions.invite(); break
      case 'menu': this.push('menu'); break
      case 'close-menu': this.back(); break
      case 'leave': this.actions.leave(); break
      case 'settings': this.push('settings'); break
      case 'back': this.back(); break
      case 'retry-boot': this.actions.retryBoot(); break
    }
  }

  private join(): void {
    const field = this.q<HTMLInputElement>('.room-input')
    const room = cleanRoom(field.value)
    if (room.length !== ROOM_LENGTH) {
      field.classList.add('is-invalid')
      field.focus()
      this.audio.play('error')
      return
    }
    this.actions.join(room, this.name())
  }

  private onInput(e: Event): void {
    const el = e.target as HTMLInputElement
    if (el.matches('.room-input')) {
      el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_LENGTH)
      el.classList.remove('is-invalid')
      return
    }
    if (el.type !== 'range') return
    el.style.setProperty('--fill', `${Number(el.value) * 100}%`)
    this.actions.settings({ [el.name]: Number(el.value) } as Partial<SaveData>)
  }

  private onKey(e: KeyboardEvent): void {
    const typing = (e.target as HTMLElement).matches?.('input[type="text"]')
    if (this.screen === 'home' && e.code === 'Enter' && typing) {
      e.preventDefault()
      if ((e.target as HTMLElement).matches('.room-input')) this.join()
      else if (!this.q('.invite-card').hidden) this.actions.join(this.q('.invite-code').textContent ?? '', this.name())
      else this.actions.create(this.name())
      return
    }
    if (e.code === 'Escape') {
      if (this.screen === 'play') { this.push('menu'); e.preventDefault() }
      else if (this.screen === 'menu' || this.screen === 'settings') { this.back(); e.preventDefault() }
      return
    }
    if (this.screen !== 'play' || typing || e.repeat) return
    const room = this.view?.room
    const role = this.view?.role
    if (!room || !role || role === 'spectator') return
    const mine = room.seats[role]
    if (!mine) return
    if ((e.code === 'Space' || e.code === 'Enter') && !mine.ready) {
      // Ready is idempotent ("set ready"); cancelling needs the button, so mashing is harmless.
      if (room.phase === 'lobby') this.actions.ready(true)
      if (room.phase === 'results' && performance.now() - this.resultsAt > 1800) this.actions.ready(true)
    }
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector<T>(sel)!
  }

  private qa<T extends HTMLElement = HTMLElement>(sel: string): T[] {
    return [...this.root.querySelectorAll<T>(sel)]
  }

  private template(): string {
    const seatVars = SEATS.map(s => `--${s}:${SEAT_CSS[s]}`).join(';')
    return `
<div class="ui-root" style="${seatVars}">
  <section class="screen boot is-active" data-screen="boot">
    <div class="boot-card">
      <img class="boot-icon" src="./loader-icon.png" alt="" onerror="this.style.visibility='hidden'" />
      <h1 class="logo">${TITLE_HTML}</h1>
      <div class="boot-bar"><i></i></div>
      <p class="boot-status">正在加载…</p>
      <button class="btn boot-retry" data-action="retry-boot" hidden>重试</button>
    </div>
  </section>

  <section class="screen home" data-screen="home">
    <div class="home-card">
      <h1 class="logo big">${TITLE_HTML}</h1>
      <p class="tagline">和朋友实时联机 · 90 秒把地图涂成你的颜色</p>
      <label class="field"><span>你的昵称</span>
        <div class="name-row"><input class="name-input" type="text" maxlength="8" autocomplete="off" spellcheck="false" /><button class="icon-btn" data-action="dice" title="换一个随机昵称" aria-label="随机昵称">${ICON.dice}</button></div>
      </label>
      <div class="invite-card" hidden>
        <p>朋友邀请你加入房间 <b class="invite-code"></b></p>
        <button class="btn primary big" data-action="join-invite">加入房间</button>
      </div>
      <div class="home-actions">
        <button class="btn primary big" data-action="create">创建房间</button>
        <div class="join-row"><input class="room-input" type="text" maxlength="4" placeholder="输入 4 位房间码" autocomplete="off" spellcheck="false" /><button class="btn" data-action="join">加入</button></div>
      </div>
      <ul class="rules">
        <li><b>涂色</b>方向键 / WASD 转向，走过的格子变成你的颜色，也能覆盖别人的</li>
        <li><b>冲刺</b>空格冲刺，撞到对手让他眩晕 1 秒</li>
        <li><b>道具</b>吃颜料炸弹炸开 3×3；最后 15 秒狂热时间，更快更大</li>
      </ul>
      <button class="link" data-action="settings">${ICON.gear}设置</button>
    </div>
  </section>

  <section class="screen notice" data-screen="notice">
    <div class="card">
      <h2 class="notice-title"></h2>
      <p class="notice-text"></p>
      <div class="notice-actions"></div>
    </div>
  </section>

  <section class="screen play" data-screen="play" data-phase="connecting">
    <div class="labels"></div>
    <header class="topbar">
      <div class="room-chip"><span>房间</span><b data-k="code"></b><button class="btn small" data-action="invite">${ICON.link}<span data-k="invite">复制邀请链接</span></button></div>
      <div class="timer"><span data-k="timer"></span><small data-k="timer-tag"></small></div>
      <div class="top-right"><span class="net"><i></i><span data-k="ping"></span></span><button class="icon-btn" data-action="menu" aria-label="菜单">${ICON.menu}</button></div>
    </header>
    <div class="sharebar"><div class="bar" data-k="bar"></div><div class="chips" data-k="chips"></div></div>
    <div class="toasts"></div>
    <div class="banner"><b></b></div>
    <div class="countdown"><b data-k="count"></b><small>准备开涂</small></div>
    <div class="stun-tag">眩晕中！</div>

    <div class="lobby-panel">
      <h2 data-k="lobby-title"></h2>
      <p class="my-color" data-k="my-color"></p>
      <ul class="slots" data-k="slots"></ul>
      <div class="lobby-actions">
        <button class="btn primary big ready-btn" data-action="ready"><span data-k="ready"></span></button>
        <button class="btn lobby-leave" data-action="leave">离开房间</button>
      </div>
      <p class="lobby-hint" data-k="lobby-hint"></p>
    </div>

    <div class="results-panel">
      <h2 data-k="results-title"></h2>
      <p class="results-sub" data-k="results-sub"></p>
      <ol class="ranking"></ol>
      <p class="series" data-k="series"></p>
      <div class="results-actions">
        <button class="btn primary big rematch-btn" data-action="rematch"><span data-k="rematch"></span></button>
        <button class="btn" data-action="leave">离开房间</button>
      </div>
      <p class="rematch-hint" data-k="rematch-hint"></p>
    </div>

    <div class="spectate-tag" data-k="spectate"></div>
    <div class="hint-keys" data-k="keys"></div>
    <div class="dash-meter"><i></i><span>冲刺</span><kbd>空格</kbd></div>
    <div class="status-overlay"><div class="spinner"></div><p data-k="status"></p><small data-k="status-sub"></small></div>
  </section>

  <section class="screen menu" data-screen="menu">
    <div class="card">
      <h2>菜单</h2>
      <p class="muted">对局不会暂停，服务器继续计时</p>
      <button class="btn primary" data-action="close-menu">继续游戏</button>
      <button class="btn" data-action="invite">复制邀请链接</button>
      <button class="btn" data-action="settings">设置</button>
      <button class="btn danger" data-action="leave">离开房间</button>
    </div>
  </section>

  <section class="screen settings" data-screen="settings">
    <div class="card">
      <h2>设置</h2>
      <label class="setting"><span>音乐音量</span><input type="range" name="musicVolume" min="0" max="1" step="0.05" /></label>
      <label class="setting"><span>音效音量</span><input type="range" name="sfxVolume" min="0" max="1" step="0.05" /></label>
      <div class="setting"><span>静音</span><button class="toggle" data-setting="muted"><span>关</span></button></div>
      <div class="setting"><span>画质</span><div class="seg"><button data-value="low">流畅</button><button data-value="medium">均衡</button><button data-value="high">精美</button></div></div>
      <div class="setting"><span>减少特效</span><button class="toggle" data-setting="reducedMotion"><span>关</span></button></div>
      <button class="btn primary" data-action="back">返回</button>
    </div>
  </section>

  <div class="touch"><div class="touch-dot"></div><button class="touch-dash" aria-label="冲刺"><i></i><span>冲刺</span></button></div>
</div>`
  }
}
