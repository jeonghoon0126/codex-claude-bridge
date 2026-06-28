import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type FakePane = {
  id: string
  left: number
  top: number
  room?: string
  headerFor?: string
  titleHeader?: string
}

const layoutScript = new URL('../scripts/cbridge-tmux-layout', import.meta.url).pathname

function panesWithHeaders(
  bodyPositions: Array<{ id: string; left: number; bodyTop: number; headerTop: number; room: string }>,
): FakePane[] {
  return bodyPositions.flatMap(({ id, left, bodyTop, headerTop, room }) => [
    { id: `%10${id.slice(1)}`, left, top: headerTop, headerFor: id, titleHeader: '1' },
    { id, left, top: bodyTop, room },
  ])
}

function fakeTmuxScript(): string {
  return `#!/usr/bin/env bun
const panes = JSON.parse(process.env.FAKE_TMUX_PANES || '[]')
const logPath = process.env.FAKE_TMUX_LOG
const width = process.env.FAKE_TMUX_WIDTH || '120'
const height = process.env.FAKE_TMUX_HEIGHT || '40'
const args = Bun.argv.slice(2)

function pane(target) {
  return panes.find(p => p.id === target) || {}
}

function formatPane(p, format) {
  if (format === '#{pane_id}') return p.id
  if (format === '#{pane_id}|#{@cbridge_room}|#{@cbridge_header_for}|#{@cbridge_sidecar_peer}') {
    return [p.id, p.room || '', p.headerFor || '', ''].join('|')
  }
  if (format === '#{pane_id}|#{pane_left}|#{pane_top}|#{@cbridge_header_for}|#{@cbridge_room}|#{@cbridge_sidecar_peer}|#{@cbridge_sidecar_leader}|#{@cbridge_sidecar_origin}|#{@cbridge_sidecar_created}|#{@cbridge_sidecar_position}|#{@cbridge_restore_order}') {
    return [p.id, p.left, p.top, p.headerFor || '', p.room || '', '', '', '', '', '', ''].join('|')
  }
  if (format === '#{pane_id}|#{@cbridge_header_for}|#{@cbridge_title_header}') {
    return [p.id, p.headerFor || '', p.titleHeader || ''].join('|')
  }
  return ''
}

if (args[0] === 'display-message') {
  if (args.includes('-p')) {
    const format = args[args.length - 1]
    const targetIndex = args.indexOf('-t')
    const target = targetIndex >= 0 ? args[targetIndex + 1] : ''
    if (format === '#{session_name}') console.log('cbridge-leaders-main')
    else if (format === '#{window_width}') console.log(width)
    else if (format === '#{window_height}') console.log(height)
    else if (format === '#{@cbridge_header_for}') console.log(pane(target).headerFor || '')
    else console.log('')
  }
  process.exit(0)
}

if (args[0] === 'list-panes') {
  const format = args[args.indexOf('-F') + 1]
  console.log(panes.map(p => formatPane(p, format)).join('\\n'))
  process.exit(0)
}

if (args[0] === 'select-layout') {
  await Bun.write(logPath, args[args.length - 1] + '\\n')
  process.exit(0)
}

process.exit(0)
`
}

function runLayout(layout: string, panes: FakePane[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cbridge-layout-'))
  try {
    const fakeTmux = join(dir, 'tmux')
    const logPath = join(dir, 'tmux.log')
    writeFileSync(fakeTmux, fakeTmuxScript())
    writeFileSync(logPath, '')
    chmodSync(fakeTmux, 0o755)

    const result = spawnSync('zsh', [layoutScript, layout, 'cbridge-leaders-main:0', '%1'], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CBRIDGE_LAYOUT_QUIET: '1',
        FAKE_TMUX_LOG: logPath,
        FAKE_TMUX_PANES: JSON.stringify(panes),
        FAKE_TMUX_WIDTH: '120',
        FAKE_TMUX_HEIGHT: '40',
      },
    })

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    return readFileSync(logPath, 'utf8').trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('cbridge tmux equal layout', () => {
  test('keeps the current four-column row when equalizing', () => {
    const layout = runLayout('equal', panesWithHeaders([
      { id: '%1', left: 0, bodyTop: 3, headerTop: 0, room: 'LEADER-1' },
      { id: '%2', left: 30, bodyTop: 3, headerTop: 0, room: 'LEADER-2' },
      { id: '%3', left: 60, bodyTop: 3, headerTop: 0, room: 'LEADER-3' },
      { id: '%4', left: 90, bodyTop: 3, headerTop: 0, room: 'LEADER-4' },
    ]))

    expect(layout).toContain('120x40,0,0{')
    expect(layout).not.toContain('120x40,0,0[')
    expect(layout).toContain('30x40,0,0[')
    expect(layout).toContain('29x40,91,0[')
  })

  test('keeps uneven row counts instead of flattening them', () => {
    const layout = runLayout('equal', panesWithHeaders([
      { id: '%1', left: 0, bodyTop: 3, headerTop: 0, room: 'LEADER-1' },
      { id: '%2', left: 60, bodyTop: 3, headerTop: 0, room: 'LEADER-2' },
      { id: '%3', left: 0, bodyTop: 24, headerTop: 21, room: 'LEADER-3' },
    ]))

    expect(layout).toContain('120x40,0,0[')
    expect(layout).toContain('120x20,0,0{')
    expect(layout).toContain('120x19,0,21[')
  })

  test('keeps explicit 2x2 as a structure-changing command', () => {
    const layout = runLayout('2x2', panesWithHeaders([
      { id: '%1', left: 0, bodyTop: 3, headerTop: 0, room: 'LEADER-1' },
      { id: '%2', left: 30, bodyTop: 3, headerTop: 0, room: 'LEADER-2' },
      { id: '%3', left: 60, bodyTop: 3, headerTop: 0, room: 'LEADER-3' },
      { id: '%4', left: 90, bodyTop: 3, headerTop: 0, room: 'LEADER-4' },
    ]))

    expect(layout).toContain('120x40,0,0{')
    expect(layout).toContain('60x40,0,0[')
    expect(layout).toContain('59x40,61,0[')
  })
})
