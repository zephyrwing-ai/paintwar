import './styles/main.css'
import { Audio } from './engine/audio'
import { Input } from './engine/input'
import { GameLoop } from './engine/loop'
import { SAVE_KEY, SaveStore, type SaveData } from './engine/save'
import type { Game } from './game/game'
import { CLOSE, type ErrorCode, type Role, type RoomMsg } from '../shared/protocol.ts'
import { ServerClock, clientNow } from './net/clock'
import { bootstrapUrl, Connection } from './net/connection'
import { BUILD, decode, parseEnvelope } from './net/protocol'
import { invitedRoom, inviteUrl, loadName, loadResume, newRoomCode, randomName, socketUrl, storeName, storeResume, writeRoom } from './net/session'
import { TouchControls } from './ui/touch'
import { Ui, type NetStatus } from './ui/ui'

const PING_INTERVAL_MS = 1000

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!
  const firstRun = safeGet(SAVE_KEY) === null
  const save = new SaveStore()
  const input = new Input(canvas)
  const audio = new Audio()
  const clock = new ServerClock()
  let game: Game | undefined

  // Session state for the current room.
  let code = ''
  let create = false
  let createAttempts = 0
  let name = loadName()
  let role: Role = 'spectator'
  let room: RoomMsg | null = null
  let status: NetStatus = 'connecting'
  let active = false
  let welcomed = false
  let lastSeq = -1
  let lastPingAt = 0

  const applySettings = (d: SaveData) => {
    audio.setVolumes(d.musicVolume, d.sfxVolume, d.muted)
    game?.setReducedMotion(d.reducedMotion)
  }

  const send = (message: Record<string, unknown>) => {
    if (welcomed) connection.send(JSON.stringify(message))
  }

  const goHome = (invite = '') => {
    connection.stop()
    active = false
    welcomed = false
    room = null
    writeRoom(invite)
    ui.home(name, invite)
    audio.setMusic('lobby')
  }

  const fail = (title: string, text: string, offerCreate = true) => {
    connection.stop()
    active = false
    welcomed = false
    writeRoom('')
    ui.notice(title, text, [
      ...(offerCreate ? [{ label: '新建一个房间', primary: true, run: () => enter('', true) }] : []),
      { label: '回到首页', primary: !offerCreate, run: () => goHome() },
    ])
  }

  const onError = (code: ErrorCode) => {
    if (code === 'room_exists' && create && createAttempts < 4) {
      // Room code collision: pick another one and try again.
      enter('', true)
      return
    }
    if (code === 'room_not_found') fail('房间不存在或已关闭', '这个房间可能已经解散，或者服务器刚刚重启清空了房间。你可以新建一个房间，再把邀请链接发给朋友。')
    else if (code === 'room_full') fail('房间人数已满', '这个房间的玩家和观众都满了，换个房间或新建一个吧。')
    else if (code === 'server_full') fail('服务器繁忙', '现在开着的房间太多了，请稍后再试。', false)
    else fail('连接出错', '和服务器的通信出现问题，请重新进入。')
  }

  const connection = new Connection({
    state: state => {
      if (state === 'unavailable') {
        ui.notice('联机服务暂时不可用', '没能连上游戏服务器。可能是服务器正在启动或网络不稳定，请稍后重试。', [
          { label: '重试', primary: true, run: () => enter(code, create) },
          { label: '回到首页', run: () => goHome() },
        ])
        active = false
      }
    },
    text: text => receive(text),
    lost: closeCode => {
      welcomed = false
      if (closeCode === CLOSE.replaced) {
        connection.stop()
        ui.notice('已在其他标签页打开', '你在另一个标签页重新进入了这个房间，这里的连接已经断开。', [{ label: '回到首页', primary: true, run: () => goHome() }])
        active = false
        return
      }
      if (closeCode === CLOSE.left) return
      if (closeCode === CLOSE.notFound) { onError('room_not_found'); return }
      if (closeCode === CLOSE.full) { onError('room_full'); return }
      if (closeCode === CLOSE.exists) { onError('room_exists'); return }
      // Anything else: keep the seat and retry with the resume token.
      status = 'reconnecting'
      game?.resetConnection()
    },
  })

  const receive = (text: string) => {
    const g = game
    if (!g) return
    const envelope = parseEnvelope(text)
    if (envelope && typeof envelope.marker === 'string' && envelope.marker !== BUILD) {
      connection.stop()
      ui.notice('游戏有新版本', '服务器已经更新，刷新页面就能继续玩。', [{ label: '刷新页面', primary: true, run: () => location.reload() }])
      active = false
      return
    }
    const message = decode(text, code, lastSeq)
    if (!message) return
    if (message.type === 'error') {
      onError(message.code)
      return
    }
    connection.confirmActivity()
    switch (message.type) {
      case 'welcome': {
        welcomed = true
        lastSeq = -1
        lastPingAt = 0
        clock.seed(message.now)
        create = false
        role = message.role
        name = message.name || name
        storeName(name)
        storeResume(code, connection.endpoint, message.resume_token)
        g.setRole(role)
        status = 'online'
        break
      }
      case 'room':
        if (!welcomed) return
        lastSeq = message.seq
        room = message
        g.onRoom(message)
        break
      case 'snap':
        if (!welcomed) return
        lastSeq = message.seq
        g.onSnap(message)
        break
      case 'pong':
        clock.sample(message.t, message.s)
        break
    }
  }

  /** Create (`requested` = '') or join a room. Updates the URL so a refresh rejoins the seat. */
  const enter = (requested: string, asCreate: boolean) => {
    audio.unlock()
    if (asCreate) createAttempts += 1
    else createAttempts = 0
    code = requested || newRoomCode()
    create = asCreate
    writeRoom(code)
    welcomed = false
    lastSeq = -1
    room = null
    role = 'spectator'
    status = 'connecting'
    clock.reset()
    active = true
    game?.setRole('spectator')
    ui.show('play')
    connection.discover(bootstrapUrl(location.href), BUILD, endpoint => socketUrl(endpoint, code, create, name, loadResume(code, endpoint)))
  }

  const ui = new Ui(save, audio, input, {
    create: n => { name = n || name; storeName(name); createAttempts = 0; enter('', true) },
    join: (r, n) => { name = n || name; storeName(name); enter(r, false) },
    ready: ready => {
      send({ type: 'ready', ready })
    },
    leave: () => {
      send({ type: 'leave' })
      storeResume(code, connection.endpoint, '')
      audio.play('leave')
      goHome()
    },
    invite: () => {
      const url = inviteUrl(code)
      const fallback = () => window.prompt('复制这个链接发给朋友：', url)
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => ui.copied(), fallback)
      else fallback()
    },
    settings: patch => {
      const qualityChanged = patch.quality !== undefined && patch.quality !== save.data.quality
      save.update(patch)
      applySettings(save.data)
      if (qualityChanged) renderer?.applyQuality(save.data.quality)
    },
    retryBoot: () => location.reload(),
    rename: () => {
      name = randomName()
      ui.home(name, invitedRoom())
    },
  })
  ui.show('boot')
  applySettings(save.data)

  // Boot: the loader is on screen; three.js, the game code and the three models load behind it.
  let renderer: import('./engine/renderer').Renderer | undefined
  ui.setBootProgress(0.05)
  let models
  let modules
  try {
    const [{ Assets }, { MODEL_URLS }] = await Promise.all([import('./engine/assets'), import('./game/models')])
    const assets = new Assets()
    const urls = [MODEL_URLS.painter, MODEL_URLS.bomb, MODEL_URLS.crate]
    const progress = new Map<string, number>()
    const report = () => ui.setBootProgress(0.1 + ([...progress.values()].reduce((a, b) => a + b, 0) / urls.length) * 0.85)
    const fetchModel = (url: string) => assets.gltfWithProgress(url, p => { progress.set(url, p); report() })
    const [game_, renderer_, painter, bomb, crate] = await Promise.all([
      import('./game/game'), import('./engine/renderer'), fetchModel(urls[0]), fetchModel(urls[1]), fetchModel(urls[2]),
    ])
    modules = { game: game_, renderer: renderer_ }
    models = { painter, bomb, crate }
  } catch (err) {
    console.error(err)
    ui.bootFailed()
    return
  }
  if (firstRun) save.update({ quality: modules.renderer.suggestQuality() })
  ui.refreshSettings()
  renderer = new modules.renderer.Renderer(canvas, save.data.quality)
  game = new modules.game.Game(renderer, audio, input, clock, models, ui.labelLayer, {
    send,
    toast: (text, tone) => ui.toast(text, tone),
    banner: (text, tone) => ui.banner(text, tone),
  })
  applySettings(save.data)
  if (import.meta.env.DEV) {
    const [{ registerGameTuning }, { tuning }] = await Promise.all([import('../scripts/manus-tuning/adapter.js'), import('./game/tuning')])
    await registerGameTuning(tuning)
  }
  const g = game
  ui.setBootProgress(1, '准备就绪')

  const loop = new GameLoop({
    step: () => {},
    render: (_alpha, frameSeconds) => {
      input.update()
      connection.poll(frameSeconds)
      const nowMs = performance.now()
      if (welcomed && nowMs - lastPingAt >= PING_INTERVAL_MS) {
        if (connection.send(JSON.stringify({ type: 'ping', t: Math.floor(clientNow()) }))) lastPingAt = nowMs
      }
      // Menus over the play screen keep the round running but release the controls.
      if (ui.screen !== 'play') for (const a of ['up', 'down', 'left', 'right', 'dash'] as const) input.consume(a)
      g.frame(Math.min(frameSeconds, 0.1))
      if (active) ui.updatePlay({ room, code, role, status, hud: g.hud(), ping: clock.rtt })
      input.endFrame()
    },
  })
  loop.start()

  new TouchControls(document.getElementById('ui')!, input, () => active && ui.screen === 'play')
  window.addEventListener('pointerdown', () => audio.unlock(), { capture: true })
  window.addEventListener('keydown', () => audio.unlock(), { capture: true })

  // A refresh inside a room (resume token in this tab) goes straight back to the seat; an
  // invitation link shows the home screen with the room filled in so the nickname can be confirmed.
  const invited = invitedRoom()
  window.setTimeout(() => {
    if (invited && hasResume(invited)) enter(invited, false)
    else ui.home(name, invited)
  }, 200)

  // Debug/test hook (read-only use): smoke tests inspect state through it.
  ;(window as unknown as { __game: unknown }).__game = { game: g, ui, input, save, connection, clock, state: () => ({ room, role, status, code, welcomed }) }
}

function hasResume(room: string): boolean {
  try {
    return sessionStorage.getItem(`paintwar_resume_${room}`) !== null
  } catch {
    return false
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

boot().catch(err => {
  console.error(err)
  const el = document.getElementById('ui')
  if (el) el.innerHTML = `<div class="fatal">启动失败：${String((err as Error)?.message ?? err).replace(/[<>&]/g, '')}</div>`
})
