import type { SecureChat } from '../net/secureChat'
import { MAX_TEXT } from '../net/secureChat'
import type { Seat } from '../../shared/rules.ts'

/**
 * Room chat panel. Every value from peers is set with textContent (never innerHTML), and nothing
 * is written to storage, notifications or the console.
 */
export class ChatPanel {
  private readonly root: HTMLElement
  private open = false
  private rendered = ''

  constructor(host: HTMLElement, private readonly chat: SecureChat) {
    this.root = document.createElement('div')
    this.root.className = 'chat-dock'
    this.root.innerHTML = `
      <button class="btn small chat-toggle" type="button" data-chat="toggle" aria-controls="room-chat-panel" aria-expanded="false">聊天<b class="chat-badge" hidden></b></button>
      <section class="chat-panel" id="room-chat-panel" hidden aria-label="房间聊天">
        <header class="chat-head">
          <strong>房间聊天</strong>
          <button class="btn small chat-mic" type="button" data-chat="mic">开启语音</button>
        </header>
        <p class="chat-note">文字与语音点对点加密传输，游戏服务器只转发连接信息，读不到内容。请与队友当面或用其他方式核对安全码。</p>
        <ul class="chat-peers"></ul>
        <p class="chat-error" hidden></p>
        <ol class="chat-log" aria-live="polite"></ol>
        <form class="chat-form">
          <input class="chat-input" type="text" maxlength="${MAX_TEXT}" autocomplete="off" spellcheck="false" placeholder="输入消息，回车发送" />
          <button class="btn primary small" type="submit">发送</button>
        </form>
      </section>`
    host.appendChild(this.root)
    this.root.addEventListener('click', e => this.onClick(e))
    this.q<HTMLFormElement>('.chat-form').addEventListener('submit', e => {
      e.preventDefault()
      const input = this.q<HTMLInputElement>('.chat-input')
      if (this.chat.send(input.value)) input.value = ''
    })
    // Chat owns its keyboard focus. In particular, Escape closes chat instead of opening game menu.
    this.root.addEventListener('keydown', e => {
      if (e.code === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (this.open) {
          this.setOpen(false)
          this.render()
        }
        return
      }
      e.stopPropagation()
    })
  }

  render(): void {
    const enabled = this.chat.enabled
    this.root.hidden = !enabled
    if (!enabled) {
      this.open = false
      this.q('.chat-panel').hidden = true
      this.q('.chat-toggle').setAttribute('aria-expanded', 'false')
      this.rendered = ''
      return
    }
    const badge = this.q('.chat-badge')
    badge.hidden = this.open || this.chat.unread === 0
    badge.textContent = String(Math.min(99, this.chat.unread))
    if (this.open) this.chat.markRead()
    const views = this.chat.views()
    const verified = views.some(view => view.verified)
    const changed = views.some(view => view.changed)
    const mic = this.q<HTMLButtonElement>('.chat-mic')
    mic.textContent = this.chat.micPending ? '授权中…'
      : this.chat.micOn ? '关闭语音'
      : verified ? '开启语音' : '核对后开启语音'
    mic.disabled = this.chat.micPending || (!this.chat.micOn && !verified)
    mic.setAttribute('aria-pressed', String(this.chat.micOn))
    mic.classList.toggle('is-on', this.chat.micOn && !this.chat.micPending)
    const note = this.q('.chat-note')
    note.textContent = this.chat.micPending
      ? '正在等待麦克风授权。授权后，语音只会发送给已核对安全码的队友。'
      : this.chat.micOn
        ? '语音只发送给已核对安全码的队友；安全码变化会立即停止发送。'
        : changed && !verified
          ? '安全码已变化，文字与语音已暂停。请重新核对安全码。'
          : verified
            ? '文字已加密；语音已解锁，可开启麦克风。'
            : '文字通过加密连接传输。语音需你和队友核对安全码后开启。'
    const err = this.q('.chat-error')
    err.hidden = !this.chat.micError
    err.textContent = this.chat.micError

    const key = JSON.stringify([
      views,
      this.chat.lines.length,
      this.chat.lines.at(-1)?.id,
      this.chat.micOn,
      this.chat.micPending,
    ])
    if (key === this.rendered) return
    this.rendered = key

    const peers = this.q('.chat-peers')
    peers.replaceChildren(...(views.length ? views.map(v => {
      const li = document.createElement('li')
      li.className = `chat-peer seat-${v.seat} is-${v.verified ? 'verified' : v.status}${v.changed ? ' is-changed' : ''}`
      const name = document.createElement('span')
      name.className = 'chat-peer-name'
      name.textContent = v.name + (v.voice ? ' · 已开麦' : '')
      const state = document.createElement('span')
      state.className = 'chat-peer-state'
      state.textContent = v.status === 'connecting' ? '正在建立加密连接…'
        : v.status === 'failed' ? '连接失败，正在自动重试'
        : v.verified ? '已核对 · 端到端加密'
        : v.changed ? '安全码已变化，请重新核对' : '已加密 · 未核对身份'
      li.append(name, state)
      if (v.status === 'secure') {
        const code = document.createElement('code')
        code.className = 'chat-code'
        code.textContent = v.code
        li.append(code)
        if (!v.verified) {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'btn small'
          btn.dataset.chat = 'verify'
          btn.dataset.seat = v.seat
          btn.textContent = '双方一致，标记已核对'
          li.append(btn)
        }
      }
      return li
    }) : [Object.assign(document.createElement('li'), { className: 'chat-empty', textContent: '等待队友加入后自动建立连接' })]))

    const log = this.q('.chat-log')
    log.replaceChildren(...this.chat.lines.map(line => {
      const li = document.createElement('li')
      li.className = line.seat === 'system' ? 'chat-line is-system' : `chat-line ${line.seat === 'me' ? 'is-me' : `seat-${line.seat}`}`
      if (line.seat !== 'system') {
        const who = document.createElement('b')
        who.textContent = line.name
        li.append(who)
      }
      li.append(document.createTextNode(line.text))
      return li
    }))
    log.scrollTop = log.scrollHeight
    const sendable = views.some(v => v.status === 'secure' && !v.changed)
    const input = this.q<HTMLInputElement>('.chat-input')
    input.disabled = !sendable
    this.q<HTMLButtonElement>('.chat-form button').disabled = !sendable
    input.placeholder = sendable
      ? '输入消息，回车发送'
      : changed ? '安全码已变化，重新核对后可发送' : '还没有已加密的连接，暂时不能发送'
  }

  private onClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-chat]')
    if (!target) return
    e.stopPropagation()
    switch (target.dataset.chat) {
      case 'toggle':
        this.setOpen(!this.open)
        break
      case 'mic':
        if (!target.hasAttribute('disabled')) void this.chat.setMic(!this.chat.micOn)
        break
      case 'verify':
        this.chat.verify(target.dataset.seat as Seat)
        break
    }
    this.render()
  }

  private setOpen(open: boolean): void {
    this.open = open
    this.q('.chat-panel').hidden = !open
    this.q('.chat-toggle').setAttribute('aria-expanded', String(open))
    if (open) this.q<HTMLInputElement>('.chat-input').focus({ preventScroll: true })
    else this.q<HTMLButtonElement>('.chat-toggle').focus({ preventScroll: true })
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector<T>(sel)!
  }
}
