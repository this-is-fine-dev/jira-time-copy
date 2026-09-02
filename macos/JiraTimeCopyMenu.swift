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

private struct SyncPlan: Decodable {
  let period: String
  let issue: String
  let rows: [SyncRow]
}

private struct SyncRow: Codable {
  let date: String
  let sourceSeconds: Int
  let targetSeconds: Int?
  let state: String
}

private struct SyncChoice: Encodable {
  let date: String
  let sourceSeconds: Int
  let targetSeconds: Int?
  let action: String
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

private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let status = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let sourceToday = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let windowStatus = NSTextField(labelWithString: "")
  private let windowSource = NSTextField(labelWithString: "")
  private let windowStats = NSTextField(labelWithString: "")
  private let windowSchedule = NSTextField(labelWithString: "")
  private let tabs = NSSegmentedControl(labels: ["Synchronizacja", "Historia"], trackingMode: .selectOne, target: nil, action: nil)
  private let period = NSPopUpButton(frame: .zero, pullsDown: false)
  private let previewButton = NSButton(title: "Sprawdź", target: nil, action: nil)
  private let applyButton = NSButton(title: "Synchronizuj", target: nil, action: nil)
  private let feedback = NSTextField(labelWithString: "Wybierz zakres i sprawdź, co zostanie zapisane.")
  private let rows = NSStackView()
  private let syncView = NSView()
  private let historyView = NSScrollView()
  private let historyText = NSTextView()
  private var choiceMenus: [String: NSPopUpButton] = [:]
  private var currentPlan: SyncPlan?
  private var panel: NSPanel!
  private var timer: Timer?
  private var syncTask: Process?

  func applicationDidFinishLaunching(_ notification: Notification) {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    registerNotificationCategories(center)
    center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    setupMenu()
    setupPanel()
    refresh()
    if CommandLine.arguments.contains("--show-panel") { showPanel() }
    timer = Timer.scheduledTimer(timeInterval: 30, target: self, selector: #selector(refresh), userInfo: nil, repeats: true)
  }

  private func setupMenu() {
    let menu = NSMenu()
    menu.delegate = self
    for line in [status, sourceToday] {
      line.isEnabled = false
      menu.addItem(line)
    }
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Pokaż Jira Time Copy", action: #selector(showPanel), keyEquivalent: "o"))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Zakończ", action: #selector(quit), keyEquivalent: "q"))
    menu.items.filter { $0.action != nil }.forEach { $0.target = self }
    item.menu = menu
    item.button?.imagePosition = .imageLeading
    item.button?.toolTip = "Jira Time Copy"
  }

  private func setupPanel() {
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 500, height: 540),
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
    root.spacing = 10
    root.edgeInsets = NSEdgeInsets(top: 16, left: 18, bottom: 16, right: 18)
    root.translatesAutoresizingMaskIntoConstraints = false
    panel.contentView?.addSubview(root)
    NSLayoutConstraint.activate([
      root.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor),
      root.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor),
      root.topAnchor.constraint(equalTo: panel.contentView!.topAnchor),
      root.bottomAnchor.constraint(equalTo: panel.contentView!.bottomAnchor),
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
    let title = NSTextField(labelWithString: "Jira Time Copy")
    title.font = .systemFont(ofSize: 17, weight: .semibold)
    windowStatus.textColor = .secondaryLabelColor
    heading.addArrangedSubview(title)
    heading.addArrangedSubview(windowStatus)
    header.addArrangedSubview(heading)
    root.addArrangedSubview(header)
    root.addArrangedSubview(windowSource)
    root.addArrangedSubview(windowStats)
    windowSchedule.textColor = .secondaryLabelColor
    root.addArrangedSubview(windowSchedule)

    tabs.selectedSegment = 0
    tabs.target = self
    tabs.action = #selector(changeTab)
    tabs.translatesAutoresizingMaskIntoConstraints = false
    root.addArrangedSubview(tabs)
    tabs.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -36).isActive = true

    setupSyncView()
    setupHistoryView()
    let content = NSView()
    content.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(syncView)
    content.addSubview(historyView)
    for view in [syncView, historyView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      NSLayoutConstraint.activate([
        view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
        view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
        view.topAnchor.constraint(equalTo: content.topAnchor),
        view.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      ])
    }
    root.addArrangedSubview(content)
    content.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -36).isActive = true
    historyView.isHidden = true
  }

  private func setupSyncView() {
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.translatesAutoresizingMaskIntoConstraints = false
    syncView.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: syncView.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: syncView.trailingAnchor),
      stack.topAnchor.constraint(equalTo: syncView.topAnchor),
      stack.bottomAnchor.constraint(equalTo: syncView.bottomAnchor),
    ])

    for (title, value) in [
      ("Bieżący miesiąc (\(month()))", month()),
      ("Dzisiaj (\(day()))", day()),
      ("Poprzedni miesiąc (\(month(offset: -1)))", month(offset: -1)),
    ] {
      period.addItem(withTitle: title)
      period.lastItem?.representedObject = value
    }
    period.target = self
    period.action = #selector(periodChanged)
    previewButton.target = self
    previewButton.action = #selector(loadPlan)
    let controls = NSStackView(views: [period, previewButton])
    controls.orientation = .horizontal
    controls.spacing = 8
    stack.addArrangedSubview(controls)
    feedback.textColor = .secondaryLabelColor
    feedback.lineBreakMode = .byWordWrapping
    feedback.maximumNumberOfLines = 2
    stack.addArrangedSubview(feedback)

    rows.orientation = .vertical
    rows.alignment = .leading
    rows.spacing = 6
    let document = NSView()
    document.translatesAutoresizingMaskIntoConstraints = false
    rows.translatesAutoresizingMaskIntoConstraints = false
    document.addSubview(rows)
    NSLayoutConstraint.activate([
      rows.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 8),
      rows.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -8),
      rows.topAnchor.constraint(equalTo: document.topAnchor, constant: 8),
      rows.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -8),
    ])
    let scroll = NSScrollView()
    scroll.borderType = .bezelBorder
    scroll.hasVerticalScroller = true
    scroll.documentView = document
    document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
    scroll.translatesAutoresizingMaskIntoConstraints = false
    stack.addArrangedSubview(scroll)
    scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    scroll.heightAnchor.constraint(equalToConstant: 235).isActive = true

    applyButton.target = self
    applyButton.action = #selector(applyPlan)
    applyButton.keyEquivalent = "\r"
    applyButton.isEnabled = false
    let footer = NSStackView()
    footer.orientation = .horizontal
    footer.addArrangedSubview(NSView())
    footer.addArrangedSubview(applyButton)
    stack.addArrangedSubview(footer)
    footer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
  }

  private func setupHistoryView() {
    historyView.borderType = .bezelBorder
    historyView.hasVerticalScroller = true
    historyText.isEditable = false
    historyText.isSelectable = true
    historyText.drawsBackground = false
    historyText.isVerticallyResizable = true
    historyText.autoresizingMask = [.width]
    historyText.textContainer?.widthTracksTextView = true
    historyText.textContainerInset = NSSize(width: 10, height: 10)
    historyText.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
    historyView.documentView = historyText
  }

  func menuWillOpen(_ menu: NSMenu) { refresh() }

  @objc private func refresh() {
    let text = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
    let runs = parseLog(text)
    let completed = runs.compactMap { run in run.hours.map { (run.date, $0) } }
    let todayHours = completed.filter { Calendar.current.isDateInToday($0.0) }.reduce(0) { $0 + $1.1 }
    let totalHours = completed.reduce(0) { $0 + $1.1 }
    let icon: String

    if syncTask?.isRunning == true {
      status.title = "Synchronizacja trwa…"
      icon = "arrow.triangle.2.circlepath"
    } else if let last = runs.last {
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

    let env = ProcessInfo.processInfo.environment
    let syncTime = env["JIRA_TIME_COPY_SCHEDULE"] ?? "23:00"
    let reminder = env["JIRA_TIME_COPY_REMINDER"] ?? "16:00"
    let expectedHours = Double(env["JIRA_TIME_COPY_WORKDAY_HOURS"] ?? "8") ?? 8
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
    windowStatus.stringValue = status.title
    windowSource.stringValue = "Jira źródłowa · \(sourceToday.title)"
    windowStats.stringValue = "Skopiowano dzisiaj \(format(todayHours)) · łącznie \(format(totalHours))"
    windowSchedule.stringValue = "Przypomnienie \(reminder) · automatyczny zapis \(syncTime)"
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
    formatter.dateFormat = "dd.MM.yyyy  HH:mm"
    historyText.string = runs.suffix(20).reversed().map { run in
      let result = run.error.map { "BŁĄD · \($0)" } ?? run.hours.map { "OK · \(format($0))" } ?? "nieukończona"
      let collision = run.collisions > 0 ? " · różnice: \(run.collisions)" : ""
      return "\(formatter.string(from: run.date))   \(result)\(collision)"
    }.joined(separator: "\n\n")
    if runs.isEmpty { historyText.string = "Brak zapisanych uruchomień." }
  }

  private func renderPlan(_ plan: SyncPlan) {
    currentPlan = plan
    choiceMenus.removeAll()
    rows.arrangedSubviews.forEach {
      rows.removeArrangedSubview($0)
      $0.removeFromSuperview()
    }
    feedback.stringValue = plan.rows.isEmpty
      ? "Brak worklogów dla \(plan.period)."
      : "\(plan.issue) · \(plan.rows.count) \(plan.rows.count == 1 ? "dzień" : "dni")"
    for row in plan.rows {
      let date = NSTextField(labelWithString: row.date)
      date.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
      date.widthAnchor.constraint(equalToConstant: 88).isActive = true
      let source = NSTextField(labelWithString: "źródło \(format(Double(row.sourceSeconds) / 3600))")
      source.widthAnchor.constraint(equalToConstant: 105).isActive = true
      let target = NSTextField(labelWithString: "cel \(row.targetSeconds.map { format(Double($0) / 3600) } ?? "—")")
      target.widthAnchor.constraint(equalToConstant: 90).isActive = true
      let action: NSView
      if row.state == "synced" {
        let done = NSTextField(labelWithString: "Gotowe")
        done.textColor = .systemGreen
        action = done
      } else {
        let menu = NSPopUpButton(frame: .zero, pullsDown: false)
        let options = row.state == "collision"
          ? [("Pomiń", "skip"), ("Zsumuj", "add"), ("Nadpisz", "replace")]
          : [("Dodaj", "add"), ("Pomiń", "skip")]
        for (title, value) in options {
          menu.addItem(withTitle: title)
          menu.lastItem?.representedObject = value
        }
        menu.target = self
        menu.action = #selector(choiceChanged)
        menu.widthAnchor.constraint(equalToConstant: 108).isActive = true
        choiceMenus[row.date] = menu
        action = menu
      }
      let line = NSStackView(views: [date, source, target, action])
      line.orientation = .horizontal
      line.alignment = .centerY
      line.spacing = 6
      rows.addArrangedSubview(line)
    }
    updateApplyButton()
  }

  private func format(_ hours: Double) -> String { String(format: "%.2f h", hours) }

  private func isoDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions.insert(.withFractionalSeconds)
    return formatter.date(from: value)
  }

  private func month(offset: Int = 0) -> String {
    let date = Calendar.current.date(byAdding: .month, value: offset, to: Date()) ?? Date()
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM"
    return formatter.string(from: date)
  }

  private func day() -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: Date())
  }

  @objc private func showPanel() {
    NSApplication.shared.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showPanel()
    return true
  }

  @objc private func changeTab() {
    syncView.isHidden = tabs.selectedSegment != 0
    historyView.isHidden = tabs.selectedSegment == 0
  }

  @objc private func periodChanged() {
    currentPlan = nil
    choiceMenus.removeAll()
    rows.arrangedSubviews.forEach {
      rows.removeArrangedSubview($0)
      $0.removeFromSuperview()
    }
    applyButton.isEnabled = false
    applyButton.title = "Synchronizuj"
    feedback.stringValue = "Kliknij „Sprawdź”, aby pobrać aktualny plan."
  }

  @objc private func choiceChanged() { updateApplyButton() }

  private func updateApplyButton() {
    guard let plan = currentPlan else {
      applyButton.isEnabled = false
      return
    }
    let seconds = plan.rows.reduce(0) { total, row in
      let action = row.state == "synced" ? "synced" : choiceMenus[row.date]?.selectedItem?.representedObject as? String
      return total + ((action == "add" || action == "replace") ? row.sourceSeconds : 0)
    }
    applyButton.isEnabled = seconds > 0 && syncTask?.isRunning != true
    applyButton.title = seconds > 0 ? "Synchronizuj \(format(Double(seconds) / 3600))" : "Brak zmian"
  }

  @objc private func loadPlan() {
    guard syncTask?.isRunning != true,
          let selected = period.selectedItem?.representedObject as? String else { return }
    feedback.stringValue = "Pobieram dane z obu Jir…"
    previewButton.isEnabled = false
    applyButton.isEnabled = false
    startNode([selected, "--native-plan"]) { [weak self] code, data in
      guard let self else { return }
      self.previewButton.isEnabled = true
      if code == 0, let plan = try? JSONDecoder().decode(SyncPlan.self, from: data) {
        self.renderPlan(plan)
      } else {
        self.feedback.stringValue = self.errorMessage(data)
        self.appendLog(data)
      }
      self.refresh()
    }
  }

  @objc private func applyPlan() {
    guard syncTask?.isRunning != true, let plan = currentPlan else { return }
    let choices = plan.rows.map { row in
      SyncChoice(
        date: row.date,
        sourceSeconds: row.sourceSeconds,
        targetSeconds: row.targetSeconds,
        action: row.state == "synced"
          ? "synced"
          : (choiceMenus[row.date]?.selectedItem?.representedObject as? String ?? "skip")
      )
    }
    guard let data = try? JSONEncoder().encode(choices), let encoded = String(data: data, encoding: .utf8) else { return }
    feedback.stringValue = "Synchronizuję…"
    previewButton.isEnabled = false
    applyButton.isEnabled = false
    startNode([plan.period, "--native-apply", encoded]) { [weak self] code, output in
      guard let self else { return }
      self.appendLog(output)
      self.previewButton.isEnabled = true
      if code == 0 {
        self.feedback.stringValue = "Gotowe. Kliknij „Sprawdź”, aby odświeżyć plan."
        self.currentPlan = nil
        self.applyButton.title = "Synchronizuj"
      } else {
        self.feedback.stringValue = self.errorMessage(output)
        self.updateApplyButton()
      }
      self.refresh()
    }
  }

  private func startNode(_ arguments: [String], completion: @escaping (Int32, Data) -> Void) {
    let env = ProcessInfo.processInfo.environment
    guard let node = env["JIRA_TIME_COPY_NODE"], let script = env["JIRA_TIME_COPY_SCRIPT"] else {
      completion(1, Data("Brak konfiguracji procesu. Uruchom ponownie pnpm configure.".utf8))
      return
    }
    let task = Process()
    let pipe = Pipe()
    task.executableURL = URL(fileURLWithPath: node)
    task.arguments = [script] + arguments
    task.environment = env
    task.standardOutput = pipe
    task.standardError = pipe
    task.terminationHandler = { [weak self] finished in
      let output = pipe.fileHandleForReading.readDataToEndOfFile()
      DispatchQueue.main.async {
        self?.syncTask = nil
        completion(finished.terminationStatus, output)
      }
    }
    syncTask = task
    do {
      try task.run()
      refresh()
    } catch {
      syncTask = nil
      completion(1, Data(error.localizedDescription.utf8))
    }
  }

  private func appendLog(_ data: Data) {
    guard !data.isEmpty, let handle = try? FileHandle(forWritingTo: logURL) else { return }
    handle.seekToEndOfFile()
    handle.write(data)
    if data.last != 10 { handle.write(Data("\n".utf8)) }
    handle.closeFile()
  }

  private func errorMessage(_ data: Data) -> String {
    let text = String(data: data, encoding: .utf8) ?? ""
    if text.contains("fetch failed") { return "Brak połączenia z Jirą. Sprawdź sieć lub VPN." }
    if let line = text.split(separator: "\n").first(where: { $0.hasPrefix("niepowodzenie: ") }) {
      return String(line.dropFirst("niepowodzenie: ".count))
    }
    return "Operacja nie powiodła się."
  }

  func layoutSelfcheck() {
    setupPanel()
    panel.contentView?.layoutSubtreeIfNeeded()
    let bounds = panel.contentView!.bounds
    let tabFrame = panel.contentView!.convert(tabs.bounds, from: tabs)
    let syncFrame = panel.contentView!.convert(syncView.bounds, from: syncView)
    precondition(
      bounds.contains(tabFrame) && bounds.intersects(syncFrame) && syncFrame.height > 200 && !syncView.isHidden,
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
        self.showPanel()
        self.tabs.selectedSegment = 0
        self.changeTab()
        self.period.selectItem(at: 0)
        self.loadPlan()
      }
    }
    completionHandler()
  }

  @objc private func quit() { NSApplication.shared.terminate(nil) }
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
  let plan = try! JSONDecoder().decode(
    SyncPlan.self,
    from: Data(#"{"period":"2026-09","issue":"TIME-1","rows":[{"date":"2026-09-02","sourceSeconds":7200,"targetSeconds":3600,"state":"collision"}]}"#.utf8)
  )
  precondition(plan.rows.first?.state == "collision", "plan: \(plan)")
  print("ok")
} else {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.setActivationPolicy(.accessory)
  app.delegate = delegate
  app.run()
}
