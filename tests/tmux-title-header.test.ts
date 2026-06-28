import { readFileSync } from 'fs'
import { describe, expect, test } from 'bun:test'
import {
  shouldClearLeaderUnreadAfterRead,
  titleHeaderDisplayLine,
  titleHeaderDisplayWidth,
} from '../covering-bridge.ts'

describe('tmux title header rendering', () => {
  test('keeps answer preview within one physical terminal row', () => {
    const line = titleHeaderDisplayLine('run-rate 쉽게 말하면 “지금 속도 그대로 이어진다고 보면…', 61)

    expect(line.includes('\n')).toBe(false)
    expect(line.endsWith('…')).toBe(true)
    expect(titleHeaderDisplayWidth(line)).toBeLessThanOrEqual(61)
  })

  test('preserves answer preview when it fits one physical terminal row', () => {
    const answer = '정확한 값 아니야'

    expect(titleHeaderDisplayLine(answer, 61)).toBe(answer)
  })

  test('uses visual terminal columns for Korean title width', () => {
    const title = '리더세션의 제목이 너무 짧아 글자를 더 보여줘도 되는데'
    const line = titleHeaderDisplayLine(title, 61)

    expect(line).toBe(title)
    expect(titleHeaderDisplayWidth(line)).toBeLessThanOrEqual(61)
  })

  test('keeps Korean title when it exactly fits the header width', () => {
    const title = '가나다라마'

    expect(titleHeaderDisplayWidth(title)).toBe(10)
    expect(titleHeaderDisplayLine(title, 10)).toBe(title)
  })

  test('truncates Korean title only after it exceeds the header width', () => {
    const line = titleHeaderDisplayLine('가나다라마A', 10)

    expect(line).toBe('가나다라…')
    expect(titleHeaderDisplayWidth(line)).toBeLessThanOrEqual(10)
  })

  test('clears unread after the selected leader pane has already shown completion', () => {
    expect(shouldClearLeaderUnreadAfterRead(true, false, false, true)).toBe(true)
    expect(shouldClearLeaderUnreadAfterRead(true, false, true, false)).toBe(true)
    expect(shouldClearLeaderUnreadAfterRead(true, false, false, false)).toBe(false)
  })

  test('keeps the completion marker visible on the tick where the answer finishes', () => {
    expect(shouldClearLeaderUnreadAfterRead(true, true, false, true)).toBe(false)
    expect(shouldClearLeaderUnreadAfterRead(true, true, true, true)).toBe(false)
  })

  test('does not emit terminal scrollback clear sequences', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')
    const headerCommandSource = source.match(/function tmuxTitleHeaderCommand[\s\S]*?function ensureTmuxTitleHeader/)?.[0] ?? ''

    expect(headerCommandSource).not.toContain('\\033[3J')
    expect(headerCommandSource).toContain('tmux clear-history -t "$self"')
  })

  test('keeps leader title header polling slow enough for smooth mouse input', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')
    const constantsSource = source.match(/const DASHBOARD_REFRESH_MS[\s\S]*?const LEADER_UNREAD_RESTORE_MS/)?.[0] ?? ''
    const headerCommandSource = source.match(/function tmuxTitleHeaderCommand[\s\S]*?function ensureTmuxTitleHeader/)?.[0] ?? ''
    const watchSource = source.match(/async function watchTmuxPaneTitles[\s\S]*?function readPid/)?.[0] ?? ''

    expect(constantsSource).toContain("envNumber('CODEX_BRIDGE_PANE_HEADER_REFRESH_MS', 15_000)")
    expect(constantsSource).toContain("envNumber('CODEX_BRIDGE_PANE_TITLE_WATCH_MS', 15_000)")
    expect(constantsSource).toContain("envNumber('CODEX_BRIDGE_SESSION_FILE_REFRESH_MS', 15_000)")
    expect(source).toContain("const PANE_TITLE_HEADER_VERSION = '17'")
    expect(headerCommandSource).toContain('PANE_TITLE_HEADER_REFRESH_MS / 1000')
    expect(watchSource).toContain('PANE_TITLE_WATCH_REFRESH_MS')
    expect(watchSource).not.toContain('DASHBOARD_REFRESH_MS')
  })

  test('shows leader title headers by default while keeping border titles opt-in', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')
    const titleSessionSource = source.match(/function isCbridgeTitleSession[\s\S]*?function peerLabelFromSession/)?.[0] ?? ''
    const cleanupSource = source.match(/function cleanupTmuxTitleHeaders[\s\S]*?function tmuxTitleHeaderCommand/)?.[0] ?? ''

    expect(source).toContain("const DEFAULT_LEADER_TITLE_HEADER_WINDOWS = '*'")
    expect(source).toContain('const LEADER_BORDER_TITLES = envFlag')
    expect(source).toContain("envFlag('CBRIDGE_LEADER_BORDER_TITLES', false)")
    expect(source).toContain('process.env.CBRIDGE_LEADER_TITLE_HEADER_WINDOWS ?? DEFAULT_LEADER_TITLE_HEADER_WINDOWS')
    expect(titleSessionSource).toContain('function shouldUsePaneTitleHeader')
    expect(titleSessionSource).toContain('leaderWindowAllowsTitleHeader(target.windowName)')
    expect(cleanupSource).toContain('!shouldUsePaneTitleHeader(header)')
    expect(source).toContain('const usesTitleHeader = shouldUsePaneTitleHeader(pane)')
    expect(source).toContain("pane.sessionName.startsWith('cbridge-leaders-') && !usesTitleHeader && LEADER_BORDER_TITLES")
  })

  test('allows extra leader columns while title headers are visible', () => {
    const source = readFileSync(new URL('../scripts/cbridge-tmux-layout', import.meta.url), 'utf8')
    const sideColumnSource = source.match(/side_column_two_rows_plain\(\) \{[\s\S]*?sidecar_pairs_for_position\(\) \{/)?.[0] ?? ''
    const sidecarLayoutSource = source.match(/apply_leader_sidecar_layout\(\) \{[\s\S]*?if \[\[ "\$layout" == "leader-remove" \]\]/)?.[0] ?? ''

    expect(sideColumnSource).toContain('leader_grid_cell 0 "$width" "$x" "$window_height" "$top_pane"')
    expect(sideColumnSource).toContain('top_cell="$(leader_grid_cell 0 "$width" "$x" "${row_heights[1]}" "$top_pane")"')
    expect(sideColumnSource).toContain('bottom_cell="$(leader_grid_cell "$bottom_y" "$width" "$x" "${row_heights[2]}" "$bottom_pane")"')
    expect(sidecarLayoutSource).not.toContain('리더 열 추가는 border-title 리더 pane에서만 사용할 수 있습니다')
    expect(sidecarLayoutSource).not.toContain('if (( has_all_headers ))')
  })

  test('keeps automatic snapshots slow enough to avoid constant tmux churn', () => {
    const source = readFileSync(new URL('../scripts/cbridge-snapshot-daemon', import.meta.url), 'utf8')

    expect(source).toContain('INTERVAL="${CBRIDGE_SNAPSHOT_INTERVAL_SECONDS:-15}"')
    expect(source).toContain('[[ "$INTERVAL" == <-> ]] || INTERVAL=15')
    expect(source).toContain('run_snapshot "--snapshot-final" "$FINAL_WAIT" 1 1')
  })

  test('keeps the load governor inside cbridge without touching protected apps', () => {
    const source = readFileSync(new URL('../scripts/cbridge-load-governor', import.meta.url), 'utf8')

    expect(source).toContain('PROTECTED_APPS="${CBRIDGE_GOVERNOR_PROTECTED_APPS:-Notion,Figma,Ghostty}"')
    expect(source).toContain('ACTIVE_WINDOWS="${CBRIDGE_GOVERNOR_ACTIVE_WINDOWS:-}"')
    expect(source).toContain('RUNNING_WINDOWS="${CBRIDGE_GOVERNOR_RUNNING_WINDOWS:-}"')
    expect(source).toContain('PARK_INACTIVE="${CBRIDGE_GOVERNOR_PARK_INACTIVE:-1}"')
    expect(source).toContain('RESUME_TTL_SECONDS="${CBRIDGE_GOVERNOR_RESUME_TTL_SECONDS:-600}"')
    expect(source).toContain('REMOVE_TITLE_HEADERS="${CBRIDGE_GOVERNOR_REMOVE_TITLE_HEADERS:-0}"')
    expect(source).toContain('WINDOWSERVER_HIGH="${CBRIDGE_GOVERNOR_WINDOWSERVER_HIGH:-20}"')
    expect(source).toContain('remove_leader_title_headers')
    expect(source).toContain('[[ "$REMOVE_TITLE_HEADERS" == "1" ]] || return 0')
    expect(source).toContain('background_inactive_leaders')
    expect(source).toContain('park_inactive_leaders')
    expect(source).toContain('resume_window')
    expect(source).toContain('is_own_process_tree')
    expect(source).toContain('taskpolicy -b -p "$pid"')
    expect(source).toContain('taskpolicy -B -p "$pid"')
    expect(source).toContain('kill -STOP "$pid"')
    expect(source).toContain('kill -CONT "$pid"')
    expect(source).not.toContain('killall')
    expect(source).not.toContain('kill -TERM')
    expect(source).not.toContain('kill -KILL')
    expect(source).not.toContain('pkill')
    expect(source).not.toContain('set visible of process "Notion"')
    expect(source).not.toContain('set visible of process "Figma"')
    expect(source).not.toContain('set visible of process "Ghostty"')
  })

  test('resumes parked leaders from the cbridge mouse path', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')
    const mouseSource = source.match(/function configureTmuxLeaderLayoutMenu[\s\S]*?function getTmuxTitleHeaders/)?.[0] ?? ''

    expect(source).toContain('const CBRIDGE_LOAD_GOVERNOR_SCRIPT')
    expect(mouseSource).toContain('resumeLeaderWindowCommand')
    expect(mouseSource).toContain('--resume-window "#{window_name}"')
    expect(mouseSource).toContain('MouseDown1Pane')
    expect(mouseSource).toContain('MouseDown1Border')
  })

  test('shows Slack usage status without taking over the title body', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')

    expect(source).toContain('#{@cbridge_slack_notice}')
    expect(source).toContain('roomUsesSlack(roomId)')
    expect(source).toContain("'Slack 사용 중'")
    expect(source).toContain("setTmuxPaneOptionIfChanged(pane.target, '@cbridge_slack_notice', pane.currentSlackNotice, '')")
    expect(source).not.toContain('function slackNoticeTitleLines')

    const noticeBranch = source.indexOf("if (pane.role === 'leader' && pane.currentSlackNotice)")
    const normalTitleBranch = source.indexOf('completedAnswerTitleLines(prompt, pane.width, prefix)')
    expect(noticeBranch).toBeGreaterThan(0)
    expect(normalTitleBranch).toBeGreaterThan(0)
    expect(noticeBranch).toBeLessThan(normalTitleBranch)
  })

  test('uses compact leader number and keeps peer role labels in title prefixes', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')
    const titlePrefixSource = source.match(/function titlePrefixForPane[\s\S]*?const MCP_JSON_PATH/)?.[0] ?? ''

    expect(titlePrefixSource).toContain('const parts = [pane.roleLabel]')
    expect(titlePrefixSource).not.toContain('workLabel')
    expect(source).toContain('return leaderRoomDisplayLabel(roomId)')
    expect(source).toContain('return `PEER-${roomMatch}`')
  })

  test('keeps leader prompt to one line while preserving the summary line', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')
    const latestPromptSource = source.match(/function latestPromptSummaryFromFile[\s\S]*?function latestWorkLabelFromFile/)?.[0] ?? ''
    const completedTitleSource = source.match(/function completedAnswerTitleLines[\s\S]*?function isInternalRoomId/)?.[0] ?? ''
    const dashboardSource = source.match(/function printLeaderPromptSummaries[\s\S]*?function printRooms/)?.[0] ?? ''

    expect(latestPromptSource).toContain('const prompt = `${promptLine}\\n${summaryLine}`')
    expect(latestPromptSource).not.toContain('const prompt = `${promptLine}\\n${assistantDetailLine')
    expect(completedTitleSource).toContain('return titleLines(prefixText, prompt, width)')
    expect(completedTitleSource).not.toContain('assistantSummaryTitleLine')
    expect(dashboardSource).not.toContain('console.log(`  ${C.bold}${C.bcyan}${item.roomId}${C.reset}`)')
  })

  test('renders leader title header as prompt line and answer summary line', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')
    const titleLinesSource = source.match(/function titleLines[\s\S]*?function completedAnswerTitleLines/)?.[0] ?? ''
    const ensureHeaderSource = source.match(/function ensureTmuxTitleHeader[\s\S]*?function sanitizePaneTitle/)?.[0] ?? ''

    expect(titleLinesSource).toContain("titleLineWithPrefix(prefixText, explicitLines[0] ?? '', width)")
    expect(titleLinesSource).toContain("titleHeaderDisplayLine(explicitLines[1] ?? '', lineWidth)")
    expect(titleLinesSource).not.toContain('assistantSummaryTitleLine')
    expect(titleLinesSource).not.toContain('oneLineTitleWithSummary')
    expect(ensureHeaderSource).toContain("existing.height !== 2")
    expect(ensureHeaderSource).toContain("'-l',\n    '2'")
    expect(ensureHeaderSource).toContain("'-y', '2'")
  })

  test('marks unread answers on every leader tab, not only A and B', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')

    expect(source).toContain('function isLeaderWindowName')
    expect(source).toContain('if (unread && isLeaderWindowName(pane.windowName))')
    expect(source).not.toContain("pane.windowName === 'A' || pane.windowName === 'B'")
    expect(source).toContain('const title = unreadNumbers.length > 0')
    expect(source).toContain('`cbridge ${windowName} 새:${unreadNumbers.join')
  })

  test('keeps a restore anchor before parking stale leader panes', () => {
    const source = readFileSync(new URL('../scripts/cbridge-restore-latest', import.meta.url), 'utf8')
    const normalizeSource = source.match(/normalize_existing_leader_window\(\) \{[\s\S]*?create_leader_window\(\) \{/)?.[0] ?? ''

    expect(source).toContain('create_restore_anchor_pane()')
    expect(source).toContain('@cbridge_restore_anchor')
    expect(normalizeSource).toContain('ensure_restore_anchor "$cwd"')
    expect(normalizeSource.indexOf('ensure_restore_anchor "$cwd"')).toBeLessThan(
      normalizeSource.indexOf('park_leader_pane_in_peer_window "$pane" "$room" "$cwd"'),
    )
    expect(normalizeSource).toContain('remove_restore_anchor_pane "$restore_anchor_pane"')
  })

  test('uses visible Mac completion notification fallback', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')
    const notifySource = source.match(/function notifyLeaderCompletion[\s\S]*?function getSelectedLeaderPanesByWindow/)?.[0] ?? ''

    expect(source).toContain('function showLeaderCompletionDialogFallback')
    expect(source).toContain('const MAC_DIALOG_FALLBACK_SECONDS')
    expect(notifySource).toContain("'-ignoreDnD'")
    expect(notifySource).toContain('showLeaderCompletionDialogFallback(title, subtitle, message, focusCommand)')
    expect(source).toContain("process.env.CBRIDGE_MAC_DIALOG_FALLBACK === '0'")
    expect(source).toContain('giving up after ${MAC_DIALOG_FALLBACK_SECONDS}')
    expect(source).toContain('if gave up of dialogResult is false then')
    expect(source).toContain('do shell script ${appleScriptString(focusCommand)}')
  })
})
