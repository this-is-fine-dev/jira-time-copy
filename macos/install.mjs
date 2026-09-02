#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('Integracja z paskiem menu wymaga macOS.')

const time = process.argv[2] ?? '23:00'
if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`Nieprawidlowa godzina: ${time}`)
const reminderTime = process.argv[3] ?? '16:00'
if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reminderTime))
  throw new Error(`Nieprawidlowa godzina przypomnienia: ${reminderTime}`)

const [hour, minute] = time.split(':').map(Number)
const [reminderHour, reminderMinute] = reminderTime.split(':').map(Number)
const home = os.homedir()
const uid = process.getuid()
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const config = process.argv[4] ?? path.join(home, '.jira-time-copy.env')
const workdayHours = process.argv[5] ?? '8'
if (!(Number(workdayHours) > 0 && Number(workdayHours) <= 24))
  throw new Error(`Nieprawidłowa liczba godzin dnia pracy: ${workdayHours}`)
const support = path.join(home, 'Library', 'Application Support', 'jira-time-copy')
const agents = path.join(home, 'Library', 'LaunchAgents')
const logs = path.join(home, 'Library', 'Logs')
const app = path.join(home, 'Applications', 'Jira Time Copy.app')
const contents = path.join(app, 'Contents')
const resources = path.join(contents, 'Resources')
const menuBinary = path.join(contents, 'MacOS', 'JiraTimeCopy')
const syncLog = path.join(logs, 'jira-time-copy.log')
const menuLog = path.join(logs, 'jira-time-copy-menu.log')
const reminderLog = path.join(logs, 'jira-time-copy-reminder.log')
const statusLog = path.join(logs, 'jira-time-copy-status.log')
const statusFile = path.join(support, 'status.json')
const syncLabel = 'dev.this-is-fine.jira-time-copy.sync'
const menuLabel = 'dev.this-is-fine.jira-time-copy.menu'
const reminderLabel = 'dev.this-is-fine.jira-time-copy.reminder'
const statusLabel = 'dev.this-is-fine.jira-time-copy.status'
const syncPlist = path.join(agents, `${syncLabel}.plist`)
const menuPlist = path.join(agents, `${menuLabel}.plist`)
const reminderPlist = path.join(agents, `${reminderLabel}.plist`)
const statusPlist = path.join(agents, `${statusLabel}.plist`)
const domain = `gui/${uid}`

fs.mkdirSync(support, { recursive: true })
fs.mkdirSync(agents, { recursive: true })
fs.mkdirSync(logs, { recursive: true })
fs.mkdirSync(path.dirname(menuBinary), { recursive: true })
fs.mkdirSync(resources, { recursive: true })
for (const log of [syncLog, menuLog, reminderLog, statusLog]) {
  fs.closeSync(fs.openSync(log, 'a', 0o600))
  fs.chmodSync(log, 0o600)
}

const source = path.join(root, 'macos', 'JiraTimeCopyMenu.swift')
const iconSource = path.join(root, 'macos', 'AppIcon.png')
const cache = path.join(support, 'ModuleCache')
const arch = process.arch === 'x64' ? 'x86_64' : process.arch
fs.mkdirSync(cache, { recursive: true })
const compile = (sdk) => {
  const target = sdk?.match(/MacOSX(\d+\.\d+)\.sdk$/)?.[1]
  return spawnSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      ...(sdk ? ['-sdk', sdk, '-target', `${arch}-apple-macosx${target}`] : []),
      '-O',
      '-framework',
      'AppKit',
      '-framework',
      'UserNotifications',
      source,
      '-o',
      menuBinary,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, SWIFT_MODULECACHE_PATH: cache, CLANG_MODULE_CACHE_PATH: cache },
    },
  )
}
const sdkDir = '/Library/Developer/CommandLineTools/SDKs'
const sdks = fs.existsSync(sdkDir)
  ? fs
      .readdirSync(sdkDir)
      .filter((name) => /^MacOSX\d+\.\d+\.sdk$/.test(name))
      .map((name) => path.join(sdkDir, name))
  : []
let build = compile()
for (const sdk of sdks) {
  if (build.status === 0) break
  build = compile(sdk)
}
if (build.status !== 0) throw new Error(build.stderr.trim() || 'Nie udalo sie zbudowac aplikacji menu bar.')

const writePlist = (file, value) => {
  fs.writeFileSync(file, JSON.stringify(value))
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', file])
}

const iconset = path.join(support, 'AppIcon.iconset')
fs.mkdirSync(iconset, { recursive: true })
for (const [name, size] of [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
])
  execFileSync('/usr/bin/sips', ['-z', String(size), String(size), iconSource, '--out', path.join(iconset, name)], {
    stdio: 'ignore',
  })
const icns = path.join(resources, 'AppIcon.icns')
fs.rmSync(icns, { force: true })
execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icns])
fs.copyFileSync(iconSource, path.join(resources, 'AppIcon.png'))
writePlist(path.join(contents, 'Info.plist'), {
  CFBundleDevelopmentRegion: 'pl',
  CFBundleDisplayName: 'Jira Time Copy',
  CFBundleExecutable: 'JiraTimeCopy',
  CFBundleIconFile: 'AppIcon.icns',
  CFBundleIdentifier: 'dev.this-is-fine.jira-time-copy',
  CFBundleInfoDictionaryVersion: '6.0',
  CFBundleName: 'Jira Time Copy',
  CFBundlePackageType: 'APPL',
  CFBundleShortVersionString: '1.0',
  CFBundleVersion: String(Math.floor(fs.statSync(iconSource).mtimeMs / 1000)),
  LSUIElement: true,
  NSHighResolutionCapable: true,
  NSUserNotificationAlertStyle: 'alert',
})
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' })
execFileSync(
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
  ['-f', app],
  { stdio: 'ignore' },
)
execFileSync(menuBinary, ['--selfcheck'])

writePlist(syncPlist, {
  Label: syncLabel,
  ProgramArguments: [process.execPath, path.join(root, 'jira-time-copy.mjs'), '--commit'],
  WorkingDirectory: root,
  EnvironmentVariables: { HOME: home, JIRA_TIME_COPY_ENV: config, JIRA_TIME_COPY_NOTIFIER: menuBinary },
  StartCalendarInterval: { Hour: hour, Minute: minute },
  StandardOutPath: syncLog,
  StandardErrorPath: syncLog,
})

writePlist(menuPlist, {
  Label: menuLabel,
  ProgramArguments: [menuBinary],
  EnvironmentVariables: {
    HOME: home,
    JIRA_TIME_COPY_ENV: config,
    JIRA_TIME_COPY_NODE: process.execPath,
    JIRA_TIME_COPY_SCRIPT: path.join(root, 'jira-time-copy.mjs'),
    JIRA_TIME_COPY_SCHEDULE: time,
    JIRA_TIME_COPY_REMINDER: reminderTime,
    JIRA_TIME_COPY_STATUS: statusFile,
    JIRA_TIME_COPY_WORKDAY_HOURS: workdayHours,
    JIRA_TIME_COPY_NOTIFIER: menuBinary,
  },
  RunAtLoad: true,
  KeepAlive: { SuccessfulExit: false },
  ProcessType: 'Interactive',
  StandardOutPath: menuLog,
  StandardErrorPath: menuLog,
})

writePlist(reminderPlist, {
  Label: reminderLabel,
  ProgramArguments: [process.execPath, path.join(root, 'jira-time-copy.mjs'), '--remind'],
  WorkingDirectory: root,
  EnvironmentVariables: {
    HOME: home,
    JIRA_TIME_COPY_ENV: config,
    JIRA_TIME_COPY_NOTIFIER: menuBinary,
  },
  StartCalendarInterval: [1, 2, 3, 4, 5].map((Weekday) => ({
    Weekday,
    Hour: reminderHour,
    Minute: reminderMinute,
  })),
  StandardOutPath: reminderLog,
  StandardErrorPath: reminderLog,
})

writePlist(statusPlist, {
  Label: statusLabel,
  ProgramArguments: [process.execPath, path.join(root, 'jira-time-copy.mjs'), '--status'],
  WorkingDirectory: root,
  EnvironmentVariables: { HOME: home, JIRA_TIME_COPY_ENV: config, JIRA_TIME_COPY_STATUS: statusFile },
  RunAtLoad: true,
  StartInterval: 300,
  StandardOutPath: statusLog,
  StandardErrorPath: statusLog,
})

for (const label of [syncLabel, menuLabel, reminderLabel, statusLabel])
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' })
for (const plist of [syncPlist, menuPlist, reminderPlist, statusPlist])
  execFileSync('/bin/launchctl', ['bootstrap', domain, plist])
execFileSync('/bin/launchctl', ['kickstart', `${domain}/${menuLabel}`])

const notification = spawnSync(menuBinary, ['--notify', 'Konfiguracja zakończona. Powiadomienia działają.'], {
  encoding: 'utf8',
})
const persistent =
  notification.status === 0 && spawnSync(menuBinary, ['--notification-check'], { encoding: 'utf8' }).status === 0
if (!persistent) {
  spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.Notifications-Settings.extension'])
  console.warn('macOS: dla „Jira Time Copy” włącz powiadomienia i wybierz styl „Alerty”.')
}

console.log(`macOS: próg ${workdayHours} h, odczyt co 5 min, przypomnienie ${reminderTime}, synchronizacja ${time}, powiadomienia ${persistent ? 'trwałe alerty OK' : 'wymagają ustawienia „Alerty”'}`)
