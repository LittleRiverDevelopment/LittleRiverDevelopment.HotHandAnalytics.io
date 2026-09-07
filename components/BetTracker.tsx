'use client'

import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Title,
  Tooltip,
  Legend,
  type ScriptableContext,
  type ScriptableLineSegmentContext,
} from 'chart.js'
import {
  History,
  TrendingUp,
  TrendingDown,
  Target,
  Flame,
  ArrowUpDown,
  Download,
  ExternalLink,
  Info,
  Wifi,
  RefreshCw,
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { computeSummary, sortByDate } from '@/lib/bet-tracker-utils'
import { formatOdds } from '@/lib/odds-utils'
import { downloadCsv, betHistoryToCsvRows } from '@/lib/csv-export'
import { BET_HISTORY, BET_HISTORY_SYNCED_AT } from '@/lib/bet-history'
import type { HistoricalBet } from '@/lib/types'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Title, Tooltip, Legend)

type SortField = 'date' | 'units' | 'odds' | 'delta'
type SortDirection = 'asc' | 'desc'

function formatUnits(n: number): string {
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}`
}

function formatSyncAge(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h ago`
  if (hours > 0) return `${hours}h ${minutes % 60}m ago`
  if (minutes > 0) return `${minutes}m ago`
  return 'just now'
}

const bets: HistoricalBet[] = BET_HISTORY

export default function BetTracker() {
  // Keep the "X ago" label ticking without needing a page refresh.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(interval)
  }, [])

  const [sortField, setSortField] = useState<SortField>('date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [sportFilter, setSportFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [search, setSearch] = useState('')

  const chronological = useMemo(() => sortByDate(bets), [bets])
  const summary = useMemo(() => computeSummary(bets), [bets])

  const sports = useMemo(
    () => Array.from(new Set(chronological.map(b => b.sport))).sort(),
    [chronological]
  )

  const filtered = useMemo(() => {
    return chronological.filter(b => {
      if (sportFilter !== 'all' && b.sport !== sportFilter) return false
      if (statusFilter !== 'all' && b.status !== statusFilter) return false
      if (search.trim() && !b.description.toLowerCase().includes(search.trim().toLowerCase())) {
        return false
      }
      return true
    })
  }, [chronological, sportFilter, statusFilter, search])

  const sorted = useMemo(() => {
    const rows = [...filtered]
    rows.sort((a, b) => {
      let comparison = 0
      switch (sortField) {
        case 'date':
          comparison = a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1
          break
        case 'units':
          comparison = a.units - b.units
          break
        case 'odds':
          comparison = a.odds - b.odds
          break
        case 'delta':
          comparison = (a.delta ?? 0) - (b.delta ?? 0)
          break
      }
      return sortDirection === 'desc' ? -comparison : comparison
    })
    return rows
  }, [filtered, sortField, sortDirection])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDirection(field === 'date' ? 'desc' : 'asc')
    }
  }

  // Equity curve: synthetic 0 baseline before the first settled bet, then running total after each.
  const settledChrono = useMemo(
    () => chronological.filter(b => b.cumulative !== null),
    [chronological]
  )

  const chartData = useMemo(() => {
    const labels = ['Start', ...settledChrono.map(b => format(parseISO(b.date), 'MMM d'))]
    const points = [0, ...settledChrono.map(b => b.cumulative as number)]
    return {
      labels,
      datasets: [
        {
          label: 'Cumulative units',
          data: points,
          borderColor: '#22c55e',
          backgroundColor: (ctx: ScriptableContext<'line'>) => {
            const { chart } = ctx
            const { ctx: canvasCtx, chartArea } = chart
            if (!chartArea) return 'rgba(34, 197, 94, 0.12)'
            const gradient = canvasCtx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
            gradient.addColorStop(0, 'rgba(34, 197, 94, 0.35)')
            gradient.addColorStop(1, 'rgba(34, 197, 94, 0.02)')
            return gradient
          },
          segment: {
            borderColor: (segCtx: ScriptableLineSegmentContext) =>
              (segCtx.p1.parsed.y ?? 0) < 0 ? '#ef4444' : '#22c55e',
          },
          fill: 'origin',
          tension: 0.25,
          pointRadius: 2,
          pointHoverRadius: 5,
          pointBackgroundColor: '#22c55e',
        },
      ],
    }
  }, [settledChrono])

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (context: { parsed: { y: number | null } }) => {
            const value = context.parsed.y
            if (value === null) return ''
            return `${formatUnits(value)} units`
          },
        },
      },
    },
    scales: {
      x: {
        grid: { color: '#1e293b' },
        ticks: { color: '#64748b', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
      },
      y: {
        grid: { color: '#1e293b' },
        ticks: {
          color: '#64748b',
          callback: (value: number | string) => formatUnits(Number(value)),
        },
      },
    },
  }

  const getResultClass = (status: HistoricalBet['status']) => {
    if (status === 'W') return 'text-green-400 bg-green-500/10 border-green-500/30'
    if (status === 'L') return 'text-red-400 bg-red-500/10 border-red-500/30'
    if (status === 'Open') return 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30'
    return 'text-slate-400 bg-slate-800/80 border-slate-600/50'
  }

  const streakLabel =
    summary.currentStreak.type === null
      ? '—'
      : `${summary.currentStreak.count}${summary.currentStreak.type}`

  const syncedAtMs = new Date(BET_HISTORY_SYNCED_AT).getTime()
  const syncAge = formatSyncAge(now - syncedAtMs)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-green-400" />
          <h2 className="text-lg font-semibold">Bet Tracker</h2>
          <span className="text-sm text-slate-400 ml-2">
            {summary.totalBets} bets logged{summary.openBets > 0 ? ` · ${summary.openBets} open` : ''}
          </span>
        </div>

        <button
          type="button"
          onClick={() =>
            downloadCsv(
              `bet-tracker-${format(new Date(), 'yyyy-MM-dd-HHmm')}.csv`,
              betHistoryToCsvRows(sorted)
            )
          }
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-slate-600 bg-slate-800/50 text-slate-300 hover:text-green-400 hover:border-green-500/40 transition-colors"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      {/* Sync status */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg border border-slate-700/50 bg-slate-900/40 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <Wifi className="w-4 h-4 text-green-400 shrink-0" />
            <span className="text-slate-400">Auto-synced from Google Sheet</span>
          </div>
          <span className="text-xs text-slate-500">Last synced {syncAge}</span>
          <span className="text-xs text-slate-600">· Runs every 3h via scheduled GitHub Action</span>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          title="Reload the page to pick up the latest deployed sync"
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm bg-slate-800/60 hover:bg-slate-700/60 border border-slate-600/50 text-slate-300 hover:text-green-400 rounded-lg transition-colors shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-4 card-hover">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-400">Record</span>
            <Target className="w-4 h-4 text-cyan-400" />
          </div>
          <p className="text-2xl font-bold mt-1 mono">
            {summary.wins}-{summary.losses}
            {summary.pushes > 0 ? `-${summary.pushes}` : ''}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {summary.winRate.toFixed(1)}% win rate
            {summary.openBets > 0 ? ` · ${summary.openBets} open (not counted)` : ''}
          </p>
        </div>

        <div className="card p-4 card-hover">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-400">Net Units</span>
            {summary.netUnits >= 0 ? (
              <TrendingUp className="w-4 h-4 text-green-400" />
            ) : (
              <TrendingDown className="w-4 h-4 text-red-400" />
            )}
          </div>
          <p className={`text-2xl font-bold mt-1 mono ${summary.netUnits >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {formatUnits(summary.netUnits)}
          </p>
          <p className="text-xs text-slate-500 mt-1">{summary.totalUnitsStaked.toFixed(1)}u risked</p>
        </div>

        <div className="card p-4 card-hover">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-400">ROI</span>
            <TrendingUp className="w-4 h-4 text-yellow-400" />
          </div>
          <p className={`text-2xl font-bold mt-1 mono ${summary.roiPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {summary.roiPercent >= 0 ? '+' : ''}
            {summary.roiPercent.toFixed(1)}%
          </p>
          <p className="text-xs text-slate-500 mt-1">Peak {formatUnits(summary.peakUnits)}u</p>
        </div>

        <div className="card p-4 card-hover">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-400">Current Streak</span>
            <Flame className={`w-4 h-4 ${summary.currentStreak.type === 'W' ? 'text-orange-400' : 'text-slate-500'}`} />
          </div>
          <p className="text-2xl font-bold mt-1 mono">{streakLabel}</p>
          <p className="text-xs text-slate-500 mt-1">
            {summary.currentDrawdown > 0.01 ? `-${summary.currentDrawdown.toFixed(2)}u off peak` : 'At peak'}
          </p>
        </div>
      </div>

      {/* Equity curve */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-green-400" />
            <span className="font-medium">Cumulative Returns</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            {summary.bestWin && (
              <span>
                Best: <span className="text-green-400 mono">+{summary.bestWin.delta?.toFixed(2)}u</span>
              </span>
            )}
            {summary.worstLoss && (
              <span>
                Worst: <span className="text-red-400 mono">{summary.worstLoss.delta?.toFixed(2)}u</span>
              </span>
            )}
          </div>
        </div>
        <div className="h-[300px]">
          {settledChrono.length > 0 ? (
            <Line data={chartData} options={chartOptions} />
          ) : (
            <div className="h-full flex items-center justify-center text-slate-500 text-sm">
              No settled bets yet
            </div>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search bets…"
          className="bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-green-500 flex-1 min-w-[180px]"
        />
        <select
          value={sportFilter}
          onChange={e => setSportFilter(e.target.value)}
          className="bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-green-500"
        >
          <option value="all">All Sports</option>
          {sports.map(s => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-green-500"
        >
          <option value="all">All Results</option>
          <option value="W">Wins</option>
          <option value="L">Losses</option>
          <option value="Push">Pushes</option>
          <option value="Open">Open</option>
        </select>
        <span className="text-xs text-slate-500">{sorted.length} shown</span>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="table-header border-b border-slate-700/50">
                <th
                  className="text-left py-3 px-4 text-xs font-medium text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200"
                  onClick={() => handleSort('date')}
                >
                  <div className="flex items-center gap-1">
                    Date
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium text-slate-400 uppercase tracking-wider">
                  Bet
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium text-slate-400 uppercase tracking-wider">
                  Book
                </th>
                <th
                  className="text-center py-3 px-4 text-xs font-medium text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200"
                  onClick={() => handleSort('odds')}
                >
                  <div className="flex items-center justify-center gap-1">
                    Odds
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th
                  className="text-center py-3 px-4 text-xs font-medium text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200"
                  onClick={() => handleSort('units')}
                >
                  <div className="flex items-center justify-center gap-1">
                    Units
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th className="text-center py-3 px-4 text-xs font-medium text-slate-400 uppercase tracking-wider">
                  Result
                </th>
                <th
                  className="text-center py-3 px-4 text-xs font-medium text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200"
                  onClick={() => handleSort('delta')}
                >
                  <div className="flex items-center justify-center gap-1">
                    W/L
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th className="text-right py-3 px-4 text-xs font-medium text-slate-400 uppercase tracking-wider">
                  Running Total
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              <AnimatePresence>
                {sorted.map((bet, index) => (
                  <motion.tr
                    key={bet.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ delay: index * 0.015 }}
                    className="table-row"
                  >
                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-sm">{format(parseISO(bet.date), 'MMM d')}</span>
                        <span className="text-xs text-slate-500">{format(parseISO(bet.date), 'yyyy')}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 max-w-[320px]">
                      <div className="flex items-start gap-1.5">
                        <span className="text-sm">{bet.description}</span>
                        {bet.tailLink && (
                          <a
                            href={bet.tailLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="View bet slip"
                            className="text-slate-500 hover:text-green-400 transition-colors shrink-0 mt-0.5"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                      <span className="text-xs text-slate-500">{bet.sport}</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-1 bg-slate-800 rounded text-xs">{bet.book}</span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span className="odds-badge text-slate-300">{formatOdds(bet.odds)}</span>
                    </td>
                    <td className="py-3 px-4 text-center mono text-sm">{bet.units}</td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`inline-flex min-w-[3rem] justify-center rounded-md border px-2 py-1 text-xs font-semibold ${getResultClass(bet.status)}`}
                      >
                        {bet.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center mono text-sm">
                      {bet.delta !== null ? (
                        <span className={bet.delta >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {formatUnits(bet.delta)}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right mono text-sm">
                      {bet.cumulative !== null ? (
                        <span className={bet.cumulative >= 0 ? 'text-slate-200' : 'text-red-400'}>
                          {bet.cumulative.toFixed(2)}u
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>

        {sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-slate-400">
            <History className="w-8 h-8 mb-2" />
            <p>No bets match your filters</p>
          </div>
        )}
      </div>

      <div className="card p-4">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-cyan-500/10 rounded-lg">
            <Info className="w-4 h-4 text-cyan-400" />
          </div>
          <div>
            <h3 className="font-medium text-sm">About this tracker</h3>
            <p className="text-sm text-slate-400 mt-1">
              Historical bet log for demonstration purposes — a scheduled GitHub Action pulls this
              site&apos;s bundled data from a personal Google Sheets bet tracker spanning the NBA/CBB season
              through the 2026 World Cup and into MLB. Units W/L and running totals come directly from
              the sheet (not recomputed from odds), so results reflect real settlement including any
              partial cash-outs. The equity curve plots cumulative units won/lost after each settled bet;
              any &quot;Open&quot; bet is excluded until it settles.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
