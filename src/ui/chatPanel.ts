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
      <button class="btn small chat-toggle" type="button" data-chat="toggle">聊天<b class="chat-badge" hidden></b></button>
      <section class="chat-panel" hidden aria-label="房间聊天">
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
    // Keep chat typing away from game shortcuts (Space = ready, Escape = menu).
    this.root.addEventListener('keydown', e => { if (e.code !== 'Escape') e.stopPropagation() })
  }

  render(): void {
    const enabled = this.chat.enabled
    this.root.hidden = !enabled
    if (!enabled) return
    const badge = this.q('.chat-badge')
    badge.hidden = this.open || this.chat.unread === 0
    badge.textContent = String(Math.min(99, this.chat.unread))
    if (this.open) this.chat.markRead()
    const mic = this.q<HTMLButtonElement>('.chat-mic')
    mic.textContent = this.chat.micOn ? '关闭语音' : '开启语音'
    mic.classList.toggle('is-on', this.chat.micOn)
    const err = this.q('.chat-error')
    err.hidden = !this.chat.micError
    err.textContent = this.chat.micError

    const views = this.chat.views()
    const key = JSON.stringify([views, this.chat.lines.length, this.chat.lines.at(-1)?.id])
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
        : v.status === 'failed' ? '直连失败，未加密的内容不会发送（重试中）'
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
    const sendable = views.some(v => v.status === 'secure')
    this.q<HTMLInputElement>('.chat-input').placeholder = sendable ? '输入消息，回车发送' : '还没有已加密的连接，暂时不能发送'
  }

  private onClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-chat]')
    if (!target) return
    e.stopPropagation()
    switch (target.dataset.chat) {
      case 'toggle':
        this.open = !this.open
        this.q('.chat-panel').hidden = !this.open
        if (this.open) this.q<HTMLInputElement>('.chat-input').focus({ preventScroll: true })
        break
      case 'mic':
        void this.chat.setMic(!this.chat.micOn)
        break
      case 'verify':
        this.chat.verify(target.dataset.seat as Seat)
        break
    }
    this.render()
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector<T>(sel)!
  }
}
