// nexus-mac: NEXUS's bridge to macOS desktop apps.
//
// Speaks newline-delimited JSON on stdin/stdout, shaped like CDP:
//   request  {"id": 1, "method": "tree", "params": {...}}
//   response {"id": 1, "result": {...}}  or  {"id": 1, "error": {"code": -1, "message": "..."}}
//   event    {"method": "recorded", "params": {...}}
//
// Reads apps through the macOS Accessibility API (the desktop equivalent of a
// DOM), acts on elements, and sends real mouse/keyboard input via CGEvent.
// Needs the Accessibility permission (and Screen Recording for screenshots,
// Input Monitoring for recording) for the app that launches it.

import AppKit
import ApplicationServices
import Foundation

// MARK: - Output

let output = FileHandle.standardOutput
let outputLock = NSLock()

func send(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]) else { return }
  outputLock.lock()
  output.write(data)
  output.write("\n".data(using: .utf8)!)
  outputLock.unlock()
}

struct HelperError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

// MARK: - Element registry
// AXUIElement handles cannot be serialized, so each `tree` call hands out
// integer refs. Refs from an earlier tree of the same app become stale.

var elements: [Int: AXUIElement] = [:]
var nextRef = 1

func register(_ element: AXUIElement) -> Int {
  let ref = nextRef
  nextRef += 1
  elements[ref] = element
  return ref
}

func element(_ params: [String: Any]) throws -> AXUIElement {
  guard let ref = params["ref"] as? Int, let found = elements[ref] else {
    throw HelperError("Unknown or stale element ref; take a new tree first")
  }
  return found
}

// MARK: - Attribute helpers

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func string(_ value: AnyObject?) -> String? {
  if let text = value as? String { return text.isEmpty ? nil : text }
  if let number = value as? NSNumber { return number.stringValue }
  if let url = value as? URL { return url.absoluteString }
  return nil
}

func frame(_ element: AXUIElement) -> [String: Double]? {
  var position = CGPoint.zero
  var size = CGSize.zero
  guard let positionValue = attribute(element, kAXPositionAttribute), let sizeValue = attribute(element, kAXSizeAttribute) else { return nil }
  AXValueGetValue(positionValue as! AXValue, .cgPoint, &position)
  AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
  return ["x": Double(position.x), "y": Double(position.y), "width": Double(size.width), "height": Double(size.height)]
}

func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
  return list
}

func isSecure(_ element: AXUIElement) -> Bool {
  return (attribute(element, kAXSubroleAttribute) as? String) == "AXSecureTextField"
}

/// Everything NEXUS needs to match and act on one element. Secure text
/// fields never report their value: passwords do not leave this process.
func describe(_ element: AXUIElement) -> [String: Any] {
  var node: [String: Any] = [:]
  node["role"] = (attribute(element, kAXRoleAttribute) as? String) ?? "AXUnknown"
  if let subrole = attribute(element, kAXSubroleAttribute) as? String { node["subrole"] = subrole }
  if let title = string(attribute(element, kAXTitleAttribute)) { node["title"] = title }
  if let description = string(attribute(element, kAXDescriptionAttribute)) { node["description"] = description }
  if let help = string(attribute(element, kAXHelpAttribute)) { node["help"] = help }
  if let identifier = string(attribute(element, kAXIdentifierAttribute)) { node["identifier"] = identifier }
  if let placeholder = string(attribute(element, kAXPlaceholderValueAttribute)) { node["placeholder"] = placeholder }
  if isSecure(element) {
    node["secure"] = true
  } else if let value = string(attribute(element, kAXValueAttribute)) {
    node["value"] = String(value.prefix(500))
  }
  if let enabled = attribute(element, kAXEnabledAttribute) as? Bool { node["enabled"] = enabled }
  if let focused = attribute(element, kAXFocusedAttribute) as? Bool, focused { node["focused"] = true }
  if let box = frame(element) { node["frame"] = box }
  let names = actions(element)
  if !names.isEmpty { node["actions"] = names }
  return node
}

// MARK: - Apps

func appInfo(_ app: NSRunningApplication) -> [String: Any] {
  var info: [String: Any] = ["pid": Int(app.processIdentifier), "active": app.isActive]
  if let name = app.localizedName { info["name"] = name }
  if let bundle = app.bundleIdentifier { info["bundleId"] = bundle }
  return info
}

func regularApps() -> [NSRunningApplication] {
  return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
}

/// Apps this helper launched, by name / bundle id / path, so they can be found
/// by pid even before NSWorkspace's list has caught up.
var launchedApps: [String: pid_t] = [:]

/// Finds a running app by name ("Notes"), bundle id ("com.apple.Notes"), .app path or pid.
func findApp(_ params: [String: Any]) throws -> NSRunningApplication {
  if let pid = params["pid"] as? Int, let app = NSRunningApplication(processIdentifier: pid_t(pid)) { return app }
  guard let query = params["app"] as? String else { throw HelperError("Expected an app name, bundle id or pid") }
  let lower = query.lowercased()
  let apps = regularApps()
  if let app = apps.first(where: { $0.bundleIdentifier?.lowercased() == lower }) { return app }
  if let app = apps.first(where: { $0.localizedName?.lowercased() == lower }) { return app }
  if let app = apps.first(where: { $0.bundleURL?.path == query }) { return app }
  if let pid = launchedApps[lower], let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated { return app }
  if query.contains("."), let app = NSRunningApplication.runningApplications(withBundleIdentifier: query).first(where: { !$0.isTerminated }) { return app }
  throw HelperError("\(query) is not running")
}

func rememberLaunch(_ app: NSRunningApplication, as query: String) {
  for key in [query, app.localizedName, app.bundleIdentifier, app.bundleURL?.path].compactMap({ $0 }) {
    launchedApps[key.lowercased()] = app.processIdentifier
  }
}

func applicationURL(_ query: String) -> URL? {
  if query.contains("."), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query) { return url }
  let name = query.hasSuffix(".app") ? query : "\(query).app"
  let folders = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
                 NSHomeDirectory() + "/Applications"]
  for folder in folders {
    let candidate = URL(fileURLWithPath: folder).appendingPathComponent(name)
    if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
  }
  if query.hasPrefix("/"), FileManager.default.fileExists(atPath: query) { return URL(fileURLWithPath: query) }
  return nil
}

func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if condition() { return true }
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
  }
  return condition()
}

/// Brings an app to the front. NSRunningApplication.activate is cooperative on
/// recent macOS and may be ignored for a background caller, so the
/// accessibility "frontmost" attribute is set as well.
func activate(_ app: NSRunningApplication) -> Bool {
  app.unhide()
  app.activate(options: [.activateAllWindows])
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetAttributeValue(axApp, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  return waitUntil(timeout: 3) { NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier }
}

// MARK: - Tree

func tree(_ params: [String: Any]) throws -> [String: Any] {
  let app = try findApp(params)
  let maxNodes = params["maxNodes"] as? Int ?? 3000
  let maxDepth = params["maxDepth"] as? Int ?? 40
  let includeMenus = params["menus"] as? Bool ?? false
  let root = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(root, 3)

  elements.removeAll(keepingCapacity: true)
  var nodes: [[String: Any]] = []
  var truncated = false

  func walk(_ element: AXUIElement, parent: Int, depth: Int) {
    if nodes.count >= maxNodes { truncated = true; return }
    let index = nodes.count
    var node = describe(element)
    if !includeMenus, node["role"] as? String == "AXMenuBar" { return }
    node["ref"] = register(element)
    node["parent"] = parent
    nodes.append(node)
    guard depth < maxDepth, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return }
    for child in children { walk(child, parent: index, depth: depth + 1) }
  }
  walk(root, parent: -1, depth: 0)
  return ["app": appInfo(app), "nodes": nodes, "truncated": truncated]
}

// MARK: - Input (real events)

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
  "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
  "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
  "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 117, "escape": 53,
  "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

let modifierFlags: [String: CGEventFlags] = [
  "command": .maskCommand, "cmd": .maskCommand, "meta": .maskCommand, "controlormeta": .maskCommand,
  "shift": .maskShift, "option": .maskAlternate, "alt": .maskAlternate, "control": .maskControl, "ctrl": .maskControl,
]

let eventSource = CGEventSource(stateID: .hidSystemState)

func post(_ event: CGEvent?) {
  event?.post(tap: .cghidEventTap)
}

func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, clickState: Int64 = 1) {
  let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  event?.setIntegerValueField(.mouseEventClickState, value: clickState)
  post(event)
}

func click(_ params: [String: Any]) throws -> [String: Any] {
  guard let x = params["x"] as? Double, let y = params["y"] as? Double else { throw HelperError("click needs x and y") }
  let point = CGPoint(x: x, y: y)
  let right = (params["button"] as? String) == "right"
  let count = max(1, params["count"] as? Int ?? 1)
  let button: CGMouseButton = right ? .right : .left
  mouse(.mouseMoved, point, button)
  usleep(30_000)
  for click in 1...count {
    mouse(right ? .rightMouseDown : .leftMouseDown, point, button, clickState: Int64(click))
    usleep(15_000)
    mouse(right ? .rightMouseUp : .leftMouseUp, point, button, clickState: Int64(click))
    usleep(30_000)
  }
  return [:]
}

func move(_ params: [String: Any]) throws -> [String: Any] {
  guard let x = params["x"] as? Double, let y = params["y"] as? Double else { throw HelperError("move needs x and y") }
  mouse(.mouseMoved, CGPoint(x: x, y: y), .left)
  return [:]
}

func typeText(_ params: [String: Any]) throws -> [String: Any] {
  guard let text = params["text"] as? String else { throw HelperError("type needs text") }
  for character in text {
    let units = Array(String(character).utf16)
    // Explicitly no modifiers: these events reuse key code 0 ("A"), so a Command
    // still considered held (e.g. right after Command+A) would turn every
    // character into a select-all.
    let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true)
    down?.flags = []
    down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    post(down)
    let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false)
    up?.flags = []
    up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    post(up)
    usleep(8_000)
  }
  return [:]
}

/// "Command+Shift+N", "Enter", "a"
func key(_ params: [String: Any]) throws -> [String: Any] {
  guard let combo = params["key"] as? String else { throw HelperError("key needs key") }
  var parts = combo.split(separator: "+", omittingEmptySubsequences: false).map { String($0) }
  if combo.hasSuffix("++") { parts = Array(parts.dropLast(2)) + ["+"] }
  let keyName = parts.removeLast().lowercased()
  var flags: CGEventFlags = []
  for part in parts {
    guard let flag = modifierFlags[part.lowercased()] else { throw HelperError("Unknown modifier \(part)") }
    flags.insert(flag)
  }
  guard let code = keyCodes[keyName] else { throw HelperError("Unknown key \(keyName)") }
  let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true)
  down?.flags = flags
  post(down)
  let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false)
  up?.flags = flags
  post(up)
  if !flags.isEmpty {
    // Release the modifiers, so the system does not consider them still held.
    let release = CGEvent(source: eventSource)
    release?.type = .flagsChanged
    release?.flags = []
    post(release)
    usleep(20_000)
  }
  return [:]
}

// MARK: - Recording

var recordTap: CFMachPort?
var recordSource: CFRunLoopSource?
var ignoredPids: Set<pid_t> = []
let systemWide = AXUIElementCreateSystemWide()

func appOf(_ element: AXUIElement) -> NSRunningApplication? {
  var pid: pid_t = 0
  guard AXUIElementGetPid(element, &pid) == .success else { return nil }
  return NSRunningApplication(processIdentifier: pid)
}

func elementAt(_ point: CGPoint) -> AXUIElement? {
  var found: AXUIElement?
  return AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &found) == .success ? found : nil
}

/// Called for every mouse-down and key-down while recording. The element under
/// the pointer is described *before* the click is processed, so a button that
/// changes or disappears still records what was clicked.
let recordCallback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let tap = recordTap { CGEvent.tapEnable(tap: tap, enable: true) }
    return Unmanaged.passUnretained(event)
  }
  var params: [String: Any] = ["time": Date().timeIntervalSince1970]
  switch type {
  case .leftMouseDown, .rightMouseDown:
    let point = event.location
    guard let target = elementAt(point), let app = appOf(target), !ignoredPids.contains(app.processIdentifier) else {
      return Unmanaged.passUnretained(event)
    }
    params["type"] = "click"
    params["x"] = Double(point.x)
    params["y"] = Double(point.y)
    params["button"] = type == .rightMouseDown ? "right" : "left"
    params["clickCount"] = Int(event.getIntegerValueField(.mouseEventClickState))
    params["element"] = describe(target)
    params["app"] = appInfo(app)
  case .keyDown:
    guard let front = NSWorkspace.shared.frontmostApplication, !ignoredPids.contains(front.processIdentifier) else {
      return Unmanaged.passUnretained(event)
    }
    params["type"] = "key"
    params["app"] = appInfo(front)
    params["keyCode"] = Int(event.getIntegerValueField(.keyboardEventKeycode))
    let flags = event.flags
    var modifiers: [String] = []
    if flags.contains(.maskCommand) { modifiers.append("Command") }
    if flags.contains(.maskControl) { modifiers.append("Control") }
    if flags.contains(.maskAlternate) { modifiers.append("Option") }
    if flags.contains(.maskShift) { modifiers.append("Shift") }
    params["modifiers"] = modifiers
    var focused: AnyObject?
    if AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &focused) == .success, let element = focused {
      let target = element as! AXUIElement
      params["element"] = describe(target)
      if isSecure(target) {
        params["secure"] = true // Never report what is typed into a password field.
        break
      }
    }
    var length = 0
    var chars = [UniChar](repeating: 0, count: 8)
    event.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &length, unicodeString: &chars)
    params["characters"] = String(utf16CodeUnits: chars, count: length)
  default:
    return Unmanaged.passUnretained(event)
  }
  send(["method": "recorded", "params": params])
  return Unmanaged.passUnretained(event)
}

func startRecording(_ params: [String: Any]) throws -> [String: Any] {
  if recordTap != nil { return [:] }
  ignoredPids = Set((params["ignorePids"] as? [Int] ?? []).map { pid_t($0) })
  let mask = (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.rightMouseDown.rawValue) | (1 << CGEventType.keyDown.rawValue)
  guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                    eventsOfInterest: CGEventMask(mask), callback: recordCallback, userInfo: nil) else {
    throw HelperError("Cannot watch input: grant Input Monitoring (System Settings → Privacy & Security) to the app running NEXUS")
  }
  recordTap = tap
  recordSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
  CFRunLoopAddSource(CFRunLoopGetMain(), recordSource, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  return [:]
}

func stopRecording() -> [String: Any] {
  if let tap = recordTap { CGEvent.tapEnable(tap: tap, enable: false) }
  if let source = recordSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
  recordTap = nil
  recordSource = nil
  return [:]
}

// MARK: - Dispatch

func handle(_ method: String, _ params: [String: Any]) throws -> Any {
  switch method {
  case "ping":
    return ["pid": Int(ProcessInfo.processInfo.processIdentifier)]
  case "permissions":
    return ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(),
            "inputMonitoring": CGPreflightListenEventAccess()]
  case "requestPermissions":
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let accessibility = AXIsProcessTrustedWithOptions(options)
    let screen = (params["screenRecording"] as? Bool ?? false) ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
    let input = (params["inputMonitoring"] as? Bool ?? false) ? CGRequestListenEventAccess() : CGPreflightListenEventAccess()
    return ["accessibility": accessibility, "screenRecording": screen, "inputMonitoring": input]
  case "apps":
    return ["apps": regularApps().map(appInfo), "frontmost": NSWorkspace.shared.frontmostApplication.map(appInfo) as Any]
  case "launch":
    guard let query = params["app"] as? String, let url = applicationURL(query) else {
      throw HelperError("No application named \(params["app"] ?? "?") in /Applications or /System/Applications")
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    var launched: NSRunningApplication?
    var failure: Error?
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
      launched = app
      failure = error
    }
    _ = waitUntil(timeout: 15) { launched != nil || failure != nil }
    if let failure { throw HelperError("Could not open \(query): \(failure.localizedDescription)") }
    guard var app = launched else { throw HelperError("\(query) did not finish launching") }
    _ = waitUntil(timeout: 15) { app.isFinishedLaunching || app.isTerminated }
    // A first launch of a newly built or downloaded app can be stopped by macOS's
    // checks; give it one more try through `open`, like a double-click.
    if waitUntil(timeout: 1, { app.isTerminated }) {
      let open = Process()
      open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      open.arguments = [url.path]
      try open.run()
      open.waitUntilExit()
      let bundle = Bundle(url: url)?.bundleIdentifier
      guard waitUntil(timeout: 10, { regularApps().contains { $0.bundleIdentifier == bundle && !$0.isTerminated } }),
            let relaunched = regularApps().first(where: { $0.bundleIdentifier == bundle }) else {
        throw HelperError("\(query) quit right after launching")
      }
      app = relaunched
      _ = waitUntil(timeout: 15) { app.isFinishedLaunching }
    }
    rememberLaunch(app, as: query)
    _ = activate(app)
    return appInfo(app)
  case "activate":
    let app = try findApp(params)
    return ["frontmost": activate(app)]
  case "quit":
    let app = try findApp(params)
    _ = app.terminate()
    // Wait until it is really gone, so a following launch starts a fresh instance.
    if !waitUntil(timeout: 5, { app.isTerminated }) { _ = app.forceTerminate() }
    return ["terminated": waitUntil(timeout: 3, { app.isTerminated })]
  case "tree":
    return try tree(params)
  case "describe":
    return describe(try element(params))
  case "window":
    let app = try findApp(params)
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var info = appInfo(app)
    if let window = attribute(axApp, kAXFocusedWindowAttribute) ?? attribute(axApp, kAXMainWindowAttribute) {
      info["title"] = string(attribute(window as! AXUIElement, kAXTitleAttribute)) ?? ""
    }
    return info
  case "focused":
    let app = try findApp(params)
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    guard let focused = attribute(axApp, kAXFocusedUIElementAttribute) else { return [:] }
    return describe(focused as! AXUIElement)
  case "press":
    let target = try element(params)
    let action = params["action"] as? String ?? kAXPressAction
    let result = AXUIElementPerformAction(target, action as CFString)
    if result != .success { throw HelperError("\(action) failed (AXError \(result.rawValue))") }
    return [:]
  case "setValue":
    let target = try element(params)
    guard let value = params["value"] as? String else { throw HelperError("setValue needs value") }
    let result = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value as CFString)
    if result != .success { throw HelperError("Setting the value failed (AXError \(result.rawValue))") }
    return [:]
  case "focus":
    let target = try element(params)
    let result = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if result != .success { throw HelperError("Focusing failed (AXError \(result.rawValue))") }
    return [:]
  case "elementAt":
    guard let x = params["x"] as? Double, let y = params["y"] as? Double else { throw HelperError("elementAt needs x and y") }
    guard let found = elementAt(CGPoint(x: x, y: y)) else { return [:] }
    var info = describe(found)
    if let app = appOf(found) { info["app"] = appInfo(app) }
    return info
  case "click":
    return try click(params)
  case "move":
    return try move(params)
  case "type":
    return try typeText(params)
  case "key":
    return try key(params)
  case "screenshot":
    guard let path = params["path"] as? String else { throw HelperError("screenshot needs path") }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", path]
    try process.run()
    process.waitUntilExit()
    if process.terminationStatus != 0 { throw HelperError("screencapture failed") }
    return ["path": path]
  case "startRecording":
    return try startRecording(params)
  case "stopRecording":
    return stopRecording()
  default:
    throw HelperError("Unknown method \(method)")
  }
}

// MARK: - Main loop

// Requests are read on a background thread and executed on the main thread,
// where the accessibility API, NSWorkspace and the event tap's run loop live.
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = message["id"] as? Int,
          let method = message["method"] as? String else { continue }
    let params = message["params"] as? [String: Any] ?? [:]
    DispatchQueue.main.async {
      do {
        send(["id": id, "result": try handle(method, params)])
      } catch let error as HelperError {
        send(["id": id, "error": ["code": -1, "message": error.message]])
      } catch {
        send(["id": id, "error": ["code": -1, "message": "\(error)"]])
      }
    }
  }
  // stdin closed: NEXUS went away. Exit after requests already queued have answered.
  DispatchQueue.main.async { exit(0) }
}

// A real (but invisible, Dock-less) AppKit event loop: NSWorkspace only keeps
// runningApplications current, and delivers app launch/quit updates, when the
// process runs as an application. A bare RunLoop does not get them.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
application.run()
