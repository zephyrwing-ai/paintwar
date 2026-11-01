import { manusGameTuning } from './scripts/manus-tuning/vite.mjs'
import { loadEnv, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import bootstrap from './public/multiplayer/bootstrap.json'

const ENDPOINT = /^wss:\/\/[^/@?#:]+(:[0-9]+)?\/ws$|^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?\/ws$/

/**
 * Local preview only: GAME_MULTIPLAYER_SIGNALING_URL (the same name as the Godot preview) replaces
 * `signalingUrl` from public/multiplayer/bootstrap.json. Builds always ship the committed file, so a
 * loopback endpoint never reaches a published game.
 */
function multiplayerBootstrap(signalingUrl: string | undefined): Plugin {
  return {
    name: 'multiplayer-bootstrap',
    apply: 'serve',
    configureServer(server) {
      if (!signalingUrl) return
      if (!ENDPOINT.test(signalingUrl)) throw new Error('GAME_MULTIPLAYER_SIGNALING_URL must be wss://<host>/ws or ws://127.0.0.1:<port>/ws')
      const body = JSON.stringify({ ...bootstrap, signalingUrl })
      server.middlewares.use('/multiplayer/bootstrap.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(body)
      })
    },
  }
}

// Relative base keeps production output portable; the Session owns preview HOST/PORT.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', ['HOST', 'PORT', 'GAME_MULTIPLAYER_'])
  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
  return {
    base: './',
    plugins: [manusGameTuning(), multiplayerBootstrap(env.GAME_MULTIPLAYER_SIGNALING_URL)],
    server: {
      host: env.HOST ?? '127.0.0.1', port, strictPort: true,
      allowedHosts: ['.manuspre.computer', '.manus.computer', '.manus-asia.computer', '.manuscomputer.ai', '.manusvm.computer', 'localhost', '127.0.0.1'],
    },
    build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4600, sourcemap: false },
    test: { environment: 'node', include: ['tests/**/*.test.{ts,mjs}'] },
  }
})
