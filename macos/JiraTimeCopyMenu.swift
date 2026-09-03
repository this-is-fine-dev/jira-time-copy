import AppKit
import Darwin
import Foundation
import UserNotifications

private let collisionCategory = "JIRA_TIME_COPY_COLLISION"
private let resolveCollisionsAction = "RESOLVE_COLLISIONS"
private let logURL = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Logs/jira-time-copy.log")
private let sourceStatusURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JIRA_TIME_COPY_STATUS"] ?? "")
private let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "png")
private let syncLabel = "dev.this-is-fine.jira-time-copy.sync"
private let reminderLabel = "dev.this-is-fine.jira-time-copy.reminder"
private let statusLabel = "dev.this-is-fine.jira-time-copy.status"
private let configURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JIRA_TIME_COPY_ENV"]
  ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".jira-time-copy.env").path)

private func registerNotificationCategories(_ center: UNUserNotificationCenter) {
  center.setNotificationCategories([
    UNNotificationCategory(
      identifier: collisionCategory,
      actions: [
        UNNotificationAction(identifier: resolveCollisionsAction, title: "Rozwiąż…", options: [.foreground]),
        UNNotificationAction(identifier: "IGNORE_COLLISIONS", title: "Pomiń", options: []),
      ],
      intentIdentifiers: []
    )
  ])
}

private func deliverNotification(_ body: String, category: String? = nil) -> Bool {
  let center = UNUserNotificationCenter.current()
  registerNotificationCategories(center)
  let done = DispatchSemaphore(value: 0)
  var delivered = false
  center.requestAuthorization(options: [.alert, .sound]) { granted, error in
    if let error { fputs("notification authorization: \(error)\n", stderr) }
    guard granted else {
      fputs("notification authorization: denied\n", stderr)
      done.signal()
      return
    }
    let content = UNMutableNotificationContent()
    content.title = "Jira Time Copy"
    content.body = body
    content.sound = .default
    if let category { content.categoryIdentifier = category }
    center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { error in
      if let error { fputs("notification delivery: \(error)\n", stderr) }
      delivered = error == nil
      done.signal()
    }
  }
  return done.wait(timeout: .now() + 15) == .success && delivered
}

private func persistentNotificationsEnabled() -> Bool {
  let done = DispatchSemaphore(value: 0)
  var enabled = false
  UNUserNotificationCenter.current().getNotificationSettings { settings in
    enabled = settings.authorizationStatus == .authorized && settings.alertStyle == .alert
    fputs("notification settings: authorization=\(settings.authorizationStatus.rawValue), alertStyle=\(settings.alertStyle.rawValue)\n", stderr)
    done.signal()
  }
  return done.wait(timeout: .now() + 15) == .success && enabled
}

private struct Run {
  let date: Date
  var hours: Double?
  var collisions = 0
  var error: String?
}

private struct SourceStatus: Decodable {
  let checkedAt: String
  let seconds: Int?
  let error: String?
}

private func parseLog(_ text: String) -> [Run] {
  let iso = ISO8601DateFormatter()
  iso.formatOptions.insert(.withFractionalSeconds)
  var runs: [Run] = []
  var current: Run?

  for part in text.split(separator: "\n", omittingEmptySubsequences: false) {
    let line = String(part)
    if line.hasPrefix("--- "), line.hasSuffix(" ---"),
       let date = iso.date(from: String(line.dropFirst(4).dropLast(4))) {
      if let current { runs.append(current) }
      current = Run(date: date)
    } else if line.contains("KOLIZJA:") {
      current?.collisions += 1
    } else if line.hasPrefix("niepowodzenie: ") {
      current?.error = String(line.dropFirst("niepowodzenie: ".count))
    } else if line.hasPrefix("zapisano: ") {
      current?.hours = Double(line.dropFirst(10).prefix { $0.isNumber || $0 == "." })
    }
  }
  if let current { runs.append(current) }
  return runs
}

private func clockParts(_ value: String) -> (hour: Int, minute: Int)? {
  let parts = value.split(separator: ":", omittingEmptySubsequences: false)
  guard parts.count == 2, parts[0].count == 2, parts[1].count == 2,
        let hour = Int(parts[0]), let minute = Int(parts[1]),
        (0...23).contains(hour), (0...59).contains(minute) else { return nil }
  return (hour, minute)
}

private func updatedConfig(_ text: String, sync: String, reminder: String, hours: String) -> String {
  var lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  if lines.last == "" { lines.removeLast() }
  for (key, value) in [("SYNC_TIME", sync), ("REMINDER_TIME", reminder), ("WORKDAY_HOURS", hours)] {
    let prefix = "\(key)="
    if let index = lines.firstIndex(where: { $0.hasPrefix(prefix) }) {
      lines[index] = prefix + value
    } else {
      lines.append(prefix + value)
    }
  }
  return lines.joined(separator: "\n") + "\n"
}

private func savedSetting(_ key: String, fallback: String) -> String {
  guard let text = try? String(contentsOf: configURL, encoding: .utf8) else { return fallback }
  let prefix = "\(key)="
  return text.split(separator: "\n").map(String.init).first { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)) } ?? fallback
}

private func period(monthOffset: Int = 0) -> String {
  let date = Calendar.current.date(byAdding: .month, value: monthOffset, to: Date()) ?? Date()
  let formatter = DateFormatter()
  formatter.dateFormat = "yyyy-MM"
  return formatter.string(from: date)
}

private func todayPeriod() -> String {
  let formatter = DateFormatter()
  formatter.dateFormat = "yyyy-MM-dd"
  return formatter.string(from: Date())
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let status = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let sourceToday = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let copiedToday = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let copiedTotal = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let schedule = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let collisions = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let historyMenu = NSMenu()
  private let syncTimeField = NSTextField(frame: .zero)
  private let reminderTimeField = NSTextField(frame: .zero)
  private let workdayHoursField = NSTextField(frame: .zero)
  private let settingsFeedback = NSTextField(labelWithString: " ")
  private var panel: NSPanel!
  private var timer: Timer?
  private var configuredSyncTime = savedSetting("SYNC_TIME", fallback: ProcessInfo.processInfo.environment["JIRA_TIME_COPY_SCHEDULE"] ?? "23:00")
  private var configuredReminderTime = savedSetting("REMINDER_TIME", fallback: ProcessInfo.processInfo.environment["JIRA_TIME_COPY_REMINDER"] ?? "16:00")
  private var configuredWorkdayHours = savedSetting("WORKDAY_HOURS", fallback: ProcessInfo.processInfo.environment["JIRA_TIME_COPY_WORKDAY_HOURS"] ?? "8")

  func applicationDidFinishLaunching(_ notification: Notification) {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    registerNotificationCategories(center)
    center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    setupMenu()
    setupSettingsPanel()
    refresh()
    if CommandLine.arguments.contains("--show-panel") { showSettings() }
    timer = Timer.scheduledTimer(timeInterval: 30, target: self, selector: #selector(refresh), userInfo: nil, repeats: true)
  }

  private func setupMenu() {
    let menu = NSMenu()
    menu.delegate = self
    for line in [status, sourceToday, copiedToday, copiedTotal, schedule, collisions] {
      line.isEnabled = false
      menu.addItem(line)
      if line === sourceToday { menu.addItem(.separator()) }
    }
    menu.addItem(.separator())
    menu.addItem(actionItem("Synchronizuj teraz", #selector(runNow), "r"))
    menu.addItem(actionItem("Odśwież czas źródłowy", #selector(refreshSource), ""))

    let interactive = NSMenu()
    for (title, value) in [
      ("Dzisiaj…", todayPeriod()),
      ("Bieżący miesiąc…", period()),
      ("Poprzedni miesiąc…", period(monthOffset: -1)),
    ] {
      let option = actionItem(title, #selector(runInteractive(_:)), "")
      option.representedObject = value
      interactive.addItem(option)
    }
    let interactiveItem = NSMenuItem(title: "Synchronizacja interaktywna", action: nil, keyEquivalent: "")
    interactiveItem.submenu = interactive
    menu.addItem(interactiveItem)

    let historyItem = NSMenuItem(title: "Ostatnie synchronizacje", action: nil, keyEquivalent: "")
    historyItem.submenu = historyMenu
    menu.addItem(historyItem)
    menu.addItem(.separator())
    menu.addItem(actionItem("Ustawienia harmonogramu…", #selector(showSettings), ","))
    menu.addItem(actionItem("Otwórz pełny log", #selector(openLog), "l"))
    menu.addItem(.separator())
    menu.addItem(actionItem("Zakończ", #selector(quit), "q"))
    item.menu = menu
    item.button?.imagePosition = .imageLeading
    item.button?.toolTip = "Jira Time Copy"
  }

  private func actionItem(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
    let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: key)
    menuItem.target = self
    return menuItem
  }

  private func setupSettingsPanel() {
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 420, height: 270),
      styleMask: [.titled, .closable, .utilityWindow],
      backing: .buffered,
      defer: false
    )
    panel.title = "Jira Time Copy"
    panel.isReleasedWhenClosed = false
    panel.center()

    let root = NSStackView()
    root.orientation = .vertical
    root.alignment = .leading
    root.spacing = 14
    root.translatesAutoresizingMaskIntoConstraints = false
    panel.contentView?.addSubview(root)
    NSLayoutConstraint.activate([
      root.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor, constant: 20),
      root.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor, constant: -20),
      root.topAnchor.constraint(equalTo: panel.contentView!.topAnchor, constant: 18),
      root.bottomAnchor.constraint(lessThanOrEqualTo: panel.contentView!.bottomAnchor, constant: -18),
    ])

    let header = NSStackView()
    header.orientation = .horizontal
    header.alignment = .centerY
    header.spacing = 10
    if let iconURL, let image = NSImage(contentsOf: iconURL) {
      let icon = NSImageView(image: image)
      icon.imageScaling = .scaleProportionallyUpOrDown
      icon.widthAnchor.constraint(equalToConstant: 38).isActive = true
      icon.heightAnchor.constraint(equalToConstant: 38).isActive = true
      header.addArrangedSubview(icon)
    }
    let heading = NSStackView()
    heading.orientation = .vertical
    heading.alignment = .leading
    heading.spacing = 1
    let title = NSTextField(labelWithString: "Ustawienia harmonogramu")
    title.font = .systemFont(ofSize: 17, weight: .semibold)
    let subtitle = NSTextField(labelWithString: "Zadania systemowe launchd")
    subtitle.textColor = .secondaryLabelColor
    heading.addArrangedSubview(title)
    heading.addArrangedSubview(subtitle)
    header.addArrangedSubview(heading)
    root.addArrangedSubview(header)

    for field in [syncTimeField, reminderTimeField, workdayHoursField] {
      field.alignment = .center
      field.widthAnchor.constraint(equalToConstant: 90).isActive = true
    }
    let hoursControl = NSStackView(views: [workdayHoursField, NSTextField(labelWithString: "h")])
    hoursControl.orientation = .horizontal
    hoursControl.spacing = 6
    let grid = NSGridView(views: [
      [NSTextField(labelWithString: "Automatyczny zapis"), syncTimeField],
      [NSTextField(labelWithString: "Przypomnienie"), reminderTimeField],
      [NSTextField(labelWithString: "Pełny dzień"), hoursControl],
    ])
    grid.column(at: 0).xPlacement = .trailing
    grid.column(at: 1).xPlacement = .leading
    grid.rowSpacing = 10
    grid.columnSpacing = 12
    root.addArrangedSubview(grid)

    settingsFeedback.textColor = .secondaryLabelColor
    root.addArrangedSubview(settingsFeedback)
    let save = NSButton(title: "Zapisz", target: self, action: #selector(saveSettings))
    save.keyEquivalent = "\r"
    let footer = NSStackView(views: [NSView(), save])
    footer.orientation = .horizontal
    root.addArrangedSubview(footer)
    footer.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
  }

  func menuWillOpen(_ menu: NSMenu) { refresh() }

  @objc private func refresh() {
    let text = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
    let runs = parseLog(text)
    let completed = runs.compactMap { run in run.hours.map { (run.date, $0) } }
    let todayHours = completed.filter { Calendar.current.isDateInToday($0.0) }.reduce(0) { $0 + $1.1 }
    let totalHours = completed.reduce(0) { $0 + $1.1 }
    let icon: String

    if let last = runs.last {
      let formatter = DateFormatter()
      formatter.dateFormat = "dd.MM, HH:mm"
      if last.error != nil {
        status.title = "Ostatnia synchronizacja nie powiodła się"
        icon = "exclamationmark.triangle"
      } else if let hours = last.hours {
        status.title = "Ostatnio: OK, \(formatter.string(from: last.date)) (\(format(hours)))"
        icon = "clock.badge.checkmark"
      } else if Date().timeIntervalSince(last.date) < 600 {
        status.title = "Synchronizacja trwa…"
        icon = "arrow.triangle.2.circlepath"
      } else {
        status.title = "Ostatnia synchronizacja nie powiodła się"
        icon = "exclamationmark.triangle"
      }
    } else {
      status.title = "Jeszcze nie uruchomiono"
      icon = "clock"
    }

    let expectedHours = Double(configuredWorkdayHours) ?? 8
    let source = try? JSONDecoder().decode(SourceStatus.self, from: Data(contentsOf: sourceStatusURL))
    if let source, source.error == nil, let seconds = source.seconds, let checked = isoDate(source.checkedAt) {
      let formatter = DateFormatter()
      formatter.dateFormat = "HH:mm"
      sourceToday.title = "Dzisiaj: \(format(Double(seconds) / 3600)) / \(format(expectedHours)) · \(formatter.string(from: checked))"
      item.button?.title = " \(format(Double(seconds) / 3600))"
    } else {
      sourceToday.title = source?.error == nil ? "Jira źródłowa: jeszcze nie sprawdzono" : "Jira źródłowa: brak połączenia"
      item.button?.title = ""
    }
    copiedToday.title = "Skopiowano dzisiaj: \(format(todayHours))"
    copiedTotal.title = "Łącznie od instalacji: \(format(totalHours))"
    schedule.title = "Harmonogram: przypomnienie \(configuredReminderTime) · zapis \(configuredSyncTime)"
    collisions.title = "Różnice ostatnio: \(runs.last?.collisions ?? 0)"
    renderHistory(runs)
    if let iconURL, let image = NSImage(contentsOf: iconURL) {
      image.size = NSSize(width: 19, height: 19)
      image.isTemplate = false
      item.button?.image = image
    } else {
      item.button?.image = NSImage(systemSymbolName: icon, accessibilityDescription: status.title)
    }
  }

  private func renderHistory(_ runs: [Run]) {
    let formatter = DateFormatter()
    formatter.dateFormat = "dd.MM HH:mm"
    historyMenu.removeAllItems()
    for run in runs.suffix(5).reversed() {
      let result = run.error != nil ? "BŁĄD" : run.hours.map { "OK · \(format($0))" } ?? "nieukończona"
      let collision = run.collisions > 0 ? " · różnice: \(run.collisions)" : ""
      let entry = NSMenuItem(title: "\(formatter.string(from: run.date)) · \(result)\(collision)", action: nil, keyEquivalent: "")
      entry.isEnabled = false
      historyMenu.addItem(entry)
    }
    if runs.isEmpty {
      let empty = NSMenuItem(title: "Brak zapisanych uruchomień", action: nil, keyEquivalent: "")
      empty.isEnabled = false
      historyMenu.addItem(empty)
    }
  }

  private func format(_ hours: Double) -> String { String(format: "%.2f h", hours) }

  private func isoDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions.insert(.withFractionalSeconds)
    return formatter.date(from: value)
  }

  @objc private func showSettings() {
    syncTimeField.stringValue = configuredSyncTime
    reminderTimeField.stringValue = configuredReminderTime
    workdayHoursField.stringValue = configuredWorkdayHours
    settingsFeedback.stringValue = " "
    NSApplication.shared.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showSettings()
    return true
  }

  @objc private func runNow() {
    status.title = "Uruchamiam synchronizację…"
    runAgent(syncLabel)
  }

  @objc private func refreshSource() {
    sourceToday.title = "Jira źródłowa: odświeżam…"
    runAgent(statusLabel, restart: true)
  }

  @objc private func openLog() { NSWorkspace.shared.open(logURL) }

  private func runAgent(_ label: String, restart: Bool = false) {
    do {
      try command(["kickstart"] + (restart ? ["-k"] : []) + ["gui/\(getuid())/\(label)"])
    } catch {
      status.title = "Nie udało się uruchomić zadania launchd"
    }
  }

  @objc private func runInteractive(_ sender: NSMenuItem) {
    openInteractive(sender.representedObject as? String ?? period())
  }

  private func openInteractive(_ selectedPeriod: String) {
    let env = ProcessInfo.processInfo.environment
    guard let node = env["JIRA_TIME_COPY_NODE"], let script = env["JIRA_TIME_COPY_SCRIPT"] else { return }
    let appleScript = """
    on run argv
      set commandLine to quoted form of item 1 of argv & " " & quoted form of item 2 of argv & " " & quoted form of item 3 of argv
      if item 4 of argv is not "" then set commandLine to "JIRA_TIME_COPY_ENV=" & quoted form of item 4 of argv & " " & commandLine
      tell application "Terminal"
        activate
        do script commandLine
      end tell
    end run
    """
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    task.arguments = ["-e", appleScript, node, script, selectedPeriod, env["JIRA_TIME_COPY_ENV"] ?? ""]
    try? task.run()
  }

  @objc private func saveSettings() {
    let sync = syncTimeField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let reminder = reminderTimeField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let hoursText = workdayHoursField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
    guard let syncClock = clockParts(sync), let reminderClock = clockParts(reminder),
          let hours = Double(hoursText), hours > 0, hours <= 24 else {
      settingsFeedback.textColor = .systemRed
      settingsFeedback.stringValue = "Podaj godziny GG:MM i pełny dzień od 0 do 24 h."
      return
    }

    let home = FileManager.default.homeDirectoryForCurrentUser
    let agents = home.appendingPathComponent("Library/LaunchAgents")
    let syncPlist = agents.appendingPathComponent("\(syncLabel).plist")
    let reminderPlist = agents.appendingPathComponent("\(reminderLabel).plist")

    do {
      let text = try String(contentsOf: configURL, encoding: .utf8)
      try updatedConfig(text, sync: sync, reminder: reminder, hours: hoursText).write(to: configURL, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
      try updatePlist(syncPlist, schedule: ["Hour": syncClock.hour, "Minute": syncClock.minute])
      try updatePlist(reminderPlist, schedule: (1...5).map { ["Weekday": $0, "Hour": reminderClock.hour, "Minute": reminderClock.minute] })
      try reloadAgent(syncLabel, plist: syncPlist)
      try reloadAgent(reminderLabel, plist: reminderPlist)
      configuredSyncTime = sync
      configuredReminderTime = reminder
      configuredWorkdayHours = hoursText
      settingsFeedback.textColor = .systemGreen
      settingsFeedback.stringValue = "Zapisano i przeładowano launchd."
      refresh()
    } catch {
      settingsFeedback.textColor = .systemRed
      settingsFeedback.stringValue = "Nie udało się zapisać: \(error.localizedDescription)"
    }
  }

  private func updatePlist(_ url: URL, schedule: Any) throws {
    let data = try Data(contentsOf: url)
    guard var plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
      throw NSError(domain: "JiraTimeCopy", code: 1, userInfo: [NSLocalizedDescriptionKey: "Nieprawidłowy plik \(url.lastPathComponent)"])
    }
    plist["StartCalendarInterval"] = schedule
    let output = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try output.write(to: url, options: .atomic)
  }

  private func reloadAgent(_ label: String, plist: URL) throws {
    let domain = "gui/\(getuid())"
    try? command(["bootout", "\(domain)/\(label)"])
    try command(["bootstrap", domain, plist.path])
  }

  private func command(_ arguments: [String]) throws {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    task.arguments = arguments
    try task.run()
    task.waitUntilExit()
    if task.terminationStatus != 0 {
      throw NSError(domain: "JiraTimeCopy", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "launchctl zakończył się błędem"])
    }
  }

  func layoutSelfcheck() {
    setupSettingsPanel()
    panel.contentView?.layoutSubtreeIfNeeded()
    let bounds = panel.contentView!.bounds
    let syncFrame = panel.contentView!.convert(syncTimeField.bounds, from: syncTimeField)
    let save = panel.contentView!.subviewsRecursive.first { ($0 as? NSButton)?.title == "Zapisz" }
    let saveFrame = save.map { panel.contentView!.convert($0.bounds, from: $0) } ?? .zero
    precondition(
      bounds.contains(syncFrame) && bounds.contains(saveFrame) && syncFrame.height > 0 && saveFrame.height > 0,
      "Opcje są poza widocznym obszarem"
    )
    print("ok")
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let content = response.notification.request.content
    if content.categoryIdentifier == collisionCategory &&
      (response.actionIdentifier == resolveCollisionsAction ||
        response.actionIdentifier == UNNotificationDefaultActionIdentifier) {
      DispatchQueue.main.async {
        self.openInteractive(period())
      }
    }
    completionHandler()
  }

  @objc private func quit() { NSApplication.shared.terminate(nil) }
}

private extension NSView {
  var subviewsRecursive: [NSView] { subviews + subviews.flatMap(\.subviewsRecursive) }
}

if let notify = CommandLine.arguments.firstIndex(of: "--notify"), CommandLine.arguments.indices.contains(notify + 1) {
  exit(deliverNotification(CommandLine.arguments[notify + 1]) ? 0 : 1)
} else if let notify = CommandLine.arguments.firstIndex(of: "--notify-collision"), CommandLine.arguments.indices.contains(notify + 1) {
  exit(deliverNotification(CommandLine.arguments[notify + 1], category: collisionCategory) ? 0 : 1)
} else if CommandLine.arguments.contains("--notification-check") {
  exit(persistentNotificationsEnabled() ? 0 : 1)
} else if CommandLine.arguments.contains("--layout-selfcheck") {
  _ = NSApplication.shared
  let delegate = AppDelegate()
  delegate.layoutSelfcheck()
  withExtendedLifetime(delegate) {}
} else if CommandLine.arguments.contains("--selfcheck") {
  let runs = parseLog("""
  --- 2026-09-01T21:00:00.000Z ---
  2026-09-01  8.00h  ABC-1

  zapisano: 8.00h -> TIME-1 (2026-09)
  --- 2026-09-02T21:00:00.000Z ---
  2026-09-02  5.00h  KOLIZJA: w celu masz juz 8.00h - pomijam

  zapisano: 0.00h -> TIME-1 (2026-09)
  --- 2026-09-03T21:00:00.000Z ---
  niepowodzenie: fetch failed
  """)
  precondition(runs.count == 3, "runs: \(runs)")
  precondition(runs[0].hours == 8, "first: \(runs[0])")
  precondition(runs[1].hours == 0 && runs[1].collisions == 1, "second: \(runs[1])")
  precondition(runs[2].error == "fetch failed", "third: \(runs[2])")
  let source = try! JSONDecoder().decode(SourceStatus.self, from: Data(#"{"checkedAt":"2026-09-02T14:00:00.000Z","seconds":12600}"#.utf8))
  precondition(source.seconds == 12600 && source.error == nil, "source: \(source)")
  precondition(clockParts("23:05")?.hour == 23 && clockParts("24:00") == nil, "clock")
  let config = updatedConfig("SRC_TOKEN=secret\nSYNC_TIME=18:00\n", sync: "19:15", reminder: "16:00", hours: "8")
  precondition(config.contains("SRC_TOKEN=secret") && config.contains("SYNC_TIME=19:15") && config.contains("REMINDER_TIME=16:00"), "config")
  print("ok")
} else {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.setActivationPolicy(.accessory)
  app.delegate = delegate
  app.run()
}
