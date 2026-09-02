import AppKit
import Darwin
import Foundation
import UserNotifications

private let syncLabel = "dev.this-is-fine.jira-time-copy.sync"
private let logURL = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Logs/jira-time-copy.log")
private let sourceStatusURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JIRA_TIME_COPY_STATUS"] ?? "")
private let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "png")

private func deliverNotification(_ body: String) -> Bool {
  let center = UNUserNotificationCenter.current()
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
  var failed = false
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
      current?.failed = true
    } else if line.hasPrefix("zapisano: ") {
      current?.hours = Double(line.dropFirst(10).prefix { $0.isNumber || $0 == "." })
    }
  }
  if let current { runs.append(current) }
  return runs
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let status = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let sourceToday = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let copied = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let schedule = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let total = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let collisions = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private var timer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    let menu = NSMenu()
    menu.delegate = self
    for line in [status, sourceToday, copied, total, schedule, collisions] {
      line.isEnabled = false
      menu.addItem(line)
    }
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Synchronizuj teraz", action: #selector(runNow), keyEquivalent: "r"))
    menu.addItem(NSMenuItem(title: "Otwórz log", action: #selector(openLog), keyEquivalent: "l"))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Zakończ", action: #selector(quit), keyEquivalent: "q"))
    menu.items.filter { $0.action != nil }.forEach { $0.target = self }
    item.menu = menu
    item.button?.imagePosition = .imageLeading
    item.button?.toolTip = "Jira Time Copy"
    refresh()
    timer = Timer.scheduledTimer(timeInterval: 30, target: self, selector: #selector(refresh), userInfo: nil, repeats: true)
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
      if last.failed {
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
      collisions.title = "Kolizje ostatnio: \(last.collisions)"
    } else {
      status.title = "Jeszcze nie uruchomiono"
      collisions.title = "Kolizje ostatnio: 0"
      icon = "clock"
    }

    let env = ProcessInfo.processInfo.environment
    let syncTime = env["JIRA_TIME_COPY_SCHEDULE"] ?? "23:00"
    let reminder = env["JIRA_TIME_COPY_REMINDER"] ?? "16:00"
    let expectedHours = Double(env["JIRA_TIME_COPY_WORKDAY_HOURS"] ?? "8") ?? 8
    let source = try? JSONDecoder().decode(SourceStatus.self, from: Data(contentsOf: sourceStatusURL))
    if let source, source.error == nil, let seconds = source.seconds, let checked = isoDate(source.checkedAt) {
      let formatter = DateFormatter()
      formatter.dateFormat = "HH:mm"
      sourceToday.title = "Jira źródłowa dzisiaj: \(format(Double(seconds) / 3600)) / \(format(expectedHours)) · stan \(formatter.string(from: checked))"
      item.button?.title = " \(format(Double(seconds) / 3600))"
    } else {
      sourceToday.title = source?.error == nil ? "Jira źródłowa: jeszcze nie sprawdzono" : "Jira źródłowa: sprawdzenie nie powiodło się"
      item.button?.title = ""
    }
    copied.title = "Skopiowano dzisiaj: \(format(todayHours))"
    total.title = "Skopiowano od instalacji: \(format(totalHours))"
    schedule.title = "Przypomnienie \(reminder) · zapis \(syncTime)"
    if let iconURL, let image = NSImage(contentsOf: iconURL) {
      image.size = NSSize(width: 19, height: 19)
      image.isTemplate = false
      item.button?.image = image
    } else {
      item.button?.image = NSImage(systemSymbolName: icon, accessibilityDescription: status.title)
    }
  }

  private func format(_ hours: Double) -> String { String(format: "%.2f h", hours) }

  private func isoDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions.insert(.withFractionalSeconds)
    return formatter.date(from: value)
  }

  @objc private func runNow() {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    task.arguments = ["kickstart", "gui/\(getuid())/\(syncLabel)"]
    try? task.run()
    status.title = "Uruchamiam synchronizację…"
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.refresh() }
  }

  @objc private func openLog() { NSWorkspace.shared.open(logURL) }
  @objc private func quit() { NSApplication.shared.terminate(nil) }
}

if let notify = CommandLine.arguments.firstIndex(of: "--notify"), CommandLine.arguments.indices.contains(notify + 1) {
  exit(deliverNotification(CommandLine.arguments[notify + 1]) ? 0 : 1)
} else if CommandLine.arguments.contains("--notification-check") {
  exit(persistentNotificationsEnabled() ? 0 : 1)
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
  precondition(runs[2].failed, "third: \(runs[2])")
  let source = try! JSONDecoder().decode(SourceStatus.self, from: Data(#"{"checkedAt":"2026-09-02T14:00:00.000Z","seconds":12600}"#.utf8))
  precondition(source.seconds == 12600 && source.error == nil, "source: \(source)")
  print("ok")
} else {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.setActivationPolicy(.accessory)
  app.delegate = delegate
  app.run()
}
