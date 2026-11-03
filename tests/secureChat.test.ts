import { describe, expect, it } from 'vitest'
import { safetyCode } from '../src/net/secureChat'

const a = 'sha-256 11'.padEnd(73, '1')
const b = 'sha-256 22'.padEnd(73, '2')
const c = 'sha-256 33'.padEnd(73, '3')

describe('chat safety code', () => {
  it('is deterministic, order independent and formatted for comparison', async () => {
    const first = await safetyCode(a, b)
    expect(await safetyCode(b, a)).toBe(first)
    expect(first).toMatch(/^\d{4} \d{4} \d{4} \d{4} \d{4}$/)
  })

  it('changes when either DTLS fingerprint changes', async () => {
    expect(await safetyCode(a, b)).not.toBe(await safetyCode(a, c))
  })
})
