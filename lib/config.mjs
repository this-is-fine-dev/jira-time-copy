import fs from 'node:fs'

export const KEYS = [
  'SRC_URL',
  'SRC_EMAIL',
  'SRC_TOKEN',
  'SYNC_ENABLED',
  'DST_URL',
  'DST_EMAIL',
  'DST_TOKEN',
  'DST_ISSUE',
  'COMMENT_KEYS',
  'SYNC_TIME',
  'REMINDER_TIME',
  'WORKDAY_HOURS',
]

const MONITORING_REQUIRED = ['SRC_URL', 'SRC_TOKEN']
const SYNC_REQUIRED = ['DST_URL', 'DST_TOKEN', 'DST_ISSUE']

export const parseEnv = (text) =>
  Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )

export const readConfig = (file) => parseEnv(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')

export const syncEnabled = (cfg) =>
  cfg.SYNC_ENABLED === '1' ||
  (!Object.hasOwn(cfg, 'SYNC_ENABLED') && SYNC_REQUIRED.every((key) => cfg[key]))

export const loadConfig = (file, env = process.env) => {
  const cfg = {
    ...readConfig(file),
    ...Object.fromEntries(KEYS.filter((key) => env[key] !== undefined).map((key) => [key, env[key]])),
  }
  return { ...cfg, SYNC_ENABLED: syncEnabled(cfg) ? '1' : '0' }
}

export const missingConfig = (cfg, capability = 'monitoring') => {
  const missing = MONITORING_REQUIRED.filter((key) => !cfg[key])
  if (capability === 'sync') {
    if (!syncEnabled(cfg)) missing.push('SYNC_ENABLED')
    missing.push(...SYNC_REQUIRED.filter((key) => !cfg[key]))
  }
  return [...new Set(missing)]
}

export const serializeConfig = (cfg) =>
  '# this-is-logged; EMAIL pusty = token osobisty (Bearer, Jira Server/DC)\n' +
  '# COMMENT_KEYS=1 dopisuje klucze zadan z Jiry glownej do komentarza worklogu\n' +
  KEYS.map((key) => `${key}=${cfg[key] ?? ''}`).join('\n') +
  '\n'
