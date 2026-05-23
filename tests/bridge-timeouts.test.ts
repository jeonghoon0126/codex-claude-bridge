import { describe, expect, it } from 'bun:test'
import {
  codexMcpTotalWaitMs,
  codexPeerTurnTimeoutMs,
} from '../bridge-timeouts.ts'

describe('bridge timeout settings', () => {
  it('keeps the default peer turn inside the caller wait window', () => {
    const env = {}

    expect(codexMcpTotalWaitMs(env)).toBe(3600000)
    expect(codexPeerTurnTimeoutMs(env)).toBe(3590000)
  })

  it('clamps an oversized peer timeout so replies do not arrive after the caller gives up', () => {
    const env = { CODEX_BRIDGE_TOTAL_WAIT_MS: '180000', CODEX_PEER_TURN_TIMEOUT_MS: '180000' }

    expect(codexPeerTurnTimeoutMs(env)).toBe(170000)
  })

  it('allows a longer peer turn only when the caller wait window is also raised', () => {
    const env = { CODEX_BRIDGE_TOTAL_WAIT_MS: '180000' }

    expect(codexMcpTotalWaitMs(env)).toBe(180000)
    expect(codexPeerTurnTimeoutMs(env)).toBe(170000)
  })
})
