import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

const repoRoot = new URL('..', import.meta.url).pathname
const restoreScript = join(repoRoot, 'scripts/cbridge-restore-latest')
const oneClickScript = join(repoRoot, 'scripts/cbridge-restore-one-click')
const terminalRestoreScript = join(repoRoot, 'scripts/cbridge-restore-terminal')
const focusScript = join(repoRoot, 'scripts/cbridge-focus-room')

const savedConfig = [
  '# room\tthread_id\tcwd\tleader_group\twindow_index\tpane_index\twindow_active\tpane_active',
  'LEADER-3\told-thread-3\t/Users/wjh\tcbridge-leaders-main:A\t0\t0\t1\t1',
  'LEADER-1\told-thread-1\t/Users/wjh\tcbridge-leaders-main:A\t0\t1\t1\t0',
  'LEADER-4\told-thread-4\t/Users/wjh\tcbridge-leaders-main:A\t0\t2\t1\t0',
  'LEADER-2\told-thread-2\t/Users/wjh\tcbridge-leaders-main:A\t0\t3\t1\t0',
  '',
].join('\n')

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

function runRefreshDecision(refreshLatest: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cbridge-restore-policy-'))
  try {
    const home = join(dir, 'home')
    const stateDir = join(home, '.codex-claude-bridge')
    const codexStateDir = join(home, '.codex')
    mkdirSync(stateDir, { recursive: true })
    mkdirSync(codexStateDir, { recursive: true })

    const config = join(stateDir, 'restore-rooms.tsv')
    const stateDb = join(codexStateDir, 'state_5.sqlite')
    const fakeTmux = join(dir, 'tmux')
    const fakeSqlite = join(dir, 'sqlite3')
    writeFileSync(config, savedConfig)
    writeFileSync(stateDb, '')
    writeExecutable(fakeSqlite, '#!/bin/sh\nexit 0\n')
    writeExecutable(fakeTmux, `#!/bin/sh
case "$1" in
  set-option) exit 0 ;;
  list-clients) printf 'cbridge-leaders-tab-A\\n'; exit 0 ;;
  has-session) exit 0 ;;
  list-sessions) printf 'cbridge-leaders-main\\n'; exit 0 ;;
esac
exit 0
`)

    const result = spawnSync('zsh', [restoreScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        CBRIDGE_DIR: repoRoot,
        CBRIDGE_RESTORE_CONFIG: config,
        CBRIDGE_CODEX_STATE_DB: stateDb,
        CBRIDGE_RESTORE_FORCE: '1',
        CBRIDGE_RESTORE_REFRESH_LATEST: refreshLatest,
        CBRIDGE_RESTORE_PRINT_REFRESH_DECISION: '1',
        TMUX_BIN: fakeTmux,
        SQLITE_BIN: fakeSqlite,
      },
    })

    return {
      result,
      config: readFileSync(config, 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('cbridge restore refresh policy', () => {
  test('force restore preserves the saved order in auto mode', () => {
    const { result, config } = runRefreshDecision('auto')

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    expect(result.stdout.trim()).toBe('preserve')
    expect(config).toBe(savedConfig)
  })

  test('latest-thread refresh only runs when explicitly requested', () => {
    const { result, config } = runRefreshDecision('1')

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    expect(result.stdout.trim()).toBe('refresh')
    expect(config).toBe(savedConfig)
  })

  test('latest refresh defaults to newly created conversations', () => {
    const restoreSource = readFileSync(restoreScript, 'utf8')
    const oneClickSource = readFileSync(oneClickScript, 'utf8')

    expect(restoreSource).toContain('LATEST_ORDER="${CBRIDGE_RESTORE_LATEST_ORDER:-created}"')
    expect(restoreSource).toContain('updated|updated_at|activity)')
    expect(restoreSource).toContain('order by $latest_order_sql desc, $latest_tiebreaker_sql desc')
    expect(oneClickSource).toContain('CBRIDGE_RESTORE_REFRESH_LATEST="${CBRIDGE_RESTORE_REFRESH_LATEST:-1}"')
    expect(oneClickSource).toContain('CBRIDGE_RESTORE_LATEST_ORDER="${CBRIDGE_RESTORE_LATEST_ORDER:-created}"')
  })

  test('Terminal restore reuses existing cbridge tabs and opens every missing tab', () => {
    const source = readFileSync(terminalRestoreScript, 'utf8')

    expect(source).toContain('CBRIDGE_RESTORE_OPEN_WINDOWS=0 "$RESTORE_NOW_SCRIPT"')
    expect(source).toContain("[[ \"$existing\" == \"$title\"* ]] && return 0")
    expect(source).not.toContain('if isBusy and')
    expect(source).toContain('terminal_tab_automation_enabled()')
    expect(source).toContain('if customTitle starts with "cbridge A" or tabName starts with "cbridge A"')
    expect(source).toContain('repeat with t in tabs of targetWindow')
    expect(source).toContain('set startIndex to 2')
    expect(source).toContain('repeat with i from startIndex to count argv by 2')
    expect(source).toContain('set custom title of selected tab of front window to tabTitle')
    expect(source).toContain('if ! terminal_tab_automation_enabled')
    expect(source).toContain('Privacy_Accessibility')
    expect(source).toContain('exit 2')
    expect(source).not.toContain('leader views opened in Terminal.app windows')
  })

  test('Terminal restore becomes the preferred app for completion focus', () => {
    const terminalRestoreSource = readFileSync(terminalRestoreScript, 'utf8')
    const focusSource = readFileSync(focusScript, 'utf8')
    const ghosttyRestoreSource = readFileSync(join(repoRoot, 'scripts/cbridge-restore-now'), 'utf8')

    expect(terminalRestoreSource).toContain("printf 'Terminal\\n' > \"$FOCUS_APP_STATE\"")
    expect(ghosttyRestoreSource).toContain("printf 'Ghostty\\n' > \"$FOCUS_APP_STATE\"")
    expect(focusSource).toContain('preferred_focus_app="$(<"$FOCUS_APP_STATE")"')
    expect(focusSource).toContain('if [[ "$preferred_focus_app" == "Terminal" ]]')
    expect(focusSource).toContain('focus_terminal_tab')
    expect(focusSource).toContain('customTitle starts with targetTitle or tabName starts with targetTitle')
  })
})
