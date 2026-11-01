// End-to-end smoke test: dist/ must already exist (`pnpm build`) and server dependencies must be
// installed (`pnpm --dir server install`). Starts the authoritative server on a free port, serves a
// copy of dist/ with a loopback bootstrap, joins one room from two headless browsers, makes p1 push
// p2 out of the arena, checks the menus and Chinese title, fails on any console error, and writes
// screenshots to ./shots/. SMOKE_LATENCY_MS=100 adds a TCP delay in both directions.
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

const site = mkdtempSync(join(tmpdir(), 'ring-out-smoke-'))
cpSync('dist', site, { recursive: true })
const server = spawn(process.execPath, ['server/authoritative_server.mjs'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', STATIC_ROOT: site, ALLOWED_ORIGINS: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
})
let proxy
let browser
const guard = setTimeout(() => fail('timed out'), 120_000)

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

/** The server prints one JSON line with its bound port before anything else. */
function serverPort() {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: server.stdout })
    lines.once('line', line => {
      try { resolve(JSON.parse(line).port) } catch (err) { reject(err) }
    })
    server.once('exit', code => reject(new Error(`server exited (${code})`)))
  })
}

/** Forwards HTTP and WebSocket traffic, delaying every chunk by `ms` in both directions. */
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
  await page.waitForSelector('[data-screen="title"].is-active', { timeout: 30_000 })
  await page.evaluate(async () => {
    await document.fonts.ready
    const expected = document.documentElement.lang === 'zh-CN' ? 'ManusCC0 Sans CJK SC' : 'ManusCC0'
    for (const selector of ['.logo-text', '.tagline']) {
      const family = getComputedStyle(document.querySelector(selector)).fontFamily
      if (!family.startsWith(`"${expected}"`) && !family.startsWith(expected + ',')) {
        throw new Error(`Unexpected game font: ${family}`)
      }
    }
  })
  await page.waitForTimeout(400)
  return page
}

const match = page => page.evaluate(() => {
  const { game } = window.__game
  const s = game.state
  const seats = s?.seats ?? {}
  return {
    role: game.role, phase: s?.phase ?? '', round: s?.round ?? 0,
    score: s ? Object.fromEntries(Object.entries(seats).map(([seat, value]) => [seat, value.score])) : null,
    playing: Object.keys(seats).filter(seat => seats[seat].playing),
  }
})

async function waitFor(page, predicate, label, timeout = 20_000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await match(page)
    if (predicate(last)) return last
    await page.waitForTimeout(100)
  }
  throw new Error(`${label} (last ${JSON.stringify(last)})`)
}

try {
  const port = await serverPort()
  const pagePort = latency > 0 ? await delayProxy(port, latency) : port
  writeFileSync(join(site, 'multiplayer', 'bootstrap.json'), JSON.stringify({
    version: 1, build: 'ring-out-v2', signalingUrl: `ws://127.0.0.1:${pagePort}/ws`, iceTransportPolicy: 'all',
  }))
  const base = `http://127.0.0.1:${pagePort}/`
  // Prefer Playwright's bundled Chromium; fall back to an installed Google Chrome.
  const args = ['--ignore-gpu-blocklist']
  browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: 'chrome' }))
  const errors = []

  const one = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' })
  const two = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' })
  const p1 = await openGame(one, `${base}?room=SMOKE1`, errors)
  await p1.screenshot({ path: `${out}/01-title-en.png` })
  await p1.click('[data-action="play"]')
  await waitFor(p1, s => s.role === 'p1' && s.phase === 'waiting', 'first visitor did not get p1')
  await p1.waitForTimeout(400)
  await p1.screenshot({ path: `${out}/02-waiting.png` })

  const p2 = await openGame(two, `${base}?room=SMOKE1`, errors)
  await p2.click('[data-action="play"]')
  await waitFor(p2, s => s.role === 'p2', 'second visitor did not get p2')
  await waitFor(p1, s => s.phase === 'live', 'round did not start')
  await p1.screenshot({ path: `${out}/03-live-p1.png` })

  // A third visitor waits on the title screen and joins after the first point.
  const three = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' })
  const p3 = await openGame(three, `${base}?room=SMOKE1`, errors)

  // p1's camera faces p2, so "up" drives straight at it.
  await p1.keyboard.down('KeyW')
  const scored = await waitFor(p1, s => s.score?.p1 === 1, 'p1 did not push p2 out', 15_000)
  await p1.keyboard.up('KeyW')
  // Join during the point pause: only seats connected when the countdown ends play the next round.
  await p3.click('[data-action="play"]')
  await p2.screenshot({ path: `${out}/04-ringout-p2.png` })
  const seen = await waitFor(p2, s => s.score?.p1 === 1, 'p2 did not see the score')
  if (scored.score.p2 !== 0 || seen.score.p2 !== 0) throw new Error(`unexpected score ${JSON.stringify(seen.score)}`)
  await waitFor(p1, s => s.phase === 'countdown' || s.phase === 'live', 'round did not reset')
  console.log(`smoke: p1 scored 1–0${latency ? ` with ${latency} ms delay each way` : ''}`)
  await waitFor(p3, s => s.role === 'p3', 'third visitor did not get p3')
  await waitFor(p1, s => s.phase === 'live' && s.playing.includes('p3'), 'p3 did not play the next round')
  if (!(await p1.isVisible('.hud-side-p3'))) throw new Error('the HUD does not show P3')
  await p1.waitForTimeout(400)
  await p1.screenshot({ path: `${out}/04b-three-players-p1.png` })
  await three.close()
  console.log('smoke: a third player joined after a point and played the next round')

  await p1.keyboard.press('Escape')
  await p1.waitForSelector('[data-screen="menu"].is-active')
  await p1.waitForTimeout(400)
  await p1.screenshot({ path: `${out}/05-menu.png` })
  await p1.click('[data-screen="menu"] [data-action="settings"]')
  await p1.waitForSelector('[data-screen="settings"].is-active')
  // Pause must not replace Settings (that would empty the Back stack).
  await p1.keyboard.press('KeyP')
  await p1.waitForTimeout(200)
  if (!(await p1.isVisible('[data-screen="settings"].is-active'))) throw new Error('P left the Settings screen')
  await p1.keyboard.press('Escape')
  await p1.waitForSelector('[data-screen="menu"].is-active')
  if ((await match(p1)).role !== 'p1') throw new Error('opening the menu dropped the seat')
  await p1.keyboard.press('Escape')
  await p1.waitForSelector('[data-screen="hud"].is-active')
  await one.close()
  await two.close()

  const zh = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN' })
  const zhPage = await openGame(zh, `${base}?room=SMOKE2`, errors)
  const lang = await zhPage.evaluate(() => document.documentElement.lang)
  if (lang !== 'zh-CN') throw new Error(`browser language not detected (lang=${lang})`)
  await zhPage.screenshot({ path: `${out}/06-title-zh.png` })
  await zh.close()

  const phone = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-US' })
  const phonePage = await openGame(phone, `${base}?room=SMOKE3`, errors)
  await phonePage.tap('[data-action="play"]')
  await waitFor(phonePage, s => s.role === 'p1', 'phone did not join')
  await phonePage.waitForTimeout(600)
  await phonePage.screenshot({ path: `${out}/07-phone-hud.png` })
  await phone.close()

  // The committed bootstrap has no endpoint: Play Online must explain that and still offer Leave.
  const offline = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' })
  await offline.route('**/multiplayer/bootstrap.json', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ version: 1, build: 'ring-out-v2', signalingUrl: '' }),
  }))
  const offlinePage = await openGame(offline, `${base}?room=SMOKE4`, errors)
  await offlinePage.click('[data-action="play"]')
  await offlinePage.waitForFunction(() => /not configured/.test(document.querySelector('[data-slot="banner"]')?.textContent ?? ''))
  await offlinePage.waitForTimeout(400)
  await offlinePage.screenshot({ path: `${out}/08-unconfigured.png` })
  await offlinePage.click('[data-action="menu"]')
  await offlinePage.waitForSelector('[data-screen="menu"].is-active')
  await offlinePage.click('[data-action="leave"]')
  await offlinePage.waitForSelector('[data-screen="title"].is-active')
  await offline.close()

  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`)
  await browser.close()
  cleanup()
  console.log(`smoke: OK — screenshots in ${out}/`)
} catch (err) {
  await fail(err?.message ?? String(err))
}
