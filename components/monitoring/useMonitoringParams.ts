'use client'

/**
 * Monitoring's state in the URL, so a view can be linked and survives a
 * reload (decision 11): ?view=requests|logs, ?range=1h|7d|30d (24h is the
 * default and is left out), the Requests filters ?status=errors|slow and
 * ?path=, and the Logs filters ?type=, ?level= and ?q=. Other pages link
 * straight into it: Functions' menu opens monitoring?view=logs&type=function&q=<name>,
 * the Auth user drawer opens monitoring?view=logs&type=auth&q=<email>.
 *
 * The state is held here and follows each change at once; the URL is written
 * with history.replaceState, which Next's router picks up without a round trip
 * to the server, and which leaves no step for Back per filter click. A URL this
 * hook did not write (a link, a reload) is followed.
 */

import { useCallback, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { DEFAULT_RANGE, isLogLevel, isLogSource, isRange, isRequestFilter, type Range, type RequestFilter } from './data'

export type View = 'overview' | 'requests' | 'logs'
export const VIEWS: readonly View[] = ['overview', 'requests', 'logs']

export interface MonitoringParams {
  view: View
  range: Range
  /** Requests: all, errors (400 and above), slow (over 1 s). */
  status: RequestFilter
  /** Requests: a path substring. */
  path: string
  /** Logs: the source (api, auth, database, function, system) or all. */
  type: string
  /** Logs: the level (error, warning, info, debug) or all. */
  level: string
  /** Logs: the search text. */
  q: string
}

const DEFAULTS: MonitoringParams = { view: 'overview', range: DEFAULT_RANGE, status: 'all', path: '', type: 'all', level: 'all', q: '' }
const KEYS = Object.keys(DEFAULTS) as Array<keyof MonitoringParams>

function parse(search: URLSearchParams | null): MonitoringParams {
  const get = (k: string) => search?.get(k) ?? null
  const view = get('view')
  const range = get('range')
  const status = get('status')
  const type = get('type')
  const level = get('level')
  return {
    view: view === 'requests' || view === 'logs' ? view : 'overview',
    range: isRange(range) ? range : DEFAULT_RANGE,
    status: isRequestFilter(status) ? status : 'all',
    path: get('path') ?? '',
    type: type && isLogSource(type) ? type : 'all',
    level: level && isLogLevel(level) ? level : 'all',
    q: get('q') ?? '',
  }
}

export function useMonitoringParams(): [MonitoringParams, (patch: Partial<MonitoringParams>) => void] {
  const search = useSearchParams()
  const urlKey = search?.toString() ?? ''
  const [state, setState] = useState<MonitoringParams>(() => parse(search))
  const [seen, setSeen] = useState(urlKey)
  // What this hook wrote, so the router catching up with an earlier write is
  // not mistaken for a new link.
  const [written, setWritten] = useState<readonly string[]>([])
  if (urlKey !== seen) {
    setSeen(urlKey)
    if (!written.includes(urlKey)) setState(parse(search))
  }

  const update = useCallback(
    (patch: Partial<MonitoringParams>) => {
      const next = { ...state, ...patch }
      setState(next)
      if (typeof window === 'undefined') return
      const url = new URL(window.location.href)
      for (const k of KEYS) {
        const v = next[k]
        if (v === DEFAULTS[k] || v === '') url.searchParams.delete(k)
        else url.searchParams.set(k, String(v))
      }
      setWritten((w) => [...w.slice(-31), url.searchParams.toString()])
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    },
    [state],
  )

  return [state, update]
}
