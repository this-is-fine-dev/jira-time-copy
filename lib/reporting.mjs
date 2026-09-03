const addDays = (date, amount) => {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + amount)
  return value.toISOString().slice(0, 10)
}

const easter = (year) => {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const holidays = (year) => {
  const easterSunday = easter(year)
  return new Set([
    `${year}-01-01`,
    `${year}-01-06`,
    easterSunday,
    addDays(easterSunday, 1),
    `${year}-05-01`,
    `${year}-05-03`,
    addDays(easterSunday, 49),
    addDays(easterSunday, 60),
    `${year}-08-15`,
    `${year}-11-01`,
    `${year}-11-11`,
    `${year}-12-24`,
    `${year}-12-25`,
    `${year}-12-26`,
  ])
}

const workdays = (from, to) => {
  const out = []
  const end = new Date(`${to}T00:00:00Z`)
  for (const date = new Date(`${from}T00:00:00Z`); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    const value = date.toISOString().slice(0, 10)
    if (![0, 6].includes(date.getUTCDay()) && !holidays(date.getUTCFullYear()).has(value)) out.push(value)
  }
  return out
}

// ponytail: dokładny firmowy dzień wolny za święto w sobotę wymaga kalendarza pracodawcy.
const capacityDays = (from, to) =>
  workdays(from, to).length -
  [...new Set([from.slice(0, 4), to.slice(0, 4)])]
    .flatMap((year) => [...holidays(Number(year))])
    .filter((date) => date >= from && date <= to && new Date(`${date}T00:00:00Z`).getUTCDay() === 6).length

const workWeek = (now) => {
  const weekday = new Date(`${now}T12:00:00Z`).getUTCDay()
  const yesterday = addDays(now, -1)
  return weekday === 1
    ? [addDays(now, -7), yesterday]
    : [addDays(now, -(weekday === 0 ? 6 : weekday - 1)), yesterday]
}

const statusRange = (days, targetDays, from, to, expected) => {
  const expectedDays = workdays(from, to)
  const inRange = (date) => date >= from && date <= to
  const sourceSeconds = Object.entries(days)
    .filter(([date]) => inRange(date))
    .reduce((sum, [, value]) => sum + value.secs, 0)
  const targetSeconds = targetDays && Object.entries(targetDays)
    .filter(([date]) => inRange(date))
    .reduce((sum, [, value]) => sum + value.secs, 0)
  const dates = targetDays && [...new Set([...Object.keys(days), ...Object.keys(targetDays)])].filter(inRange).sort()
  return {
    from,
    to,
    workingDays: expectedDays.length,
    sourceSeconds,
    targetSeconds: targetSeconds ?? null,
    missing: expectedDays
      .filter((date) => (days[date]?.secs ?? 0) < expected)
      .map((date) => ({ date, sourceSeconds: days[date]?.secs ?? 0 })),
    differences: dates
      ? dates
          .filter((date) => (days[date]?.secs ?? 0) !== (targetDays[date]?.secs ?? 0))
          .map((date) => ({ date, sourceSeconds: days[date]?.secs ?? 0, targetSeconds: targetDays[date]?.secs ?? 0 }))
      : null,
  }
}

export const today = () => new Date().toLocaleDateString('sv-SE')

export const range = (arg) => {
  if (arg.length === 10) return [arg, arg]
  const [year, month] = arg.split('-').map(Number)
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return [`${arg}-01`, `${arg}-${String(last).padStart(2, '0')}`]
}

export const reportWindow = (now) => {
  const yesterday = addDays(now, -1)
  const [weekFrom] = workWeek(now)
  return [[`${now.slice(0, 7)}-01`, weekFrom, yesterday].sort()[0], now]
}

export const analyzeReports = ({ now, expectedSeconds, sourceDays, targetDays = null }) => {
  const yesterday = addDays(now, -1)
  const [weekFrom, weekTo] = workWeek(now)
  const monthFrom = `${now.slice(0, 7)}-01`
  const monthTo = range(now.slice(0, 7))[1]
  const monthWorkingDays = capacityDays(monthFrom, monthTo)
  return {
    today: statusRange(sourceDays, targetDays, now, now, expectedSeconds),
    yesterday: statusRange(sourceDays, targetDays, yesterday, yesterday, expectedSeconds),
    week: statusRange(sourceDays, targetDays, weekFrom, weekTo, expectedSeconds),
    month: statusRange(sourceDays, targetDays, monthFrom, yesterday, expectedSeconds),
    underreported: workdays(monthFrom, now).filter((date) => (sourceDays[date]?.secs ?? 0) < expectedSeconds),
    monthCapacity: {
      workingDays: monthWorkingDays,
      daysOff: Number(monthTo.slice(8)) - monthWorkingDays,
      expectedSeconds: monthWorkingDays * expectedSeconds,
      reportedSeconds: Object.entries(sourceDays)
        .filter(([date]) => date >= monthFrom && date <= now)
        .reduce((sum, [, value]) => sum + value.secs, 0),
    },
  }
}
