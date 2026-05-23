type Env = Record<string, string | undefined>

export const DEFAULT_BRIDGE_TOTAL_WAIT_MS = 60 * 60 * 1000
export const PEER_REPLY_DEADLINE_BUFFER_MS = 10000
export const MIN_PEER_TURN_TIMEOUT_MS = 10000

function parsePositiveMs(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function codexMcpTotalWaitMs(env: Env = process.env): number {
  return parsePositiveMs(env.CODEX_BRIDGE_TOTAL_WAIT_MS, DEFAULT_BRIDGE_TOTAL_WAIT_MS)
}

export function codexPeerTurnTimeoutMs(env: Env = process.env): number {
  const bridgeWaitMs = codexMcpTotalWaitMs(env)
  const latestUsefulReplyMs = Math.max(
    MIN_PEER_TURN_TIMEOUT_MS,
    bridgeWaitMs - PEER_REPLY_DEADLINE_BUFFER_MS,
  )
  const requestedPeerTimeoutMs = parsePositiveMs(
    env.CODEX_PEER_TURN_TIMEOUT_MS,
    latestUsefulReplyMs,
  )
  return Math.min(requestedPeerTimeoutMs, latestUsefulReplyMs)
}
