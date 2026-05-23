import type { JsonRpcMessage } from './codex-app-client.ts'

export function approvalSummary(message: JsonRpcMessage, defaultCwd: string): string {
  const p = message.params ?? {}
  if (message.method?.includes('commandExecution')) {
    const command = p.networkApprovalContext
      ? `네트워크 접근: ${p.networkApprovalContext.protocol ?? ''} ${p.networkApprovalContext.host ?? ''}`.trim()
      : `명령 실행: ${p.command ?? '(command unavailable)'}`
    return `${command}\n위치: ${p.cwd ?? defaultCwd}`
  }
  return `파일 변경 승인 요청\n대상: ${p.grantRoot ?? p.itemId ?? 'unknown'}`
}

export function buildAnswers(
  questions: { id: string }[],
  body: string,
): Record<string, { answers: string[] }> {
  const lines = body.split(/\n+/).map(s => s.trim()).filter(Boolean)
  return Object.fromEntries(questions.map((q, i) => [q.id, { answers: [lines[i] ?? body] }]))
}
