// NexusFixture: a small, predictable macOS app for NEXUS's desktop tests —
// the desktop counterpart of fixtures/form.html.

import AppKit

/// Lifecycle log for diagnosing test runs: $TMPDIR/nexus-fixture.log
func trace(_ message: String) {
  let line = "\(Date().timeIntervalSince1970) [\(ProcessInfo.processInfo.processIdentifier)] \(message)\n"
  let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("nexus-fixture.log")
  if let handle = try? FileHandle(forWritingTo: url) {
    handle.seekToEndOfFile()
    handle.write(line.data(using: .utf8)!)
    try? handle.close()
  } else {
    try? line.write(to: url, atomically: true, encoding: .utf8)
  }
}

final class FixtureDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  let nameField = NSTextField()
  let passwordField = NSSecureTextField()
  let status = NSTextField(labelWithString: "Ready")
  let subscribe = NSButton(checkboxWithTitle: "Subscribe", target: nil, action: nil)
  let color = NSPopUpButton()

  func applicationDidFinishLaunching(_ notification: Notification) {
    trace("did finish launching")
    NSApp.mainMenu = buildMenu()

    nameField.placeholderString = "Your name"
    nameField.setAccessibilityLabel("Name")
    nameField.setAccessibilityIdentifier("name")
    passwordField.setAccessibilityLabel("Password")
    passwordField.setAccessibilityIdentifier("password")

    let greet = NSButton(title: "Greet", target: self, action: #selector(greet(_:)))
    greet.setAccessibilityIdentifier("greet")
    subscribe.target = self
    subscribe.action = #selector(toggle(_:))
    subscribe.setAccessibilityIdentifier("subscribe")
    color.addItems(withTitles: ["Red", "Green", "Blue"])
    color.target = self
    color.action = #selector(pick(_:))
    color.setAccessibilityLabel("Color")
    color.setAccessibilityIdentifier("color")
    status.setAccessibilityIdentifier("status")

    let form = NSStackView(views: [
      row("Name", nameField), row("Password", passwordField), greet, subscribe, row("Color", color), status,
    ])
    form.orientation = .vertical
    form.alignment = .leading
    form.spacing = 12
    form.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)

    window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 460, height: 300),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "NEXUS Fixture"
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.contentView = form
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func row(_ label: String, _ field: NSView) -> NSView {
    field.widthAnchor.constraint(equalToConstant: 260).isActive = true
    let stack = NSStackView(views: [NSTextField(labelWithString: label), field])
    stack.spacing = 8
    return stack
  }

  func buildMenu() -> NSMenu {
    let main = NSMenu()
    let appItem = NSMenuItem()
    appItem.submenu = NSMenu()
    appItem.submenu!.addItem(withTitle: "Quit NexusFixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    main.addItem(appItem)

    let formItem = NSMenuItem(title: "Form", action: nil, keyEquivalent: "")
    let formMenu = NSMenu(title: "Form")
    formMenu.addItem(withTitle: "Reset Form", action: #selector(reset(_:)), keyEquivalent: "r").target = self
    let fill = NSMenuItem(title: "Fill", action: nil, keyEquivalent: "")
    fill.submenu = NSMenu(title: "Fill")
    fill.submenu!.addItem(withTitle: "Sample Name", action: #selector(sample(_:)), keyEquivalent: "").target = self
    formMenu.addItem(fill)
    formItem.submenu = formMenu
    main.addItem(formItem)
    return main
  }

  @objc func greet(_ sender: Any?) {
    status.stringValue = "Hello, \(nameField.stringValue)! (password: \(passwordField.stringValue.count) characters)"
  }
  @objc func toggle(_ sender: Any?) { status.stringValue = "Subscribed: \(subscribe.state == .on ? "yes" : "no")" }
  @objc func pick(_ sender: Any?) { status.stringValue = "Color: \(color.titleOfSelectedItem ?? "")" }
  @objc func reset(_ sender: Any?) {
    nameField.stringValue = ""
    passwordField.stringValue = ""
    subscribe.state = .off
    status.stringValue = "Ready"
  }
  @objc func sample(_ sender: Any?) { nameField.stringValue = "Ada Lovelace" }

  // Tests quit the app explicitly; it must not vanish if its window is closed.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func windowWillClose(_ notification: Notification) { trace("window closed") }
}

trace("start")
atexit { trace("exit") }
let app = NSApplication.shared
let delegate = FixtureDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
