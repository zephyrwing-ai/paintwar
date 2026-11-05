// End-to-end smoke test for the published client and the Node server.
// Run `pnpm build` first, then `pnpm smoke`. Screenshots are written to ./shots/.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { chromium } from 'playwright'

const out = process.env.SHOTS_DIR ?? 'shots'
const latency = Number(process.env.SMOKE_LATENCY_MS ?? 0)
mkdirSync(out, { recursive: true })
if (!existsSync('dist/index.html')) throw new Error('smoke: run `pnpm build` first')
if (!existsSync('server/node_modules/ws')) throw new Error('smoke: run `pnpm --dir server install` first')

const site = mkdtempSync(join(tmpdir(), 'paintwar-smoke-'))
cpSync('dist', site, { recursive: true })
const server = spawn(process.execPath, ['server/server.ts'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', STATIC_ROOT: site, ALLOWED_ORIGINS: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
})
let proxy
let browser
const guard = setTimeout(() => fail('timed out'), 240_000)

function cleanup() {
  clearTimeout(guard)
  try { server.kill('SIGTERM') } catch {}
  proxy?.close()
  rmSync(site, { recursive: true, force: true })
}

async function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`)
  await browser?.close().catch(() => {})
  cleanup()
  process.exit(1)
}

function serverPort() {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: server.stdout })
    lines.once('line', line => {
      try { resolve(JSON.parse(line).port) } catch (err) { reject(err) }
    })
    server.once('exit', code => reject(new Error(`server exited (${code})`)))
  })
}

function delayProxy(target, ms) {
  return new Promise(resolve => {
    proxy = createServer(client => {
      const upstream = connect(target, '127.0.0.1')
      const pipe = (from, to) => from.on('data', chunk => setTimeout(() => to.writable && to.write(chunk), ms))
      pipe(client, upstream)
      pipe(upstream, client)
      const close = () => { client.destroy(); upstream.destroy() }
      client.on('close', close).on('error', close)
      upstream.on('close', close).on('error', close)
    })
    proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port))
  })
}

async function openGame(context, url, errors) {
  const page = await context.newPage()
  page.on('console', m => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', e => errors.push(String(e)))
  page.on('response', r => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`))
  await page.goto(url)
  await page.waitForSelector('[data-screen="home"].is-active', { timeout: 60_000 })
  await page.evaluate(async () => {
    await document.fonts.ready
    const family = getComputedStyle(document.querySelector('.logo')).fontFamily
    if (!family.includes('ManusCC0')) throw new Error(`Unexpected game font: ${family}`)
  })
  await page.waitForTimeout(250)
  return page
}

const state = page => page.evaluate(() => window.__game.state())

async function waitFor(page, predicate, label, timeout = 20_000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await state(page)
    if (predicate(last)) return last
    await page.waitForTimeout(100)
  }
  throw new Error(`${label} (last ${JSON.stringify(last)})`)
}

try {
  const port = await serverPort()
  const pagePort = latency > 0 ? await delayProxy(port, latency) : port
  writeFileSync(join(site, 'multiplayer', 'bootstrap.json'), JSON.stringify({
    version: 1, build: 'paint-war-v1', signalingUrl: '/ws',
  }))
  const base = `http://127.0.0.1:${pagePort}/`
  const args = [
    '--ignore-gpu-blocklist',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ]
  browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: 'chrome' }))
  const errors = []

  const one = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN', permissions: ['microphone'] })
  const p1 = await openGame(one, base, errors)
  await p1.screenshot({ path: `${out}/01-home.png` })
  await p1.click('[data-action="create"]')
  const first = await waitFor(p1, s => s.role === 'p1' && s.room?.phase === 'lobby', 'first player did not enter the lobby')
  const room = first.code
  if (!room || room.length !== 4) throw new Error(`unexpected room code ${room}`)
  await p1.screenshot({ path: `${out}/02-lobby.png` })

  const two = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN', permissions: ['microphone'] })
  const p2 = await openGame(two, `${base}?room=${room}`, errors)
  await p2.click('[data-action="join-invite"]')
  await waitFor(p2, s => s.role === 'p2', 'second player did not get p2')
  await waitFor(p1, s => s.room?.seats.p2?.connected === true, 'p2 did not appear in the room')

  if (process.env.SMOKE_SKIP_CHAT !== '1') {
    await p1.click('.chat-toggle')
    await p2.click('.chat-toggle')
    await p1.waitForSelector('.chat-peer .chat-code', { timeout: 15_000 })
    await p2.waitForSelector('.chat-peer .chat-code', { timeout: 15_000 })
    const p1Code = await p1.locator('.chat-code').textContent()
    const p2Code = await p2.locator('.chat-code').textContent()
    if (!p1Code || p1Code !== p2Code) throw new Error(`safety codes differ: ${p1Code} / ${p2Code}`)
    if (!(await p1.locator('.chat-mic').isDisabled())) throw new Error('voice was enabled before verification')
    await p1.click('.chat-peer [data-chat="verify"]')
    await p2.click('.chat-peer [data-chat="verify"]')
    if (await p1.locator('.chat-mic').isDisabled()) throw new Error('voice stayed locked after verification')
    await p1.click('.chat-mic')
    await p2.click('.chat-mic')
    for (const page of [p1, p2]) {
      await page.waitForFunction(async () => {
        const peers = await window.__game.chat.diagnostics()
        return peers.some(peer => peer.outboundTrack && peer.inboundAudio && peer.bytesSent > 0 && peer.bytesReceived > 0)
      }, null, { timeout: 10_000 })
    }
    await p1.fill('.chat-input', 'paintwar-smoke')
    await p1.click('.chat-form button')
    await p2.waitForFunction(() => document.querySelector('.chat-log')?.textContent?.includes('paintwar-smoke'), null, { timeout: 5000 })
    await p1.screenshot({ path: `${out}/02b-secure-chat.png` })

    if (process.env.SMOKE_SKIP_ROTATION !== '1') {
      // A refreshed peer gets a new ephemeral certificate. Existing trust must drop and voice must stop.
      await p2.reload()
      await p2.waitForSelector('[data-screen="play"].is-active', { timeout: 30_000 })
      await waitFor(p2, s => s.role === 'p2' && s.room?.phase === 'lobby', 'refreshed peer did not resume its seat', 20_000)
      await p1.waitForSelector('.chat-peer.is-changed', { timeout: 60_000 })
      await p1.waitForFunction(() => {
        const mic = document.querySelector('.chat-mic')
        const input = document.querySelector('.chat-input')
        return mic?.textContent?.includes('核对') &&
          mic.hasAttribute('disabled') &&
          input?.hasAttribute('disabled')
      }, null, { timeout: 20_000 })
      await p1.waitForFunction(async () => {
        const peer = (await window.__game.chat.diagnostics()).find(value => value.seat === 'p2')
        return Boolean(peer?.changed && !peer.micOn && !peer.outboundTrack && !peer.inboundAudio)
      }, null, { timeout: 20_000 })
      const changedPeer = await p1.evaluate(async () =>
        (await window.__game.chat.diagnostics()).find(peer => peer.seat === 'p2') ?? null)
      if (!changedPeer?.changed || changedPeer.micOn || changedPeer.outboundTrack || changedPeer.inboundAudio) {
        throw new Error(`voice transport survived safety-code change: ${JSON.stringify(changedPeer)}`)
      }
      await p1.screenshot({ path: `${out}/02c-safety-code-changed.png` })
    }

    await p1.click('.chat-toggle')
    await p2.click('.chat-toggle')
  }

  await p1.click('[data-action="ready"]')
  await p2.click('[data-action="ready"]')
  await waitFor(p1, s => s.room?.phase === 'live', 'round did not start', 10_000)
  await p1.waitForTimeout(500)
  await p1.screenshot({ path: `${out}/03-live-p1.png` })
  if (!(await p1.isVisible('.chat-toggle'))) throw new Error('chat capability was not advertised')

  await p1.keyboard.down('KeyW')
  await p1.waitForTimeout(1200)
  await p1.keyboard.up('KeyW')
  await p1.waitForFunction(() => window.__game.game.hud().shares.some(s => s.seat === 'p1' && s.cells > 0), null, { timeout: 5000 })
  await p1.waitForTimeout(250)
  await p1.screenshot({ path: `${out}/04-painted.png` })

  const three = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN' })
  const p3 = await openGame(three, `${base}?room=${room}`, errors)
  await p3.click('[data-action="join-invite"]')
  await waitFor(p3, s => s.role === 'p3', 'third player did not get p3')
  await waitFor(p1, s => s.room?.seats.p3?.connected === true, 'p3 did not appear in the room')
  await p3.screenshot({ path: `${out}/05-waiting-next-round.png` })

  await p1.click('[data-action="menu"]')
  await p1.waitForSelector('[data-screen="menu"].is-active')
  await p1.screenshot({ path: `${out}/06-menu.png` })
  await p1.click('section[data-screen="menu"] [data-action="settings"]')
  await p1.waitForSelector('[data-screen="settings"].is-active')
  await p1.keyboard.press('KeyP')
  await p1.waitForTimeout(200)
  if (!(await p1.isVisible('[data-screen="settings"].is-active'))) throw new Error('P left Settings')
  await p1.keyboard.press('Escape')
  await p1.waitForSelector('[data-screen="menu"].is-active')
  await p1.keyboard.press('Escape')
  await p1.waitForSelector('[data-screen="play"].is-active')

  const phone = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  const phonePage = await openGame(phone, `${base}?room=${room}`, errors)
  await phonePage.click('[data-action="join-invite"]')
  await waitFor(phonePage, s => s.role !== 'spectator' || s.room?.spectators === 1, 'phone did not reach the room')
  await phonePage.waitForTimeout(500)
  await phonePage.screenshot({ path: `${out}/07-phone.png` })

  await one.close()
  await two.close()
  await three.close()
  await phone.close()

  const offline = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN' })
  const offlinePage = await openGame(offline, base, errors)
  await offlinePage.route('**/multiplayer/bootstrap.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ version: 1, build: 'paint-war-v1', signalingUrl: '' }),
  }))
  await offlinePage.click('[data-action="create"]')
  await offlinePage.waitForSelector('[data-screen="notice"].is-active', { timeout: 5000 })
  await offlinePage.screenshot({ path: `${out}/08-offline.png` })
  await offline.close()

  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`)
  await browser.close()
  cleanup()
  console.log(`smoke: OK — screenshots in ${out}/`)
} catch (err) {
  await fail(err?.message ?? String(err))
}
