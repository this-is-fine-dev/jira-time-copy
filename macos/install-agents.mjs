#!/usr/bin/env node
import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, missingConfig, syncEnabled } from '../lib/config.mjs'

const migrate = (old, current) => {
  if (!fs.existsSync(old)) return
  fs.mkdirSync(path.dirname(current), { recursive: true })
  if (!fs.existsSync(current)) fs.renameSync(old, current)
  else fs.rmSync(old, { force: true })
}

if (process.platform !== 'darwin') throw new Error('Automatyzacja wymaga macOS.')
if (process.argv.includes('--selfcheck')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'this-is-logged-migration-'))
  try {
    const old = path.join(directory, 'old', 'status.json')
    const current = path.join(directory, 'new', 'status.json')
    fs.mkdirSync(path.dirname(old), { recursive: true })
    fs.writeFileSync(old, 'cached')
    migrate(old, current)
    assert.equal(fs.readFileSync(current, 'utf8'), 'cached')
    assert.ok(!fs.existsSync(old))
    fs.writeFileSync(old, 'stale')
    migrate(old, current)
    assert.equal(fs.readFileSync(current, 'utf8'), 'cached')
    assert.ok(!fs.existsSync(old))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
  console.log('ok')
  process.exit(0)
}

const home = os.homedir()
const runtime = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const app = process.argv[3] ?? path.resolve(runtime, '../../..')
const configFile = process.argv[2] ?? path.join(home, '.this-is-logged.env')
const legacyConfig = path.join(home, '.jira-time-copy.env')
if (configFile === path.join(home, '.this-is-logged.env') && !fs.existsSync(configFile) && fs.existsSync(legacyConfig))
  fs.renameSync(legacyConfig, configFile)
const cfg = loadConfig(configFile)
const synchronization = syncEnabled(cfg)
const missing = missingConfig(cfg, synchronization ? 'sync' : 'monitoring')
if (missing.length) throw new Error(`Brak konfiguracji: ${missing.join(', ')}`)

const clock = (value, name) => {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`Nieprawidłowa godzina ${name}: ${value}`)
  return value.split(':').map(Number)
}
const [hour, minute] = synchronization ? clock(cfg.SYNC_TIME || '23:00', 'synchronizacji') : [23, 0]
const [reminderHour, reminderMinute] = clock(cfg.REMINDER_TIME || '16:00', 'przypomnienia')
const workdayHours = cfg.WORKDAY_HOURS || '8'
if (!(Number(workdayHours) > 0 && Number(workdayHours) <= 24))
  throw new Error(`Nieprawidłowa liczba godzin dnia pracy: ${workdayHours}`)

const uid = process.getuid()
const node = process.execPath
const script = path.join(runtime, 'this-is-logged.mjs')
const menuBinary = path.join(app, 'Contents', 'MacOS', 'ThisIsLogged')
for (const file of [node, script, menuBinary])
  if (!fs.existsSync(file)) throw new Error(`Brak składnika aplikacji: ${file}`)

const support = path.join(home, 'Library', 'Application Support', 'this-is-logged')
const legacySupport = path.join(home, 'Library', 'Application Support', 'jira-time-copy')
const agents = path.join(home, 'Library', 'LaunchAgents')
const logs = path.join(home, 'Library', 'Logs')
const statusFile = path.join(support, 'status.json')
const labels = {
  menu: 'dev.this-is-fine.this-is-logged.menu',
  reminder: 'dev.this-is-fine.this-is-logged.reminder',
  status: 'dev.this-is-fine.this-is-logged.status',
  sync: 'dev.this-is-fine.this-is-logged.sync',
}
const legacyLabels = Object.fromEntries(Object.keys(labels).map((key) => [key, `dev.this-is-fine.jira-time-copy.${key}`]))
const plists = Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, path.join(agents, `${label}.plist`)]))
const log = (name) => path.join(logs, `this-is-logged${name ? `-${name}` : ''}.log`)
const legacyLog = (name) => path.join(logs, `jira-time-copy${name ? `-${name}` : ''}.log`)
const domain = `gui/${uid}`

for (const label of Object.values(legacyLabels))
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' })
for (const label of Object.values(legacyLabels)) fs.rmSync(path.join(agents, `${label}.plist`), { force: true })

migrate(path.join(legacySupport, 'status.json'), statusFile)
fs.rmSync(legacySupport, { recursive: true, force: true })
for (const name of ['', 'menu', 'reminder', 'status']) migrate(legacyLog(name), log(name))
if (configFile !== legacyConfig && fs.existsSync(legacyConfig)) fs.rmSync(legacyConfig)

for (const directory of [support, agents, logs]) fs.mkdirSync(directory, { recursive: true })
for (const file of [log(''), log('menu'), log('reminder'), log('status')]) {
  fs.closeSync(fs.openSync(file, 'a', 0o600))
  fs.chmodSync(file, 0o600)
}

const writePlist = (file, value) => {
  fs.writeFileSync(file, JSON.stringify(value))
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', file])
}
const backend = (args, stdout) => ({
  ProgramArguments: [node, script, ...args],
  WorkingDirectory: runtime,
  EnvironmentVariables: { HOME: home, THIS_IS_LOGGED_ENV: configFile, THIS_IS_LOGGED_NOTIFIER: menuBinary },
  StandardOutPath: stdout,
  StandardErrorPath: stdout,
})

if (synchronization)
  writePlist(plists.sync, {
    Label: labels.sync,
    ...backend(['--commit'], log('')),
    StartCalendarInterval: { Hour: hour, Minute: minute },
  })
else fs.rmSync(plists.sync, { force: true })

writePlist(plists.reminder, {
  Label: labels.reminder,
  ...backend(['--remind'], log('reminder')),
  StartCalendarInterval: [1, 2, 3, 4, 5].map((Weekday) => ({ Weekday, Hour: reminderHour, Minute: reminderMinute })),
})
writePlist(plists.status, {
  Label: labels.status,
  ...backend(['--status'], log('status')),
  EnvironmentVariables: {
    HOME: home,
    THIS_IS_LOGGED_ENV: configFile,
    THIS_IS_LOGGED_STATUS: statusFile,
  },
  RunAtLoad: true,
  StartInterval: 60,
})
writePlist(plists.menu, {
  Label: labels.menu,
  ProgramArguments: ['/usr/bin/open', '-g', app],
  RunAtLoad: true,
  StandardOutPath: log('menu'),
  StandardErrorPath: log('menu'),
})

for (const label of Object.values(labels))
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' })
for (const key of ['reminder', 'status', ...(synchronization ? ['sync'] : []), 'menu'])
  execFileSync('/bin/launchctl', ['bootstrap', domain, plists[key]])
execFileSync('/bin/launchctl', ['kickstart', `${domain}/${labels.status}`])

console.log(
  `Monitoring co 1 min, przypomnienie ${cfg.REMINDER_TIME || '16:00'}, ` +
    (synchronization ? `synchronizacja ${cfg.SYNC_TIME || '23:00'}.` : 'synchronizacja wyłączona.'),
)
