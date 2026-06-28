type QuoteCommand = (value: string) => string

const MOUSE_TARGET = '='

export function nativeWheelUpCommand(target = MOUSE_TARGET): string {
  return [
    `select-pane -t ${target}`,
    `copy-mode -e -t ${target}`,
    `send-keys -t ${target} -X -N 3 scroll-up`,
    `if-shell -F -t ${target} "#{==:#{scroll_position},0}" "send-keys -t ${target} -X cancel"`,
  ].join(' ; ')
}

export function nativeWheelDownCommand(target = MOUSE_TARGET): string {
  return [
    `select-pane -t ${target}`,
    `if-shell -F -t ${target} "#{pane_in_mode}" "send-keys -t ${target} -X -N 3 scroll-down ; if-shell -F -t ${target} \\"#{==:#{scroll_position},0}\\" \\"send-keys -t ${target} -X cancel\\""`,
  ].join(' ; ')
}

export function genericWheelUpCommand(): string {
  return 'if-shell -F "#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -e"'
}

export function genericWheelDownCommand(): string {
  return 'send-keys -M'
}

type RoutedWheelCommandOptions = {
  headerWheelCommand: string
  leaderSessionCondition: string
  quote: QuoteCommand
}

function routedWheelCommand(
  nativeCommand: string,
  fallbackCommand: string,
  { headerWheelCommand, leaderSessionCondition, quote }: RoutedWheelCommandOptions,
): string {
  const leaderBodyCommand = `if-shell -F "${leaderSessionCondition}" ${quote(nativeCommand)} ${quote(fallbackCommand)}`
  return `if-shell -F "#{@cbridge_header_for}" ${quote(headerWheelCommand)} ${quote(leaderBodyCommand)}`
}

export function routedWheelUpCommand(options: RoutedWheelCommandOptions): string {
  return routedWheelCommand(nativeWheelUpCommand(), genericWheelUpCommand(), options)
}

export function routedWheelDownCommand(options: RoutedWheelCommandOptions): string {
  return routedWheelCommand(nativeWheelDownCommand(), genericWheelDownCommand(), options)
}
