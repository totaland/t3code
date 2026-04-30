import ApplicationServices
import CoreGraphics
import Foundation

private var isPushToTalkActive = false
private var eventTapPort: CFMachPort?

private func writeLine(_ value: String) {
  if let data = "\(value)\n".data(using: .utf8) {
    FileHandle.standardOutput.write(data)
  }
  fflush(stdout)
}

private func hasPushToTalkModifiers(_ flags: CGEventFlags) -> Bool {
  flags.contains(.maskControl)
    && flags.contains(.maskAlternate)
    && !flags.contains(.maskCommand)
}

private func syncPushToTalkState(_ flags: CGEventFlags) {
  let nextActive = hasPushToTalkModifiers(flags)
  if nextActive == isPushToTalkActive {
    return
  }

  isPushToTalkActive = nextActive
  writeLine(nextActive ? "start" : "stop")
}

private let eventCallback: CGEventTapCallBack = { proxy, type, event, refcon in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let eventTapPort {
      CGEvent.tapEnable(tap: eventTapPort, enable: true)
    }
    return Unmanaged.passUnretained(event)
  }

  if type == .flagsChanged {
    syncPushToTalkState(event.flags)
  }

  return Unmanaged.passUnretained(event)
}

let accessibilityOptions = [
  kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
] as CFDictionary

if !AXIsProcessTrustedWithOptions(accessibilityOptions) {
  writeLine("permission-required")
  for _ in 0..<120 {
    Thread.sleep(forTimeInterval: 1)
    if AXIsProcessTrusted() {
      writeLine("permission-granted")
      break
    }
  }
}

if !AXIsProcessTrusted() {
  writeLine("permission-timeout")
  exit(2)
}

let eventMask = (1 << CGEventType.flagsChanged.rawValue)
let tap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: CGEventMask(eventMask),
  callback: eventCallback,
  userInfo: nil
)

guard let eventTap = tap else {
  writeLine("tap-unavailable")
  exit(3)
}

eventTapPort = eventTap
let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)
writeLine("ready")
CFRunLoopRun()
