#!/usr/bin/env node
// Pilnuje raportów w Jirze i opcjonalnie kopiuje je do drugiej instancji.
//
//   pnpm configure                    # konfiguracja (zapisuje do ~/.jira-time-copy.env)
//   pnpm start                        # interaktywnie: wybor okresu, dni i zapisu
//   pnpm start 2026-07                # to samo, z gotowym miesiacem
//   pnpm start 2026-07-15             # to samo, z gotowym dniem
//   pnpm start 2026-07 --commit       # bez pytan (cron): zapisuje, roznice pomija
//   pnpm start 2026-07 --dry-run      # bez pytan: sam podglad, nic nie zapisuje
//
// Zmienne z pliku konfiguracyjnego mozna nadpisac przez env.
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as p from '@clack/prompts'
import {
  loadConfig,
  missingConfig,
  parseEnv,
  readConfig,
  serializeConfig,
  syncEnabled,
} from './lib/config.mjs'
import { analyzeReports, range, reportWindow, today } from './lib/reporting.mjs'

const CONFIG = process.env.THIS_IS_LOGGED_ENV ?? process.env.JIRA_TIME_COPY_ENV ?? path.join(os.homedir(), '.jira-time-copy.env')
const ROOT = path.dirname(fileURLToPath(import.meta.url))

const jira = (base, token, email) => {
  const auth = email
    ? 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64')
    : 'Bearer ' + token
  return async (path, body, method) => {
    const url = base.replace(/\/$/, '') + '/rest/api/2' + path
    const res = await fetch(url, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${url} -> ${res.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }
}

const h = (secs) => (secs / 3600).toFixed(2)
const ident = (a) => a.accountId ?? a.key ?? a.name
const me = (call) => call('/myself')
const day = (wl) => wl.started.slice(0, 10) // "2026-08-27T10:00:00.000+0200"

/** { dzien: { secs, keys[] } } z worklogow uzytkownika */
async function collect(call, uid, from, to) {
  const jql = `worklogAuthor = currentUser() AND worklogDate >= "${from}" AND worklogDate <= "${to}"`
  const days = {}
  for (let start = 0; ; ) {
    const page = await call(
      `/search?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=100&startAt=${start}`,
    )
    for (const issue of page.issues) {
      const { worklogs } = await call(`/issue/${issue.key}/worklog`)
      for (const wl of worklogs) {
        const d = day(wl)
        if (ident(wl.author) !== uid || d < from || d > to) continue
        const e = (days[d] ??= { secs: 0, keys: [] })
        e.secs += wl.timeSpentSeconds
        if (!e.keys.includes(issue.key)) e.keys.push(issue.key)
      }
    }
    start += page.issues.length
    if (start >= page.total || !page.issues.length) return days
  }
}

/** juz zaraportowane w zadaniu docelowym: { dzien: { secs, ids[] } } */
const existingByDay = async (call, issue, uid) => {
  const out = {}
  for (const w of (await call(`/issue/${issue}/worklog`)).worklogs) {
    if (ident(w.author) !== uid) continue
    const e = (out[day(w)] ??= { secs: 0, ids: [] })
    e.secs += w.timeSpentSeconds
    e.ids.push(w.id)
  }
  return out
}

// --- konfiguracja ---------------------------------------------------------

const isCloud = (url) => /\.atlassian\.net/i.test(url)
const normUrl = (url) => (/^https?:\/\//i.test(url) ? url : 'https://' + url).replace(/\/$/, '')

/** przerwanie ctrl-c w dowolnym pytaniu konczy program */
const ask = async (promise) => {
  const v = await promise
  if (p.isCancel(v)) {
    p.cancel('Przerwane.')
    process.exit(0)
  }
  return v
}

async function setup() {
  const old = readConfig(CONFIG)
  p.intro('This Is Logged — konfiguracja')

  const askJira = async (title, pre, defUrl) => {
    p.log.step(title)
    const url = normUrl(
      await ask(
        p.text({
          message: 'URL Jiry',
          placeholder: defUrl,
          initialValue: old[`${pre}_URL`] || defUrl,
          validate: (v) => (v.trim() ? undefined : 'podaj adres'),
        }),
      ),
    )
    const cloud = isCloud(url)
    p.log.info(
      cloud
        ? 'Jira Cloud — token generujesz na koncie Atlassian, nie w Jirze:\n' +
            'https://id.atlassian.com/manage-profile/security/api-tokens → "Create API token" (zwykly, bez scope)'
        : `Jira Server/DC — token generujesz w profilu:\n${url}/secure/ViewProfile.jspa → zakladka "Personal Access Tokens"`,
    )
    const email = cloud
      ? await ask(
          p.text({
            message: 'Email konta Atlassian',
            initialValue: old[`${pre}_EMAIL`] ?? '',
            validate: (v) => (v.includes('@') ? undefined : 'podaj adres email'),
          }),
        )
      : ''
    const had = old[`${pre}_TOKEN`]
    const token =
      (await ask(p.password({ message: had ? 'Token (Enter = bez zmian)' : 'Token' }))) || had
    if (!token) {
      p.cancel('Bez tokenu ani rusz.')
      process.exit(1)
    }
    return { [`${pre}_URL`]: url, [`${pre}_EMAIL`]: email, [`${pre}_TOKEN`]: token }
  }

  const useSync = await ask(
    p.confirm({
      message: 'Synchronizować raporty z drugą Jirą?',
      initialValue: syncEnabled(old),
    }),
  )
  const cfg = {
    ...old,
    ...(await askJira('Jira GŁÓWNA — tutaj raportujesz czas', 'SRC', 'https://jira.firma.pl')),
    SYNC_ENABLED: useSync ? '1' : '0',
  }

  if (useSync) {
    Object.assign(cfg, await askJira('Jira DOCELOWA — opcjonalna kopia raportów', 'DST', ''))
    cfg.DST_ISSUE = await ask(
      p.text({
        message: 'Klucz zbiorczego zadania',
        placeholder: 'AUT-123',
        initialValue: old.DST_ISSUE ?? '',
        validate: (v) => (/^[A-Z][A-Z0-9]*-\d+$/i.test(v.trim()) ? undefined : 'np. AUT-123'),
      }),
    )
    cfg.DST_ISSUE = cfg.DST_ISSUE.trim().toUpperCase()
    cfg.COMMENT_KEYS = (await ask(
      p.confirm({
        message: 'Dopisywać klucze zadań z Jiry głównej do komentarza worklogu?',
        initialValue: old.COMMENT_KEYS === '1',
      }),
    ))
      ? '1'
      : '0'
  }

  if (process.platform === 'darwin' && useSync)
    cfg.SYNC_TIME = (
      await ask(
        p.text({
          message: 'Godzina codziennej automatycznej synchronizacji',
          initialValue: old.SYNC_TIME || '23:00',
          validate: (v) => (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? undefined : 'format GG:MM'),
        }),
      )
    ).trim()
  if (process.platform === 'darwin')
    cfg.REMINDER_TIME = (
      await ask(
        p.text({
          message: 'Godzina przypomnienia o brakujacych worklogach',
          initialValue: old.REMINDER_TIME || '16:00',
          validate: (v) => (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? undefined : 'format GG:MM'),
        }),
      )
    ).trim()
  if (process.platform === 'darwin') {
    const hours = await ask(
      p.text({
        message: 'Ile godzin oznacza pełny dzień pracy?',
        initialValue: old.WORKDAY_HOURS || '8',
        validate: (v) => {
          const n = Number(v.trim().replace(',', '.'))
          return n > 0 && n <= 24 ? undefined : 'podaj liczbę od 0 do 24, np. 8'
        },
      }),
    )
    cfg.WORKDAY_HOURS = String(Number(hours.trim().replace(',', '.')))
  }

  const s = p.spinner()
  s.start(useSync ? 'Sprawdzam dostęp do obu Jir' : 'Sprawdzam dostęp do Jiry')
  try {
    const src = jira(cfg.SRC_URL, cfg.SRC_TOKEN, cfg.SRC_EMAIL)
    const user = await me(src)
    const lines = [`Jira:    ${user.displayName} @ ${cfg.SRC_URL}`]
    if (useSync) {
      const dst = jira(cfg.DST_URL, cfg.DST_TOKEN, cfg.DST_EMAIL)
      const targetUser = await me(dst)
      const issue = await dst(`/issue/${cfg.DST_ISSUE}?fields=summary`)
      lines.push(`Cel:     ${targetUser.displayName} @ ${cfg.DST_URL}`)
      lines.push(`Zadanie: ${issue.key} — ${issue.fields.summary}`)
    }
    s.stop('Dostęp OK')
    p.note(lines.join('\n'))
  } catch (e) {
    s.stop('Nie udalo sie zalogowac', 1)
    p.log.error(e.message)
    if (/ 40[13]/.test(e.message))
      p.log.info(
        'Cloud: email = adres konta Atlassian, token z id.atlassian.com.\n' +
          'Server/DC: email zostaje pusty, token osobisty z profilu w Jirze.',
      )
    p.cancel('Nic nie zapisano.')
    process.exit(1)
  }

  fs.writeFileSync(CONFIG, serializeConfig(cfg), { mode: 0o600 })
  fs.chmodSync(CONFIG, 0o600)

  if (process.platform === 'darwin') {
    try {
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'macos/install.mjs'), CONFIG],
        { stdio: 'inherit' },
      )
    } catch {
      p.cancel(`Konfiguracja Jiry zapisana w ${CONFIG}, ale instalacja aplikacji macOS nie powiodla sie.`)
      process.exit(1)
    }
  }

  p.outro(
    process.platform === 'darwin'
      ? useSync
        ? `Gotowe — przypomnienie ${cfg.REMINDER_TIME}, synchronizacja ${cfg.SYNC_TIME}.`
        : `Gotowe — monitoring co minutę, przypomnienie ${cfg.REMINDER_TIME}.`
      : `Zapisano ${CONFIG}.`,
  )
}

async function checkConfig() {
  const cfg = loadConfig(CONFIG)
  need(cfg, syncEnabled(cfg) ? 'sync' : 'monitoring')
  const source = await me(jira(cfg.SRC_URL, cfg.SRC_TOKEN, cfg.SRC_EMAIL))
  const result = { source: source.displayName ?? ident(source) }
  if (syncEnabled(cfg)) {
    const dst = jira(cfg.DST_URL, cfg.DST_TOKEN, cfg.DST_EMAIL)
    const target = await me(dst)
    const issue = await dst(`/issue/${cfg.DST_ISSUE}?fields=summary`)
    result.target = target.displayName ?? ident(target)
    result.issue = `${issue.key} — ${issue.fields.summary}`
  }
  console.log(JSON.stringify(result))
}

// --- wspolne dla obu trybow ----------------------------------------------

const need = (cfg, capability = 'monitoring') => {
  const missing = missingConfig(cfg, capability)
  if (missing.length) {
    const message = capability === 'sync' && missing.includes('SYNC_ENABLED')
      ? 'Synchronizacja z drugą Jirą nie jest skonfigurowana. Uruchom: pnpm configure'
      : `Brak konfiguracji (${missing.join(', ')}). Uruchom: pnpm configure`
    throw new Error(message)
  }
}

const poster = (dst, issue, withKeys) => (d, secs, keys) =>
  dst(`/issue/${issue}/worklog`, {
    started: `${d}T09:00:00.000+0000`,
    timeSpentSeconds: secs,
    ...(withKeys ? { comment: keys.join(', ') } : {}),
  })

const syncState = (sourceSecs, target) =>
  !target?.secs ? 'add' : target.secs === sourceSecs ? 'synced' : 'collision'

const fetchBoth = async (cfg, from, to) => {
  const src = jira(cfg.SRC_URL, cfg.SRC_TOKEN, cfg.SRC_EMAIL)
  const dst = jira(cfg.DST_URL, cfg.DST_TOKEN, cfg.DST_EMAIL)
  const days = await collect(src, ident(await me(src)), from, to)
  const done = await existingByDay(dst, cfg.DST_ISSUE, ident(await me(dst)))
  return { dst, days, done }
}

const notification = (message, collision = false) => {
  const notifier = process.env.THIS_IS_LOGGED_NOTIFIER ?? process.env.JIRA_TIME_COPY_NOTIFIER
  if (notifier)
    return execFileSync(notifier, [collision ? '--notify-collision' : '--notify', message])
  return execFileSync('/usr/bin/osascript', [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 1 of argv) with title "This Is Logged"',
      '-e',
      'end run',
      message,
    ])
}

async function remind() {
  const cfg = loadConfig(CONFIG)
  need(cfg)
  const now = today()
  const [from, to] = reportWindow(now)
  const expectedHours = Number(cfg.WORKDAY_HOURS || 8)
  if (!(expectedHours > 0 && expectedHours <= 24)) throw new Error('WORKDAY_HOURS musi być liczbą od 0 do 24.')
  const expected = expectedHours * 3600
  let days

  try {
    const src = jira(cfg.SRC_URL, cfg.SRC_TOKEN, cfg.SRC_EMAIL)
    days = await collect(src, ident(await me(src)), from, to)
  } catch (e) {
    notification('Nie udało się sprawdzić brakujących worklogów w Jirze.')
    throw e
  }

  const short = analyzeReports({ now, expectedSeconds: expected, sourceDays: days }).underreported
  if (!short.length) {
    console.log(`${new Date().toISOString()} wszystkie dni robocze mają co najmniej ${h(expected)}h`)
    return
  }

  const earlier = short
    .filter((d) => d !== now)
    .map((d) => `${d.slice(8)}.${d.slice(5, 7)} (${h(days[d]?.secs ?? 0)}/${h(expected)} h)`)
  const parts = []
  if (short.includes(now))
    parts.push(`Dzisiaj masz ${h(days[now]?.secs ?? 0)} z oczekiwanych ${h(expected)} h w Jirze.`)
  if (earlier.length) parts.push(`Niepełne poprzednie dni: ${earlier.join(', ')}.`)
  notification(parts.join(' '))
  console.log(`${new Date().toISOString()} przypomnienie: ${short.join(', ')}`)
}

async function pollStatus() {
  const cfg = loadConfig(CONFIG)
  need(cfg)
  const now = today()
  const [from, to] = reportWindow(now)
  const expectedHours = Number(cfg.WORKDAY_HOURS || 8)
  if (!(expectedHours > 0 && expectedHours <= 24)) throw new Error('WORKDAY_HOURS musi być liczbą od 0 do 24.')
  const expected = expectedHours * 3600
  const file = process.env.THIS_IS_LOGGED_STATUS ?? process.env.JIRA_TIME_COPY_STATUS ?? path.join(os.homedir(), 'Library', 'Application Support', 'jira-time-copy', 'status.json')
  let state = {
    checkedAt: new Date().toISOString(),
    expectedSeconds: expected,
    syncEnabled: syncEnabled(cfg),
  }
  try {
    const src = jira(cfg.SRC_URL, cfg.SRC_TOKEN, cfg.SRC_EMAIL)
    const days = await collect(src, ident(await me(src)), from, to)
    let done = null
    if (syncEnabled(cfg)) {
      try {
        const dst = jira(cfg.DST_URL, cfg.DST_TOKEN, cfg.DST_EMAIL)
        done = await existingByDay(dst, cfg.DST_ISSUE, ident(await me(dst)))
      } catch (e) {
        state.targetError = String(e.message).slice(0, 300)
      }
    }
    const reports = analyzeReports({ now, expectedSeconds: expected, sourceDays: days, targetDays: done })
    state = {
      ...state,
      seconds: days[now]?.secs ?? 0,
      ...reports,
    }
  } catch (e) {
    state.error = String(e.message).slice(0, 300)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
  if (state.error || state.targetError) throw new Error(state.error ?? state.targetError)
  const target = state.syncEnabled ? `, cel: ${h(state.month.targetSeconds)}h` : ''
  console.log(`${state.checkedAt} miesiąc: ${h(state.month.sourceSeconds)}/${h(state.monthCapacity.expectedSeconds)}h${target}`)
}

// --- tryb interaktywny ----------------------------------------------------

async function tui(args) {
  const cfg = loadConfig(CONFIG)
  need(cfg, 'sync')
  p.intro(`This Is Logged → ${cfg.DST_ISSUE}`)

  const now = today()
  const prev = new Date(now.slice(0, 8) + '01')
  prev.setMonth(prev.getMonth() - 1)
  const prevMonth = prev.toLocaleDateString('sv-SE').slice(0, 7)

  let arg = args.find((a) => /^\d{4}-\d{2}(-\d{2})?$/.test(a))
  if (!arg) {
    arg = await ask(
      p.select({
        message: 'Co przenosimy?',
        options: [
          { value: prevMonth, label: `Poprzedni miesiac (${prevMonth})` },
          { value: now.slice(0, 7), label: `Biezacy miesiac (${now.slice(0, 7)})` },
          { value: now, label: `Dzisiaj (${now})` },
          { value: '', label: 'Inna data...' },
        ],
      }),
    )
    if (!arg)
      arg = await ask(
        p.text({
          message: 'Miesiac (RRRR-MM) albo dzien (RRRR-MM-DD)',
          validate: (v) => (/^\d{4}-\d{2}(-\d{2})?$/.test(v.trim()) ? undefined : 'format RRRR-MM albo RRRR-MM-DD'),
        }),
      )
    arg = arg.trim()
  }
  const [from, to] = range(arg)

  const s = p.spinner()
  s.start(`Pobieram czas z ${cfg.SRC_URL} (${arg})`)
  let dst, days, done
  try {
    ;({ dst, days, done } = await fetchBoth(cfg, from, to))
  } catch (e) {
    s.stop('Nie udalo sie pobrac', 1)
    p.log.error(e.message)
    p.cancel('Koniec.')
    process.exit(1)
  }
  const all = Object.keys(days).sort()
  s.stop(`Znalazlem ${all.length} dni, razem ${h(all.reduce((a, d) => a + days[d].secs, 0))}h`)

  if (!all.length) {
    p.outro('Nic do przeniesienia.')
    return
  }

  const picked = await ask(
    p.multiselect({
      message: 'Ktore dni przeniesc? (spacja = zaznacz, enter = dalej)',
      options: all.map((d) => ({
        value: d,
        label: `${d}  ${h(days[d].secs).padStart(5)}h`,
        hint: done[d]
          ? `w ${cfg.DST_ISSUE} masz juz ${h(done[d].secs)}h — ${days[d].keys.join(', ')}`
          : days[d].keys.join(', '),
      })),
      initialValues: all.filter((d) => !done[d]),
      required: false,
    }),
  )
  if (!picked.length) {
    p.outro('Nic nie wybrano.')
    return
  }

  const plan = []
  for (const d of picked) {
    if (!done[d]) {
      plan.push({ d, what: 'add' })
      continue
    }
    const what = await ask(
      p.select({
        message: `${d}: w ${cfg.DST_ISSUE} masz juz ${h(done[d].secs)}h, z WP wychodzi ${h(days[d].secs)}h`,
        options: [
          { value: 'add', label: `Zsumuj → ${h(done[d].secs + days[d].secs)}h` },
          { value: 'skip', label: `Pomin → zostaje ${h(done[d].secs)}h` },
          { value: 'replace', label: `Nadpisz → ${h(days[d].secs)}h (kasuje twoje ${done[d].ids.length} wpisy z tego dnia)` },
        ],
      }),
    )
    plan.push({ d, what })
  }

  const todo = plan.filter((x) => x.what !== 'skip')
  if (!todo.length) {
    p.outro('Nic do zapisania.')
    return
  }
  const sum = todo.reduce((a, x) => a + days[x.d].secs, 0)
  p.note(
    todo
      .map((x) => `${x.d}  ${h(days[x.d].secs).padStart(5)}h  ${x.what === 'replace' ? '(nadpisze)' : ''}`)
      .join('\n'),
    `Do zapisania: ${h(sum)}h w ${cfg.DST_ISSUE}`,
  )
  if (!(await ask(p.confirm({ message: `Zapisac ${h(sum)}h do ${cfg.DST_ISSUE}?`, initialValue: false })))) {
    p.outro('Anulowane, nic nie zapisano.')
    return
  }

  const add = poster(dst, cfg.DST_ISSUE, cfg.COMMENT_KEYS === '1')
  const s2 = p.spinner()
  s2.start('Zapisuje')
  try {
    for (const { d, what } of todo) {
      s2.message(`Zapisuje ${d}`)
      if (what === 'replace')
        for (const id of done[d].ids) await dst(`/issue/${cfg.DST_ISSUE}/worklog/${id}`, null, 'DELETE')
      await add(d, days[d].secs, days[d].keys)
    }
  } catch (e) {
    s2.stop('Blad w trakcie zapisu', 1)
    p.log.error(e.message)
    p.cancel('Czesc dni mogla sie zapisac — sprawdz w Jirze.')
    process.exit(1)
  }
  s2.stop(`Zapisane: ${todo.length} dni, ${h(sum)}h`)
  p.outro(`${cfg.DST_URL}/browse/${cfg.DST_ISSUE}`)
}

// --- tryb bez pytan (cron, potok) ----------------------------------------

async function run(args) {
  const commit = args.includes('--commit')
  if (commit) console.log(`\n--- ${new Date().toISOString()} ---`)
  const arg =
    args.find((a) => /^\d{4}-\d{2}(-\d{2})?$/.test(a)) ?? today().slice(0, 7)
  const [from, to] = range(arg)
  const cfg = loadConfig(CONFIG)
  need(cfg, 'sync')

  const { dst, days, done } = await fetchBoth(cfg, from, to)
  const add = poster(dst, cfg.DST_ISSUE, cfg.COMMENT_KEYS === '1')

  let total = 0
  let collisions = 0
  for (const d of Object.keys(days).sort()) {
    const { secs, keys } = days[d]
    const state = syncState(secs, done[d])
    if (state === 'synced') {
      console.log(`${d}  ${h(secs)}h  już zsynchronizowane`)
      continue
    }
    if (state === 'collision') {
      collisions++
      console.log(`${d}  ${h(secs)}h  KOLIZJA: w celu masz ${h(done[d].secs)}h - pomijam`)
      continue
    }
    total += secs
    console.log(`${d}  ${h(secs)}h  ${keys.join(', ')}`)
    if (commit) await add(d, secs, keys)
  }
  console.log(
    `\n${commit ? 'zapisano' : 'PODGLAD (dopisz --commit)'}: ${h(total)}h -> ${cfg.DST_ISSUE} (${arg})`,
  )
  if (commit && collisions)
    try {
      notification(
        `Wykryto ${collisions} ${collisions === 1 ? 'różnicę' : 'różnice'} w ${arg}. Automatyzacja niczego nie nadpisała.`,
        true,
      )
    } catch (e) {
      console.error(`Nie udało się wyświetlić powiadomienia o kolizjach: ${e.message}`)
    }
}

async function selfcheck() {
  let n = 0
  const wl = (started, timeSpentSeconds, name = 'u1') => ({
    id: String(++n), started, timeSpentSeconds, author: { name },
  })
  const issues = {
    'WP-1': [
      wl('2026-07-01T10:00:00.000+0200', 3600),
      wl('2026-07-01T13:00:00.000+0200', 1800),
      wl('2026-06-30T13:00:00.000+0200', 999), // poza zakresem
      wl('2026-07-02T13:00:00.000+0200', 999, 'inny'),
    ],
    'WP-2': [wl('2026-07-01T15:00:00.000+0200', 900)],
  }
  const fake = async (p) =>
    p.startsWith('/search')
      ? { issues: Object.keys(issues).map((key) => ({ key })), total: 2 }
      : { worklogs: issues[p.split('/')[2]] }

  assert.deepEqual(range('2026-07'), ['2026-07-01', '2026-07-31'])
  assert.deepEqual(range('2026-02'), ['2026-02-01', '2026-02-28'])
  assert.deepEqual(range('2026-07-15'), ['2026-07-15', '2026-07-15'])
  const reports = analyzeReports({
    now: '2026-09-03',
    expectedSeconds: 28800,
    sourceDays: { '2026-09-01': { secs: 7200 }, '2026-09-02': { secs: 28800 } },
    targetDays: { '2026-09-01': { secs: 3600 }, '2026-09-02': { secs: 28800 } },
  })
  assert.deepEqual(reports.underreported, ['2026-09-01', '2026-09-03'])
  assert.deepEqual([reports.week.from, reports.week.to], ['2026-08-31', '2026-09-02'])
  assert.deepEqual(reports.month.missing, [{ date: '2026-09-01', sourceSeconds: 7200 }])
  assert.deepEqual(reports.month.differences, [{ date: '2026-09-01', sourceSeconds: 7200, targetSeconds: 3600 }])
  assert.deepEqual(reports.monthCapacity, {
    workingDays: 22,
    daysOff: 8,
    expectedSeconds: 633600,
    reportedSeconds: 36000,
  })
  assert.deepEqual(
    analyzeReports({ now: '2026-09-07', expectedSeconds: 28800, sourceDays: {} }).week.from,
    '2026-08-31',
  )
  const monitoring = analyzeReports({ now: '2026-12-28', expectedSeconds: 28800, sourceDays: {} })
  assert.equal(monitoring.today.differences, null)
  assert.ok(monitoring.month.missing.some(({ date }) => date === '2026-12-23'))
  assert.ok(!monitoring.month.missing.some(({ date }) => ['2026-12-24', '2026-12-25', '2026-12-26'].includes(date)))
  assert.equal(analyzeReports({ now: '2026-08-03', expectedSeconds: 28800, sourceDays: {} }).monthCapacity.workingDays, 20)
  assert.deepEqual(await collect(fake, 'u1', ...range('2026-07')), {
    '2026-07-01': { secs: 6300, keys: ['WP-1', 'WP-2'] },
  })
  assert.deepEqual(await existingByDay(fake, 'WP-1', 'u1'), {
    '2026-07-01': { secs: 5400, ids: ['1', '2'] },
    '2026-06-30': { secs: 999, ids: ['3'] },
  })
  assert.deepEqual(parseEnv('# komentarz\nSRC_URL=https://a/b\nDST_TOKEN=x=y=z\n\n'), {
    SRC_URL: 'https://a/b',
    DST_TOKEN: 'x=y=z',
  })
  assert.ok(syncEnabled({ DST_URL: 'https://b', DST_TOKEN: 'x', DST_ISSUE: 'ABC-1' }))
  assert.ok(!syncEnabled({ SYNC_ENABLED: '0', DST_URL: 'https://b', DST_TOKEN: 'x', DST_ISSUE: 'ABC-1' }))
  assert.deepEqual(missingConfig({ SRC_URL: 'https://a', SRC_TOKEN: 'x' }), [])
  assert.deepEqual(missingConfig({ SRC_URL: 'https://a', SRC_TOKEN: 'x' }, 'sync'), [
    'SYNC_ENABLED',
    'DST_URL',
    'DST_TOKEN',
    'DST_ISSUE',
  ])
  assert.equal(syncState(3600), 'add')
  assert.equal(syncState(3600, { secs: 3600 }), 'synced')
  assert.equal(syncState(3600, { secs: 1800 }), 'collision')
  const sent = []
  const capture = async (path, body) => void sent.push(body)
  await poster(capture, 'AUT-1', false)('2026-07-01', 3600, ['WP-1'])
  await poster(capture, 'AUT-1', true)('2026-07-01', 3600, ['WP-1', 'WP-2'])
  assert.deepEqual(sent, [
    { started: '2026-07-01T09:00:00.000+0000', timeSpentSeconds: 3600 },
    { started: '2026-07-01T09:00:00.000+0000', timeSpentSeconds: 3600, comment: 'WP-1, WP-2' },
  ])
  assert.equal(normUrl('firma.atlassian.net/'), 'https://firma.atlassian.net')
  assert.ok(isCloud('https://firma.atlassian.net') && !isCloud('https://jira.firma.pl'))
  console.log('ok')
}

const args = process.argv.slice(2)
const plain = args.includes('--dry-run') || args.includes('--plain')
const interactive = process.stdin.isTTY && !args.includes('--commit') && !plain
try {
  await (args.includes('--selfcheck')
    ? selfcheck()
    : args.includes('--check-config')
      ? checkConfig()
    : args[0] === 'setup'
      ? setup()
      : args.includes('--remind')
        ? remind()
        : args.includes('--status')
          ? pollStatus()
          : interactive
            ? tui(args)
            : run(args))
} catch (e) {
  console.error(args.includes('--commit') ? `niepowodzenie: ${e.message}` : e.message)
  process.exitCode = 1
}
