// Checks JS and font budgets while reporting the total shipped bundle size.
// Game assets do not have an aggregate transfer-size limit. JS/CSS are measured gzipped;
// TTF/WOFF2 fonts are measured as shipped and budgeted separately because CJK coverage is large.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const MB = 1024 * 1024
const BUDGET = { js: 2.0 * MB, fonts: 2.2 * MB }
const walk = dir => readdirSync(dir).flatMap(name => {
  const p = join(dir, name)
  return statSync(p).isDirectory() ? walk(p) : [p]
})
const files = walk('dist').map(path => {
  const raw = readFileSync(path)
  const text = /\.(js|css|html|json|svg)$/.test(path)
  return { path, size: raw.length, wire: text ? gzipSync(raw).length : raw.length }
})
const sum = pred => files.filter(pred).reduce((n, f) => n + f.wire, 0)
const js = sum(f => f.path.endsWith('.js'))
const fonts = sum(f => /\.(ttf|woff2)$/.test(f.path))
const transfer = sum(f => !f.path.endsWith('.txt'))
const mb = n => `${(n / MB).toFixed(2)} MB`
console.log(`bundle (gzip): js ${mb(js)} / fonts ${mb(fonts)} / transfer ${mb(transfer)}`)
const externalAssets = files.filter(f => {
  if (!/\.(js|html|json)$/.test(f.path)) return false
  const text = readFileSync(f.path, 'utf8')
  return text.includes('/manus-storage/') || text.includes('paintwar-a4mbdwxc.manus.game')
})
if (externalAssets.length) {
  console.error(`external asset URLs remain: ${externalAssets.map(f => f.path).join(', ')}`)
  process.exit(1)
}
const models = files.filter(f => f.path.endsWith('.glb'))
if (models.length < 3) {
  console.error(`expected at least 3 bundled GLB models, found ${models.length}`)
  process.exit(1)
}
const over = Object.entries({ js, fonts }).filter(([k, v]) => v > BUDGET[k])
if (over.length) {
  for (const [k, v] of over) console.error(`over budget: ${k} ${mb(v)} > ${mb(BUDGET[k])}`)
  process.exit(1)
}
