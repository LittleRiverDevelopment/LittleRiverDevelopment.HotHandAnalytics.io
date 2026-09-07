#!/usr/bin/env node
// Regenerates lib/bet-history.ts from the published "Bets" Google Sheet.
//
// Why this runs server-side (GitHub Actions) instead of client-side in the browser:
// Google's CSV export endpoint (docs.google.com/.../export?format=csv) responds with
// a 307 redirect to a googleusercontent.com URL. The redirect *target* has permissive
// CORS (Access-Control-Allow-Origin: *), but the initial redirect response from
// docs.google.com does not — and the Fetch spec applies the CORS check to that first
// response before it's ever followed. So a browser fetch() is blocked by CORS before
// it gets anywhere near the CORS-friendly response. Fetching from Node sidesteps this
// entirely since CORS is a browser-enforced restriction, not a server-side one.
//
// Usage:
//   node scripts/sync-bet-history.mjs             # fetch from the live sheet
//   node scripts/sync-bet-history.mjs path.csv     # parse a local CSV (for testing)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_FILE = path.join(__dirname, '..', 'lib', 'bet-history.ts')

const SHEET_ID = '17t5PucX0lRRI--28lau67isWQtSvSwn3a9BgcEdP3W4'
const SHEET_GID = '1501232229'
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`

// The sheet only records month/day (e.g. "Jan 26"); the year is inferred by starting
// at this anchor and rolling forward whenever the month number decreases (e.g. Dec -> Jan).
const TRACKER_START_YEAR = 2026

// The published Bets tab is the source of truth, but it is updated by hand.
// If a row is still marked Open after the games have final scores, overlay the
// graded result here so the site does not stay stale until the next sheet edit.
// Drop an entry once the sheet itself has Status / Units W/L / Running Total filled in.
export const SETTLEMENT_OVERRIDES = [
  {
    date: '2026-09-06',
    descriptionIncludes: 'Washington ML',
    wl: -1,
    // Washington 24-10 vs WSU (ML W)
    // Ole Miss 41-38 vs Louisville (ML W)
    // Wisconsin 13-41 vs Notre Dame (lost by 28 → +27.5 L)
    // 3-leg parlay loses; 1u at +140 → -1u
  },
]

const MONTHS = {
  Jan: 1, January: 1,
  Feb: 2, February: 2,
  Mar: 3, March: 3,
  Apr: 4, April: 4,
  May: 5,
  Jun: 6, June: 6,
  Jul: 7, July: 7,
  Aug: 8, August: 8,
  Sep: 9, Sept: 9, September: 9,
  Oct: 10, October: 10,
  Nov: 11, November: 11,
  Dec: 12, December: 12,
}

// Minimal RFC4180-ish CSV parser: handles quoted fields with embedded commas/newlines
// and "" escaped quotes (needed for multi-line bet descriptions in the sheet export).
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += c
    i++
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// Safely parses a numeric cell, collapsing blanks *and* any non-numeric text
// (e.g. the sheet writes the literal word "Open" into the W/L and Running Total
// columns for a live bet) down to null instead of leaking NaN into the output.
function parseNum(raw) {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = parseFloat(trimmed)
  return Number.isNaN(n) ? null : n
}

function cleanDescription(desc) {
  return desc
    .replace(/\r\n|\r|\n/g, ' • ')
    .replace(/✅/g, '')
    .replace(/\s+•/g, ' •')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[•+]\s*$/, '')
    .trim()
}

export function parseBetSheetCsv(csvText) {
  const rows = parseCsv(csvText)
  const dataRows = rows.slice(1).filter(r => r.some(c => c.trim() !== ''))

  let year = TRACKER_START_YEAR
  let lastMonth = 0
  let cumulative = 0

  const bets = []

  for (const cols of dataRows) {
    const [dateLabel, descRaw, sportRaw, bookRaw, unitsRaw, oddsRaw, statusRaw, wlRaw, runningRaw, tailLinkRaw] = cols
    if (!dateLabel || !dateLabel.trim()) continue

    const [monLabel, dayLabel] = dateLabel.trim().split(/\s+/)
    const month = MONTHS[monLabel]
    if (!month || !dayLabel) continue

    const units = parseFloat(unitsRaw)
    const odds = parseInt(oddsRaw, 10)
    if (Number.isNaN(units) || Number.isNaN(odds)) continue // skip malformed/blank template rows

    if (month < lastMonth) year += 1
    lastMonth = month

    const date = `${year}-${String(month).padStart(2, '0')}-${dayLabel.padStart(2, '0')}`
    const description = cleanDescription(descRaw || '')
    let sport = (sportRaw || '').trim()
    if (sport === 'ML') sport = 'MLB' // data-entry slip seen in the sheet (e.g. "All-Star NRFI")
    const book = (bookRaw || '').trim()
    const statusText = (statusRaw || '').trim()
    let wl = parseNum(wlRaw)
    const running = parseNum(runningRaw)
    const tailLink = (tailLinkRaw || '').trim() || undefined
    // Trust the Status column as the source of truth for "still live" — the sheet
    // also writes the literal text "Open" into the W/L and Running Total cells,
    // which parseNum correctly reduces to null rather than a stray "Open" string.
    let isOpen = statusText.toLowerCase() === 'open'
    if (isOpen) {
      const override = SETTLEMENT_OVERRIDES.find(
        o => o.date === date && description.includes(o.descriptionIncludes)
      )
      if (override) {
        isOpen = false
        if (wl === null) wl = override.wl
      }
    }

    let delta = null
    let cumulativeAfter = cumulative

    if (isOpen) {
      delta = null
      cumulativeAfter = cumulative
    } else if (running !== null) {
      delta = Math.round((running - cumulative) * 1000) / 1000
      cumulativeAfter = running
      cumulative = running
    } else if (wl !== null) {
      delta = wl
      cumulativeAfter = Math.round((cumulative + wl) * 1000) / 1000
      cumulative = cumulativeAfter
    }

    let status
    if (isOpen) status = 'Open'
    else if (delta === null) status = 'Push'
    else if (delta > 0) status = 'W'
    else if (delta < 0) status = 'L'
    else status = 'Push'

    // Belt-and-suspenders: never let a NaN slip into the generated file — treat an
    // unparseable settled row as still-open rather than corrupting the running total.
    if (Number.isNaN(delta) || Number.isNaN(cumulativeAfter)) {
      console.warn(`Skipping unparseable row (would produce NaN): ${dateLabel} — ${description}`)
      continue
    }

    bets.push({
      id: bets.length + 1,
      date,
      description,
      sport,
      book,
      units,
      odds,
      status,
      delta,
      cumulative: isOpen ? null : cumulativeAfter,
      tailLink,
    })
  }

  return bets
}

function toTsLiteral(bets, generatedAt) {
  const lines = []
  lines.push(`import { HistoricalBet } from './types'`)
  lines.push('')
  lines.push('// Auto-generated by scripts/sync-bet-history.mjs — do not hand-edit.')
  lines.push('// Source: HotHandBetTracker Google Sheet ("Bets" tab, demonstration / historical data).')
  lines.push('// `delta` and `cumulative` are derived from the running-total column (self-consistent')
  lines.push('// with the sheet), not recomputed from odds, since some entries include manual')
  lines.push('// adjustments (partial cash-outs, etc.) that a pure odds formula would miss.')
  lines.push(`export const BET_HISTORY_SYNCED_AT = ${JSON.stringify(generatedAt)}`)
  lines.push('')
  lines.push('export const BET_HISTORY: HistoricalBet[] = [')
  for (const b of bets) {
    lines.push('  {')
    lines.push(`    id: ${b.id},`)
    lines.push(`    date: '${b.date}',`)
    lines.push(`    description: ${JSON.stringify(b.description)},`)
    lines.push(`    sport: ${JSON.stringify(b.sport)},`)
    lines.push(`    book: ${JSON.stringify(b.book)},`)
    lines.push(`    units: ${b.units},`)
    lines.push(`    odds: ${b.odds},`)
    lines.push(`    status: '${b.status}',`)
    lines.push(`    delta: ${b.delta === null ? 'null' : b.delta},`)
    lines.push(`    cumulative: ${b.cumulative === null ? 'null' : b.cumulative},`)
    if (b.tailLink) lines.push(`    tailLink: ${JSON.stringify(b.tailLink)},`)
    lines.push('  },')
  }
  lines.push(']')
  return lines.join('\n') + '\n'
}

async function main() {
  const localPath = process.argv[2]
  let csvText
  if (localPath) {
    csvText = fs.readFileSync(localPath, 'utf8')
  } else {
    const res = await fetch(SHEET_CSV_URL)
    if (!res.ok) throw new Error(`Sheet fetch failed: HTTP ${res.status}`)
    csvText = await res.text()
  }

  const bets = parseBetSheetCsv(csvText)
  if (bets.length === 0) throw new Error('Parsed 0 bets — refusing to overwrite bet-history.ts')

  const generatedAt = new Date().toISOString()
  const ts = toTsLiteral(bets, generatedAt)

  const previous = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : ''
  fs.writeFileSync(OUT_FILE, ts)

  const wins = bets.filter(b => b.status === 'W').length
  const losses = bets.filter(b => b.status === 'L').length
  const opens = bets.filter(b => b.status === 'Open')
  console.log(`Parsed ${bets.length} bets (${wins}-${losses}, ${opens.length} open)`)
  console.log(`Final cumulative: ${bets.filter(b => b.cumulative !== null).slice(-1)[0]?.cumulative ?? 'n/a'}`)

  // Normalize away the timestamp line so we can tell if the actual bet data changed.
  const stripTimestamp = s => s.replace(/export const BET_HISTORY_SYNCED_AT = ".*"/, '')
  const changed = stripTimestamp(previous) !== stripTimestamp(ts)
  console.log(changed ? 'Bet data changed.' : 'No change in bet data (only timestamp updated).')
  // Exit code communicates to CI whether a commit is actually worth making.
  process.exitCode = changed ? 0 : 42
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
