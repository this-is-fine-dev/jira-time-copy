#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, missingConfig, syncEnabled } from '../lib/config.mjs'

if (process.platform !== 'darwin') throw new Error('Automatyzacja wymaga macOS.')
if (process.argv.includes('--selfcheck')) {
  console.log('ok')
  process.exit(0)
}

const home = os.homedir()
const runtime = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const app = process.argv[3] ?? path.resolve(runtime, '../../..')
const configFile = process.argv[2] ?? path.join(home, '.jira-time-copy.env')
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
const script = path.join(runtime, 'jira-time-copy.mjs')
const menuBinary = path.join(app, 'Contents', 'MacOS', 'ThisIsLogged')
for (const file of [node, script, menuBinary])
  if (!fs.existsSync(file)) throw new Error(`Brak składnika aplikacji: ${file}`)

const support = path.join(home, 'Library', 'Application Support', 'jira-time-copy')
const agents = path.join(home, 'Library', 'LaunchAgents')
const logs = path.join(home, 'Library', 'Logs')
const statusFile = path.join(support, 'status.json')
const labels = {
  menu: 'dev.this-is-fine.jira-time-copy.menu',
  reminder: 'dev.this-is-fine.jira-time-copy.reminder',
  status: 'dev.this-is-fine.jira-time-copy.status',
  sync: 'dev.this-is-fine.jira-time-copy.sync',
}
const plists = Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, path.join(agents, `${label}.plist`)]))
const log = (name) => path.join(logs, `jira-time-copy${name ? `-${name}` : ''}.log`)
const domain = `gui/${uid}`

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
