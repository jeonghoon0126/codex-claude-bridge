import AppKit
import ApplicationServices
import Foundation

private let terminalBundleIdentifier = "com.apple.Terminal"
private let returnKeyCodes: Set<Int64> = [36, 76]
private let vKeyCode: Int64 = 9
private let roomKeyCodes: [Int64: String] = [18: "A", 19: "B", 20: "C", 21: "D"]
private let supportedRooms = Set(["A", "B", "C", "D"])
private let imageExtensions = Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic", "avif"])
private let activeRoomRefreshInterval: TimeInterval = 8

private final class CbridgeTerminalInputHelper {
  private let tmuxPath: String
  private let bridgeDir: String
  private let activeWindowsPath: String
  private var cachedRoom: (room: String, expiresAt: Date)?
  private var lastActiveRoom: String?
  private var activeRoomMonitor: DispatchSourceTimer?

  init(tmuxPath: String, bridgeDir: String) {
    self.tmuxPath = tmuxPath
    self.bridgeDir = bridgeDir
    self.activeWindowsPath = "\(NSHomeDirectory())/.codex-claude-bridge/active-leader-windows"
  }

  func handleCommandReturn() -> Bool {
    guard let room = activeCbridgeRoom() else { return false }
    markActiveRoom(room)
    resumeRoom(room)
    return pasteIntoRoom(room, text: "\n")
  }

  func handleCommandV() -> Bool {
    guard let room = activeCbridgeRoom() else { return false }
    guard let imagePath = clipboardImagePath() else { return false }
    markActiveRoom(room)
    resumeRoom(room)
    let pasted = pasteIntoRoom(room, text: "\n/image \(imagePath)\n")
    if pasted {
      showImagePasteFeedback(room: room, path: imagePath)
    }
    return pasted
  }

  func handleCommandNumber(keyCode: Int64) -> Bool {
    guard let room = roomKeyCodes[keyCode] else { return false }
    guard activeCbridgeRoom() != nil else { return false }
    guard focusCbridgeRoom(room) else { return false }
    cachedRoom = (room, Date().addingTimeInterval(0.25))
    markActiveRoom(room)
    resumeRoom(room)
    return true
  }

  func startActiveRoomMonitor() {
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    timer.schedule(deadline: .now() + activeRoomRefreshInterval, repeating: activeRoomRefreshInterval)
    timer.setEventHandler { [weak self] in
      guard let self, let room = self.activeCbridgeRoom() else { return }
      self.markActiveRoom(room)
    }
    timer.resume()
    activeRoomMonitor = timer
  }

  private func activeCbridgeRoom() -> String? {
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == terminalBundleIdentifier else { return nil }

    if let cached = cachedRoom, cached.expiresAt > Date() {
      return cached.room
    }

    let script = """
    tell application "System Events"
      if not (exists process "Terminal") then return ""
    end tell
    tell application "Terminal"
      if (count of windows) is 0 then return ""
      try
        set activeTab to selected tab of front window
        set customTitle to ""
        set tabName to ""
        try
          set customTitle to custom title of activeTab as text
        end try
        try
          set tabName to name of activeTab as text
        end try
        return customTitle & linefeed & tabName
      on error
        return ""
      end try
    end tell
    """

    let titleText = runProcess("/usr/bin/osascript", args: ["-e", script]).stdout
    for line in titleText.split(separator: "\n").map(String.init) {
      if let room = parseRoom(from: line) {
        cachedRoom = (room, Date().addingTimeInterval(0.25))
        markActiveRoom(room)
        return room
      }
    }
    return nil
  }

  private func parseRoom(from title: String) -> String? {
    guard title.hasPrefix("cbridge ") else { return nil }
    let suffix = title.dropFirst("cbridge ".count)
    guard let room = suffix.first.map(String.init), supportedRooms.contains(room) else { return nil }
    return room
  }

  private func clipboardImagePath() -> String? {
    let pasteboard = NSPasteboard.general

    if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
      for url in urls where isImagePath(url.path) {
        return url.path
      }
    }

    if let png = pasteboard.data(forType: .png), let path = writeClipboardData(png, extension: "png") {
      return path
    }

    if let tiff = pasteboard.data(forType: .tiff),
       let bitmap = NSBitmapImageRep(data: tiff),
       let png = bitmap.representation(using: .png, properties: [:]),
       let path = writeClipboardData(png, extension: "png") {
      return path
    }

    if let image = NSImage(pasteboard: pasteboard),
       let tiff = image.tiffRepresentation,
       let bitmap = NSBitmapImageRep(data: tiff),
       let png = bitmap.representation(using: .png, properties: [:]),
       let path = writeClipboardData(png, extension: "png") {
      return path
    }

    return nil
  }

  private func isImagePath(_ path: String) -> Bool {
    let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
    return imageExtensions.contains(ext)
  }

  private func writeClipboardData(_ data: Data, extension ext: String) -> String? {
    let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("cbridge-compose", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let path = directory.appendingPathComponent("clipboard-\(Int(Date().timeIntervalSince1970 * 1000))-\(getpid()).\(ext)")
      try data.write(to: path, options: .atomic)
      return path.path
    } catch {
      return nil
    }
  }

  private func pasteIntoRoom(_ room: String, text: String) -> Bool {
    guard let target = targetForRoom(room) else { return false }
    let buffer = "cbridge-terminal-input-\(getpid())-\(Int(Date().timeIntervalSince1970 * 1000))"
    guard runProcess(tmuxPath, args: ["load-buffer", "-b", buffer, "-"], input: text).status == 0 else {
      return false
    }
    let pasted = runProcess(tmuxPath, args: ["paste-buffer", "-t", target, "-b", buffer, "-p"]).status == 0
    _ = runProcess(tmuxPath, args: ["delete-buffer", "-b", buffer])
    return pasted
  }

  private func focusCbridgeRoom(_ room: String) -> Bool {
    let title = "cbridge \(room)"
    let script = """
    on run argv
      set targetTitle to item 1 of argv
      tell application "System Events"
        if not (exists process "Terminal") then return "0"
      end tell
      tell application "Terminal"
        repeat with w in windows
          repeat with t in tabs of w
            set customTitle to ""
            set tabName to ""
            try
              set customTitle to custom title of t as text
            end try
            try
              set tabName to name of t as text
            end try
            if customTitle starts with targetTitle or tabName starts with targetTitle then
              set selected tab of w to t
              set index of w to 1
              activate
              return "1"
            end if
          end repeat
        end repeat
      end tell
      return "0"
    end run
    """
    return runProcess("/usr/bin/osascript", args: ["-", title], input: script).stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "1"
  }

  private func markActiveRoom(_ room: String) {
    guard supportedRooms.contains(room), lastActiveRoom != room else { return }
    lastActiveRoom = room
    do {
      let directory = URL(fileURLWithPath: activeWindowsPath).deletingLastPathComponent()
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try "\(room)\n".write(toFile: activeWindowsPath, atomically: true, encoding: .utf8)
    } catch {}
  }

  private func resumeRoom(_ room: String) {
    let script = "\(bridgeDir)/scripts/cbridge-load-governor"
    guard FileManager.default.isExecutableFile(atPath: script) else { return }
    _ = runProcess(tmuxPath, args: ["run-shell", "-b", "\(shellQuote(script)) --resume-window \(room)"])
  }

  private func showImagePasteFeedback(room: String, path: String) {
    if let target = targetForRoom(room) {
      let filename = URL(fileURLWithPath: path).lastPathComponent
      _ = runProcess(tmuxPath, args: ["display-message", "-t", target, "이미지 첨부됨: \(filename)"])
    }

    let notificationScript = """
    display notification \(appleScriptString(URL(fileURLWithPath: path).lastPathComponent)) with title "Cbridge" subtitle "이미지 첨부됨"
    """
    _ = runProcess("/usr/bin/osascript", args: ["-e", notificationScript])
  }

  private func targetForRoom(_ room: String) -> String? {
    let candidates = [
      "cbridge-leaders-tab-\(room):\(room)",
      "cbridge-leaders-main:\(room)",
    ]
    for target in candidates {
      if runProcess(tmuxPath, args: ["display-message", "-p", "-t", target, "#{pane_id}"]).status == 0 {
        return target
      }
    }
    return nil
  }

  private func shellQuote(_ value: String) -> String {
    "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
  }

  private func appleScriptString(_ value: String) -> String {
    "\"\(value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\""
  }

  private func runProcess(_ executable: String, args: [String], input: String? = nil) -> (status: Int32, stdout: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = args

    let stdout = Pipe()
    process.standardOutput = stdout
    process.standardError = Pipe()

    if let input {
      let stdin = Pipe()
      process.standardInput = stdin
      do {
        try process.run()
        stdin.fileHandleForWriting.write(Data(input.utf8))
        try stdin.fileHandleForWriting.close()
        process.waitUntilExit()
      } catch {
        return (1, "")
      }
    } else {
      do {
        try process.run()
        process.waitUntilExit()
      } catch {
        return (1, "")
      }
    }

    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
  }
}

private var eventTap: CFMachPort?

private func callback(
  proxy: CGEventTapProxy,
  type: CGEventType,
  event: CGEvent,
  refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let eventTap {
      CGEvent.tapEnable(tap: eventTap, enable: true)
    }
    return Unmanaged.passUnretained(event)
  }

  guard type == .keyDown, let refcon else {
    return Unmanaged.passUnretained(event)
  }

  let flags = event.flags
  guard flags.contains(.maskCommand) else {
    return Unmanaged.passUnretained(event)
  }

  let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
  let helper = Unmanaged<CbridgeTerminalInputHelper>.fromOpaque(refcon).takeUnretainedValue()

  if returnKeyCodes.contains(keyCode), helper.handleCommandReturn() {
    return nil
  }

  if keyCode == vKeyCode, helper.handleCommandV() {
    return nil
  }

  if helper.handleCommandNumber(keyCode: keyCode) {
    return nil
  }

  return Unmanaged.passUnretained(event)
}

private func main() -> Int32 {
  let args = CommandLine.arguments
  guard args.count >= 3, args[1] == "--run" else {
    fputs("usage: cbridge-terminal-input-helper --run /path/to/tmux\n", stderr)
    return 64
  }

  let trusted = AXIsProcessTrustedWithOptions([
    kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
  ] as CFDictionary)
  guard trusted else {
    fputs("Terminal input helper needs macOS Accessibility permission.\n", stderr)
    return 2
  }

  var bridgeDir = "\(NSHomeDirectory())/codex-claude-bridge"
  var index = 3
  while index < args.count {
    if args[index] == "--bridge-dir", index + 1 < args.count {
      bridgeDir = args[index + 1]
      index += 2
    } else {
      index += 1
    }
  }

  let helper = CbridgeTerminalInputHelper(tmuxPath: args[2], bridgeDir: bridgeDir)
  helper.startActiveRoomMonitor()
  let userInfo = UnsafeMutableRawPointer(Unmanaged.passRetained(helper).toOpaque())
  let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
  eventTap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: mask,
    callback: callback,
    userInfo: userInfo
  )

  guard let eventTap else {
    fputs("Could not create Terminal input event tap.\n", stderr)
    return 2
  }

  let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
  CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
  CGEvent.tapEnable(tap: eventTap, enable: true)
  CFRunLoopRun()
  return 0
}

exit(main())
