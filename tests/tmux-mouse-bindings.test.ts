import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import {
  nativeWheelDownCommand,
  nativeWheelUpCommand,
  routedWheelDownCommand,
  routedWheelUpCommand,
} from '../tmux-mouse-bindings.ts'

describe('tmux mouse wheel bindings', () => {
  const quote = (value: string) => `'${value}'`
  const leaderSessionCondition = '#{m/r:^cbridge-leaders-,#{session_name}}'

  test('keeps leader body wheel-up on tmux native commands', () => {
    const command = routedWheelUpCommand({
      headerWheelCommand: 'run-shell /tmp/cbridge-mouse wheel-up',
      leaderSessionCondition,
      quote,
    })

    expect(command).toContain(nativeWheelUpCommand())
    expect(command).toContain(`if-shell -F "${leaderSessionCondition}"`)
    expect(command.match(/run-shell/g)?.length).toBe(1)
  })

  test('keeps leader body wheel-down on tmux native commands', () => {
    const command = routedWheelDownCommand({
      headerWheelCommand: 'run-shell /tmp/cbridge-mouse wheel-down',
      leaderSessionCondition,
      quote,
    })

    expect(command).toContain(nativeWheelDownCommand())
    expect(command).toContain(`if-shell -F "${leaderSessionCondition}"`)
    expect(command.match(/run-shell/g)?.length).toBe(1)
  })

  test('uses external routing only for title header panes', () => {
    const command = routedWheelUpCommand({
      headerWheelCommand: 'run-shell /tmp/cbridge-mouse wheel-up',
      leaderSessionCondition,
      quote,
    })

    expect(command).toStartWith('if-shell -F "#{@cbridge_header_for}" \'run-shell /tmp/cbridge-mouse wheel-up\'')
  })

  test('keeps leader left-click on the tmux native path after resume', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')

    expect(source).toContain('resumeLeaderWindowCommand')
    expect(source).toContain('--resume-window "#{window_name}"')
    expect(source).toContain('select-pane -t = ; send-keys -M')
    expect(source).toContain("const defaultMouseDownPaneCommand = tmuxDoubleQuote('select-pane -t = ; send-keys -M')")
    expect(source).toContain("const defaultMouseDownBorderCommand = tmuxDoubleQuote('select-pane -t =')")
    expect(source).toContain("tmux(['unbind-key', '-T', 'root', 'MouseUp1Pane'])")

    const clickBindingsStart = source.indexOf('tmuxScript([')
    const clickBindingsEnd = source.indexOf("`bind-key -T root MouseDrag1Pane", clickBindingsStart)
    const clickBindings = source.slice(clickBindingsStart, clickBindingsEnd)

    expect(clickBindings).not.toContain('cbridge-mouse ack')
    expect(clickBindings).not.toContain('@cbridge_ack_click')
  })

  test('puts compose and new at the top of the leader right-click menu', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')
    const menuStart = source.indexOf('const leaderMenuItems = [')
    const menuEnd = source.indexOf('].join', menuStart)
    const menuSource = source.slice(menuStart, menuEnd)

    expect(source).toContain('scripts/cbridge-compose "#{pane_id}" "#{@cbridge_header_for}"')
    expect(source).toContain('bind-key m if-shell')
    expect(source).toContain("const newThreadCommand = 'select-pane -t = \\\\; send-keys -t = /new Enter'")
    expect(menuSource).toContain("tmuxDoubleQuote('메시지 작성')")
    expect(menuSource).toContain("tmuxDoubleQuote('new')")
    expect(menuSource.indexOf("tmuxDoubleQuote('메시지 작성')")).toBeLessThan(
      menuSource.indexOf("tmuxDoubleQuote('new')"),
    )
    expect(menuSource.indexOf("tmuxDoubleQuote('new')")).toBeLessThan(
      menuSource.indexOf("tmuxDoubleQuote('균등 정렬')"),
    )
  })

  test('opens the leader right-click menu from mouse-down after the release window', () => {
    const source = readFileSync(new URL('../covering-bridge.ts', import.meta.url), 'utf8')

    expect(source).toContain("'display-menu',\n    '-O',")
    expect(source).toContain('function tmuxMenuWithItems')
    expect(source).toContain('const leaderMenu = tmuxMenuWithItems(leaderMenuItems)')
    expect(source).not.toContain('const leaderMenu = prependTmuxMenuItems(defaultPaneMenu, leaderMenuItems)')
    expect(source).toContain('function openTmuxMenuAfterRightClick')
    expect(source).toContain('captureRightClickTmuxMenuTarget()')
    expect(source).toContain('display-menu -M -c #{@cbridge_right_click_client}')
    expect(source).toContain('run-shell -b -d 0.16 -C')
    expect(source).toContain('set-option -Fgq @cbridge_right_click_client "#{client_tty}"')
    expect(source).toContain('.replace(/\\s-t\\s*=/g')
    expect(source).toContain('-t #{@cbridge_right_click_pane}')
    expect(source).toContain('-x #{@cbridge_right_click_x} -y #{@cbridge_right_click_y}')
    expect(source).toContain("'MouseDown3Pane'")
    expect(source).toContain("'MouseDown3Border'")
    expect(source).toContain("tmux(['unbind-key', '-T', 'root', 'MouseUp3Pane'])")
    expect(source).toContain("tmux(['unbind-key', '-T', 'root', 'MouseUp3Border'])")
    expect(source).toContain("tmux(['unbind-key', '-T', 'root', 'MouseDragEnd3Pane'])")
    expect(source).toContain("tmux(['unbind-key', '-T', 'root', 'MouseDragEnd3Border'])")

    const mouseDownPaneStart = source.indexOf("'MouseDown3Pane'")
    const mouseDownBorderStart = source.indexOf("'MouseDown3Border'")
    const mouseDownPaneSource = source.slice(mouseDownPaneStart, mouseDownBorderStart)

    expect(mouseDownPaneSource).not.toContain('leaderMenu,')
    expect(mouseDownPaneSource).toContain('leaderMenuAfterRightClick')
    expect(mouseDownPaneSource).toContain('defaultPaneMenu')
  })
})
