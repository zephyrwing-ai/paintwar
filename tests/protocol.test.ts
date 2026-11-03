import { describe, expect, it } from 'vitest'
import { CHAT_CAPABILITY, MAX_SIGNAL_BYTES } from '../shared/protocol'
import { BUILD, decode } from '../src/net/protocol'

const welcome = (capabilities?: unknown) => JSON.stringify({
  type: 'welcome',
  marker: BUILD,
  room: 'ABCD',
  role: 'p1',
  resume_token: 'resume',
  name: 'tester',
  now: 1,
  ...(capabilities === undefined ? {} : { capabilities }),
})

describe('client wire decoding', () => {
  it('advertises chat only when the server capability is present', () => {
    const message = decode(welcome([CHAT_CAPABILITY]), 'ABCD', -1)
    expect(message?.type).toBe('welcome')
    if (message?.type === 'welcome') expect(message.capabilities).toEqual([CHAT_CAPABILITY])
    const legacy = decode(welcome(), 'ABCD', -1)
    if (legacy?.type === 'welcome') expect(legacy.capabilities).toEqual([])
  })

  it('rejects malformed capabilities and rtc fields', () => {
    expect(decode(welcome([1]), 'ABCD', -1)).toBeNull()
    const base = { type: 'rtc', marker: BUILD, room: 'ABCD', from: 'p2' }
    expect(decode(JSON.stringify({ ...base, kind: 'message', data: 'x' }), 'ABCD', -1)).toBeNull()
    expect(decode(JSON.stringify({ ...base, kind: 'offer', data: 'x'.repeat(MAX_SIGNAL_BYTES + 1) }), 'ABCD', -1)).toBeNull()
  })
})
