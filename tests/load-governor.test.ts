import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { spawnSync } from 'child_process'

type FakePane = {
  session: string
  window: string
  id: string
  pid: string
  room: string
  parked?: string
}

type RunGovernorOptions = {
  actionProcessFixture?: string
  processFixture?: string
  statusFile?: string
  statusJson?: string
  windowserverCpu?: string
}

const governorScript = new URL('../scripts/cbridge-load-governor', import.meta.url).pathname
const repoRoot = new URL('..', import.meta.url).pathname
const governorTestTimeout = 15_000

function fakeTmuxScript(): string {
  return `#!/usr/bin/env bun
import { appendFileSync } from 'fs'

const sessions = (process.env.FAKE_TMUX_SESSIONS || '').split(',').filter(Boolean)
const panes = JSON.parse(process.env.FAKE_TMUX_PANES || '[]')
const logPath = process.env.FAKE_GOVERNOR_LOG
const args = Bun.argv.slice(2)

function log(line) {
  appendFileSync(logPath, line + '\\n')
}

function formatPane(pane, format) {
  if (format === '#{window_name}|#{pane_pid}|#{@cbridge_room}') {
    return [pane.window, pane.pid, pane.room || ''].join('|')
  }
  if (format === '#{window_name}|#{pane_id}|#{pane_pid}|#{@cbridge_room}|#{@cbridge_parked}') {
    return [pane.window, pane.id, pane.pid, pane.room || '', pane.parked || ''].join('|')
  }
  if (format === '#{pane_id}|#{pane_pid}|#{@cbridge_room}') {
    return [pane.id, pane.pid, pane.room || ''].join('|')
  }
  if (format === '#{window_name}|#{pane_id}|#{pane_pid}|#{@cbridge_room}') {
    return [pane.window, pane.id, pane.pid, pane.room || ''].join('|')
  }
  if (format === '#{session_name}|#{pane_id}|#{@cbridge_header_for}') {
    return [pane.session, pane.id, pane.headerFor || ''].join('|')
  }
  return ''
}

if (args[0] === 'has-session') {
  const session = args[args.indexOf('-t') + 1]
  process.exit(sessions.includes(session) ? 0 : 1)
}

if (args[0] === 'list-panes') {
  const format = args[args.indexOf('-F') + 1]
  const targetIndex = args.indexOf('-t')
  const target = targetIndex >= 0 ? args[targetIndex + 1] : ''
  const [targetSession, targetWindow] = target.split(':')
  const all = args.includes('-a')
  const rows = panes.filter((pane) => {
    if (all) return true
    if (!targetSession) return true
    if (pane.session !== targetSession) return false
    return !targetWindow || pane.window === targetWindow
  })
  console.log(rows.map((pane) => formatPane(pane, format)).filter(Boolean).join('\\n'))
  process.exit(0)
}

if (args[0] === 'set-option') {
  log('tmux ' + args.join(' '))
  process.exit(0)
}

process.exit(0)
`
}

function fakeTaskpolicyScript(): string {
  return `#!/bin/sh
echo "taskpolicy $*" >> "$FAKE_GOVERNOR_LOG"
exit 0
`
}

function runGovernor(
  args: string[],
  panes: FakePane[],
  sessions = ['cbridge-leaders-main', 'cbridge-leaders-slack'],
  options: RunGovernorOptions = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'cbridge-governor-'))
  try {
    const fakeTmux = join(dir, 'tmux')
    const fakeTaskpolicy = join(dir, 'taskpolicy')
    const logPath = join(dir, 'governor.log')
    const governorLogPath = join(dir, '.codex-claude-bridge', 'logs', 'load-governor.log')
    const defaultStatusPath = join(dir, '.codex-claude-bridge', 'load-governor-status.json')
    const statusPath = options.statusFile || defaultStatusPath
    const fixturePath = options.processFixture ? join(dir, 'processes.tsv') : ''
    const actionFixturePath = join(dir, 'action-processes.tsv')
    mkdirSync(join(dir, '.codex-claude-bridge'), { recursive: true })
    writeFileSync(fakeTmux, fakeTmuxScript())
    writeFileSync(fakeTaskpolicy, fakeTaskpolicyScript())
    writeFileSync(logPath, '')
    if (options.processFixture) writeFileSync(fixturePath, options.processFixture)
    writeFileSync(actionFixturePath, options.actionProcessFixture || '')
    if (options.statusJson) {
      mkdirSync(dirname(statusPath), { recursive: true })
      writeFileSync(statusPath, options.statusJson)
    }
    chmodSync(fakeTmux, 0o755)
    chmodSync(fakeTaskpolicy, 0o755)

    const result = spawnSync('zsh', [governorScript, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        HOME: dir,
        FAKE_GOVERNOR_LOG: logPath,
        FAKE_TMUX_PANES: JSON.stringify(panes),
        FAKE_TMUX_SESSIONS: sessions.join(','),
        CBRIDGE_GOVERNOR_STATUS_FILE: statusPath,
        CBRIDGE_GOVERNOR_TEST_MODE: '1',
        CBRIDGE_GOVERNOR_WINDOWSERVER_CPU_FIXTURE: options.windowserverCpu || '9',
        ...(fixturePath ? { CBRIDGE_GOVERNOR_PROCESS_FIXTURE: fixturePath } : {}),
        CBRIDGE_GOVERNOR_ACTION_PROCESS_FIXTURE: actionFixturePath,
      },
    })

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    return {
      log: readFileSync(logPath, 'utf8'),
      governorLog: existsSync(governorLogPath) ? readFileSync(governorLogPath, 'utf8') : '',
      stdout: result.stdout,
      status: existsSync(statusPath) ? readFileSync(statusPath, 'utf8') : '',
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('cbridge load governor', () => {
  test('parks inactive slack leader panes by default', () => {
    const { log } = runGovernor(['--once'], [
      { session: 'cbridge-leaders-main', window: 'B', id: '%main', pid: '11111', room: 'LEADER-7' },
      { session: 'cbridge-leaders-slack', window: 'LEADER-24', id: '%slack', pid: '22222', room: 'LEADER-24' },
    ])

    expect(log).toContain('tmux set-option -pt %slack @cbridge_parked 1')
  }, governorTestTimeout)

  test('resumes a parked slack leader window', () => {
    const { log } = runGovernor(['--resume-window', 'LEADER-24'], [
      {
        session: 'cbridge-leaders-slack',
        window: 'LEADER-24',
        id: '%slack',
        pid: '22222',
        room: 'LEADER-24',
        parked: '1',
      },
    ])

    expect(log).toContain('tmux set-option -pt %slack @cbridge_parked ')
  }, governorTestTimeout)

  test('keeps existing main leader window behavior', () => {
    const { log } = runGovernor(['--once'], [
      { session: 'cbridge-leaders-main', window: 'A', id: '%main', pid: '11111', room: 'LEADER-1' },
    ], ['cbridge-leaders-main'])

    expect(log).toContain('tmux set-option -pt %main @cbridge_parked 1')
  }, governorTestTimeout)

  test('writes a status snapshot without running heavy process inspection in tests', () => {
    const { status } = runGovernor(
      ['--once'],
      [{ session: 'cbridge-leaders-slack', window: 'LEADER-24', id: '%slack', pid: '22222', room: 'LEADER-24' }],
      ['cbridge-leaders-slack'],
      {
        processFixture: '22222\t41.5\t/Users/wjh/.bun/bin/bun /Users/wjh/codex-claude-bridge/codex-mcp.ts\n407\t28.0\tWindowServer\n',
      },
    )

    const parsed = JSON.parse(status)
    expect(parsed.windowserver_cpu).toBeNumber()
    expect(parsed.top_processes[0]).toEqual({
      pid: 22222,
      cpu: 41.5,
      command: '/Users/wjh/.bun/bin/bun /Users/wjh/codex-claude-bridge/codex-mcp.ts',
    })
    expect(parsed.leader_sessions).toContain('cbridge-leaders-slack')
  }, governorTestTimeout)

  test('prints a readable status summary', () => {
    const now = Math.floor(Date.now() / 1000)
    const { stdout } = runGovernor(['--status'], [], [], {
      statusJson: JSON.stringify({
        updated_at_epoch: now,
        windowserver_cpu: 23,
        high_streak: 1,
        last_action_at: '2026-06-24 13:48:22',
        leader_sessions: ['cbridge-leaders-main', 'cbridge-leaders-slack'],
        parked_leaders: ['LEADER-24', 'LEADER-26'],
        top_processes: [
          { pid: 95971, cpu: 38.9, command: '/Applications/Notion.app/Contents/Frameworks/Notion Helper' },
          { pid: 407, cpu: 23.0, command: 'WindowServer' },
        ],
      }),
    })

    expect(stdout).toContain('WindowServer 23%')
    expect(stdout).toContain('최근 조치 2026-06-24 13:48:22')
    expect(stdout).toContain('일시정지 리더 LEADER-24, LEADER-26')
    expect(stdout).toContain('Notion Helper 38.9%')
  }, governorTestTimeout)

  test('marks stale status when the monitor has not updated recently', () => {
    const { stdout } = runGovernor(['--status'], [], [], {
      statusJson: JSON.stringify({
        updated_at_epoch: 1,
        windowserver_cpu: 10,
        high_streak: 0,
        last_action_at: '',
        leader_sessions: [],
        parked_leaders: [],
        top_processes: [],
      }),
    })

    expect(stdout).toContain('모니터 갱신이 오래됐습니다')
  }, governorTestTimeout)

  test('continues when the status snapshot cannot be written', () => {
    const { governorLog } = runGovernor(
      ['--once'],
      [{ session: 'cbridge-leaders-main', window: 'A', id: '%main', pid: '11111', room: 'LEADER-1' }],
      ['cbridge-leaders-main'],
      { statusFile: '/dev/null/cbridge-status.json' },
    )

    expect(governorLog).toContain('status write skipped')
    expect(governorLog).toContain('checked cbridge load guard')
  }, governorTestTimeout)

  test('backgrounds screen pressure helpers without terminating Control Center', () => {
    const { log, governorLog, status } = runGovernor(
      ['--once'],
      [{ session: 'cbridge-leaders-main', window: 'A', id: '%main', pid: '11111', room: 'LEADER-1' }],
      ['cbridge-leaders-main'],
      {
        actionProcessFixture: [
          '407\t1\t55.0\t/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
          '300\t1\t47.0\t/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter',
          '301\t1\t18.0\t/Applications/DisplayLink Manager.app/Contents/MacOS/DisplayLinkUserAgent',
          '302\t1\t22.0\t/System/Library/Frameworks/VideoToolbox.framework/Versions/A/XPCServices/VTEncoderXPCService.xpc/Contents/MacOS/VTEncoderXPCService',
        ].join('\n') + '\n',
        windowserverCpu: '55',
      },
    )

    expect(log).toContain('taskpolicy -b -p 300')
    expect(log).toContain('taskpolicy -b -p 301')
    expect(log).toContain('taskpolicy -b -p 302')
    expect(governorLog).toContain('screen-background pid=300')
    expect(governorLog).not.toContain('screen-terminated pid=300')
    expect(JSON.parse(status).last_actions.some((action: string) => action.includes('screen-background pid=300'))).toBe(true)
  }, governorTestTimeout)

  test('does not throttle interactive web app renderers automatically', () => {
    const { log, governorLog } = runGovernor(
      ['--once'],
      [],
      [],
      {
        actionProcessFixture: [
          '407\t1\t55.0\t/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
          '301\t1\t30.0\t/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent',
          '302\t1\t25.0\t/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari',
          '303\t1\t24.0\t/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/149.0.7827.156/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)',
          '304\t1\t23.0\t/Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer)',
          '305\t1\t22.0\t/Applications/WorkDashboard.app/Contents/MacOS/WorkDashboard',
        ].join('\n') + '\n',
        windowserverCpu: '55',
      },
    )

    for (const pid of ['301', '302', '303', '304', '305']) {
      expect(log).not.toContain(`taskpolicy -b -p ${pid}`)
      expect(governorLog).not.toContain(`screen-background pid=${pid}`)
    }
  }, governorTestTimeout)

  test('does not throttle protected Figma processes automatically', () => {
    const { log, governorLog } = runGovernor(
      ['--once'],
      [],
      [],
      {
        actionProcessFixture: [
          '407\t1\t55.0\t/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
          '33508\t1\t80.0\t/Applications/Figma.app/Contents/MacOS/Figma',
          '33523\t33508\t70.0\t/Applications/Figma.app/Contents/Frameworks/Figma Helper (Renderer).app/Contents/MacOS/Figma Helper (Renderer)',
        ].join('\n') + '\n',
        windowserverCpu: '55',
      },
    )

    expect(log).not.toContain('taskpolicy -b -p 33508')
    expect(log).not.toContain('taskpolicy -b -p 33523')
    expect(governorLog).not.toContain('screen-background pid=33508')
    expect(governorLog).not.toContain('screen-background pid=33523')
  }, governorTestTimeout)

  test('restores screen helper priority after WindowServer recovers', () => {
    const { log, governorLog, status } = runGovernor(
      ['--once'],
      [],
      [],
      {
        actionProcessFixture: [
          '407\t1\t8.0\t/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
          '301\t1\t5.0\t/Applications/DisplayLink Manager.app/Contents/MacOS/DisplayLinkUserAgent',
          '302\t1\t4.0\t/System/Library/Frameworks/VideoToolbox.framework/Versions/A/XPCServices/VTEncoderXPCService.xpc/Contents/MacOS/VTEncoderXPCService',
        ].join('\n') + '\n',
        windowserverCpu: '8',
      },
    )

    expect(log).toContain('taskpolicy -B -p 301')
    expect(log).toContain('taskpolicy -B -p 302')
    expect(governorLog).toContain('screen-foreground pid=301')
    expect(JSON.parse(status).last_actions.some((action: string) => action.includes('screen-foreground pid=301'))).toBe(true)
  }, governorTestTimeout)

  test('restores screen helper priority once WindowServer is below the high threshold', () => {
    const { log, governorLog } = runGovernor(
      ['--once'],
      [],
      [],
      {
        actionProcessFixture: [
          '407\t1\t18.0\t/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
          '301\t1\t5.0\t/Applications/DisplayLink Manager.app/Contents/MacOS/DisplayLinkUserAgent',
        ].join('\n') + '\n',
        windowserverCpu: '18',
      },
    )

    expect(log).toContain('taskpolicy -B -p 301')
    expect(governorLog).toContain('screen-foreground pid=301')
  }, governorTestTimeout)

  test('terminates cbridge-owned home-wide search but only observes unrelated search', () => {
    const { governorLog, status } = runGovernor(
      ['--once'],
      [{ session: 'cbridge-leaders-main', window: 'A', id: '%leader4', pid: '200', room: 'LEADER-4' }],
      ['cbridge-leaders-main'],
      {
        actionProcessFixture: [
          '200\t100\t3.0\t/Users/wjh/.local/bin/codex resume 019 --model gpt-5.5 -c mcp_servers.codex-bridge.env.CODEX_BRIDGE_ROOM="LEADER-4"',
          '300\t200\t45.0\tfind /Users/wjh -name CBR-1.task-state.md -print',
          '301\t1\t44.0\tfind /Users/wjh -name Photos -print',
          '302\t1\t43.0\trg TODO /Users/wjh/specific-repo',
        ].join('\n') + '\n',
      },
    )

    expect(governorLog).toContain('heavy-search-terminated pid=300')
    expect(governorLog).toContain('heavy-search-observed pid=301')
    expect(governorLog).not.toContain('heavy-search-terminated pid=301')
    expect(governorLog).not.toContain('heavy-search-terminated pid=302')
    const actions = JSON.parse(status).last_actions as string[]
    expect(actions.some((action) => action.includes('heavy-search-terminated pid=300'))).toBe(true)
  }, governorTestTimeout)
})
