'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'

/* ─── Demo data ──────────────────────────────────────────────────────────── */

const PROMPT = 'Create a handmade marketplace with buyers, sellers, products, orders, carts, and payments'

const WS_TABLES = [
  'buyers','users','orders','products','sellers',
  'stores','carts','alerts','inventory','coupons','sales','transactions',
]

const WS_APIS = [
  { method: 'GET',  path: '/users'     },
  { method: 'GET',  path: '/buyers'    },
  { method: 'GET',  path: '/orders'    },
  { method: 'GET',  path: '/products'  },
  { method: 'GET',  path: '/sellers'   },
  { method: 'GET',  path: '/stores'    },
  { method: 'GET',  path: '/alerts'    },
  { method: 'GET',  path: '/inventory' },
  { method: 'POST', path: '/auth'      },
]

const INS_TABLES = [
  'carts','sales','users','alerts','buyers',
  'orders','stores','coupons','sellers',
]

const USER_COLUMNS = [
  { name: 'id',         type: 'int8',     badge: 'PK',     bc: 'amber'  },
  { name: 'email',      type: 'text',     badge: 'UNIQUE', bc: 'purple' },
  { name: 'name',       type: 'text',     badge: null,     bc: null     },
  { name: 'role',       type: 'text',     badge: null,     bc: null     },
  { name: 'created_at', type: 'timestamptz', badge: null,  bc: null     },
]

const USER_ROWS = [
  ['1', 'alex@startup.io',    'Alex Rivera',  'buyer',  '2024-01-15'],
  ['2', 'maya@crafts.com',    'Maya Patel',   'seller', '2024-01-14'],
  ['3', 'john@market.io',     'John Kim',     'buyer',  '2024-01-13'],
]

type DemoView = 'workspace' | 'inspector'

/* ─── DemoPanel ─────────────────────────────────────────────────────────── */

export function DemoPanel() {
  const [view,           setView]          = useState<DemoView>('workspace')
  const [phase,          setPhase]         = useState(0)
  const [typedText,      setTypedText]     = useState('')
  const [aiThinking,     setAiThinking]    = useState(false)
  const [buildDone,      setBuildDone]     = useState(false)
  const [visTables,      setVisTables]     = useState(0)   // how many table chips visible
  const [visApis,        setVisApis]       = useState(0)
  const [showAuth,       setShowAuth]      = useState(false)
  const [showStorage,    setShowStorage]   = useState(false)
  // inspector
  const [insPhase,       setInsPhase]      = useState(0)   // 0=list only 1=table selected
  const [insSelTable,    setInsSelTable]   = useState(-1)
  const [visInsTables,   setVisInsTables]  = useState(0)
  const [insTableLoaded, setInsTableLoaded]= useState(false)

  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    const pending: ReturnType<typeof setTimeout>[] = []
    timers.current = pending
    const t = (fn: () => void, ms: number) => { const id = setTimeout(fn, ms); pending.push(id) }
    const clearAll = () => { pending.forEach(clearTimeout); pending.length = 0 }

    const run = () => {
      clearAll()
      // reset
      setView('workspace'); setPhase(0); setTypedText(''); setAiThinking(false)
      setBuildDone(false); setVisTables(0); setVisApis(0)
      setShowAuth(false); setShowStorage(false)
      setInsPhase(0); setInsSelTable(-1); setVisInsTables(0); setInsTableLoaded(false)

      /* ── WORKSPACE PHASE ─────────────────────────────── */
      t(() => setPhase(1), 600)

      // Typewriter
      let i = 0
      const typeNext = () => {
        setTypedText(PROMPT.slice(0, i))
        if (i++ < PROMPT.length) t(typeNext, 32 + Math.random() * 18)
      }
      t(typeNext, 900)

      // AI thinking
      t(() => { setPhase(2); setAiThinking(true) }, 4400)

      // Tables appear one by one on right panel
      t(() => setPhase(3), 6000)
      for (let n = 1; n <= WS_TABLES.length; n++) {
        t(((cnt) => () => setVisTables(cnt))(n), 6200 + n * 280)
      }

      // APIs
      t(() => {
        setVisApis(0)
        const step = () => setVisApis(prev => { if (prev < WS_APIS.length) t(step, 200); return prev + 1 })
        step()
      }, 9800)

      // Auth + storage
      t(() => setShowAuth(true),    11000)
      t(() => setShowStorage(true), 11400)

      // Build complete
      t(() => { setAiThinking(false); setBuildDone(true); setPhase(4) }, 12000)

      /* ── INSPECTOR PHASE ─────────────────────────────── */
      t(() => { setView('inspector'); setInsPhase(0) }, 14500)

      // Table list appears
      for (let n = 1; n <= INS_TABLES.length; n++) {
        t(((cnt) => () => setVisInsTables(cnt))(n), 15000 + n * 160)
      }

      // Select users table
      t(() => {
        setInsSelTable(2) // "users" is index 2
        setInsPhase(1)
      }, 18000)
      t(() => setInsTableLoaded(true), 18400)

      // Loop
      t(run, 25000)
    }

    run()
    return clearAll
  }, [])

  /* ─── render ─── */
  return (
    <div className="w-full h-full flex flex-col bg-[#09090b] overflow-hidden select-none" style={{ fontFamily: 'var(--font-geist-sans), -apple-system, sans-serif' }}>
      <AnimatePresence mode="wait">

        {/* ════════════════════ WORKSPACE VIEW ════════════════════ */}
        {view === 'workspace' && (
          <motion.div key="workspace"
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16, scale: 0.98 }}
            transition={{ duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="flex w-full h-full">

            {/* LEFT — AI Chat */}
            <div className="flex flex-col border-r border-white/[0.06]" style={{ width: '36%', background: '#0d0d12' }}>
              {/* Chat header */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.05] shrink-0">
                <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-[#7c3aed] to-[#6d28d9] flex items-center justify-center shrink-0">
                  <span className="text-white text-[8px] font-bold">B</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold text-white/90">Backenly AI</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  </div>
                  <p className="text-[8px] text-white/35 leading-none mt-0.5">Backend generation engine</p>
                </div>
                <span className="text-[8px] text-white/25 shrink-0">
                  {buildDone ? '12' : phase >= 2 ? '4' : '0'} turns
                </span>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-hidden px-3 py-2 flex flex-col gap-2 justify-end min-h-0">
                <AnimatePresence mode="popLayout">
                  {/* Suggestion (phase 0) */}
                  {phase === 0 && (
                    <motion.div key="sugg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="text-[9px] text-white/25 italic">
                      e.g. Chat app with rooms and users
                    </motion.div>
                  )}

                  {/* User message */}
                  {phase >= 1 && (
                    <motion.div key="umsg" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                      className="flex justify-end shrink-0">
                      <div className="max-w-[90%] px-2.5 py-2 rounded-2xl rounded-tr-sm bg-[#7c3aed]/20 border border-[#7c3aed]/15 text-white/75 text-[8.5px] leading-relaxed break-words">
                        {typedText || ' '}
                        {phase === 1 && (
                          <motion.span animate={{ opacity: [1, 0] }} transition={{ duration: 0.55, repeat: Infinity }}
                            className="inline-block w-px h-3 bg-white/60 ml-0.5 align-middle" />
                        )}
                      </div>
                    </motion.div>
                  )}

                  {/* AI thinking */}
                  {aiThinking && !buildDone && (
                    <motion.div key="think"
                      initial={{ opacity: 0, y: 8, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.96 }}
                      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                      className="flex items-start gap-1.5 shrink-0">
                      <BkAvatar />
                      <div className="px-3 py-2.5 rounded-2xl rounded-tl-sm bg-white/[0.04] border border-white/[0.07] flex items-center gap-1.5">
                        {[0,1,2].map(i => (
                          <motion.div key={i}
                            animate={{ scale: [1, 1.4, 1], opacity: [0.4, 1, 0.4] }}
                            transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
                            className="w-1 h-1 rounded-full bg-[#a78bfa]" />
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {/* Build complete */}
                  {buildDone && (
                    <motion.div key="built"
                      initial={{ opacity: 0, y: 10, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
                      className="flex items-start gap-1.5 shrink-0">
                      <BkAvatar />
                      <div className="px-2.5 py-2 rounded-2xl rounded-tl-sm bg-white/[0.04] border border-white/[0.06] space-y-1.5 max-w-[90%]">
                        <div className="flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          <span className="text-[9.5px] font-semibold text-emerald-400">Build Complete</span>
                          <span className="text-[7.5px] text-white/30 ml-auto">{WS_TABLES.length} built</span>
                        </div>
                        <div>
                          <p className="text-[7.5px] text-white/35 uppercase tracking-wider mb-1">Built</p>
                          <div className="flex flex-wrap gap-1">
                            {['JWT authentication','Auth','Storage'].map(c => (
                              <span key={c} className="text-[7.5px] px-1.5 py-0.5 rounded-md bg-[#7c3aed]/15 border border-[#7c3aed]/20 text-[#a78bfa]">{c}</span>
                            ))}
                          </div>
                        </div>
                        <div>
                          <p className="text-[7.5px] text-white/35 uppercase tracking-wider mb-1">Verified</p>
                          <div className="flex flex-wrap gap-1">
                            {['Auth verification','API verification'].map(c => (
                              <span key={c} className="text-[7.5px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center gap-1">
                                <span className="text-[6px]">⊙</span>{c}
                              </span>
                            ))}
                          </div>
                        </div>
                        <p className="text-[8px] text-white/40 leading-relaxed">
                          Tables created and verified. Say <span className="text-[#a78bfa]">"deploy"</span> to go live.
                        </p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Input */}
              <div className="border-t border-white/[0.05] p-2.5 shrink-0">
                <div className="flex items-center gap-1.5 bg-white/[0.03] border border-white/[0.06] rounded-xl px-2.5 py-1.5">
                  <span className="text-[8px] text-white/[0.06] bg-white/[0.04] border border-white/[0.08] rounded px-1 py-0.5 font-mono shrink-0">/</span>
                  <span className="text-[8.5px] text-white/20 flex-1 truncate">e.g. Chat app with rooms and users</span>
                  <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-[#7c3aed] to-[#6d28d9] flex items-center justify-center shrink-0">
                    <span className="text-white text-[8px] font-bold">↑</span>
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT — Project Overview */}
            <div className="flex-1 flex flex-col overflow-hidden min-w-0 bg-[#09090b]">
              {/* Project header */}
              <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.05] shrink-0">
                <span className="text-[11px] font-semibold text-white/85 truncate">Handmade Marketplace Backend</span>
                <span className="text-[8px] font-mono text-white/25 shrink-0">6edc3b7c…</span>
              </div>

              {/* Scrollable overview */}
              <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 space-y-3">

                {/* Autonomous Build Runtime card */}
                <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
                  <div className="flex items-start gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-[#7c3aed]/20 border border-[#7c3aed]/20 flex items-center justify-center shrink-0">
                      <span className="text-[12px]">⬡</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold text-white/80">Autonomous Build Runtime</span>
                        <AnimatePresence>
                          {visTables > 0 && (
                            <motion.span key="fix" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                              className="text-[7.5px] font-bold px-1.5 py-0.5 rounded-md bg-red-500/15 border border-red-500/25 text-red-400">
                              Needs launch fixes
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </div>
                      <p className="text-[7.5px] text-white/30 mt-0.5">Governed · Locked · Snapshotted</p>
                    </div>
                  </div>

                  {/* Progress + buttons */}
                  <div className="flex items-center gap-2 mt-2.5">
                    <span className="text-[8.5px] text-white/40 font-mono shrink-0">{Math.min(visTables, 5)}/6</span>
                    <div className="flex-1 h-0.5 rounded-full bg-white/[0.07] overflow-hidden">
                      <motion.div className="h-full rounded-full bg-red-500"
                        animate={{ width: `${Math.min(visTables / 6 * 100, 85)}%` }}
                        transition={{ duration: 0.4 }} />
                    </div>
                    <button className="text-[8.5px] font-semibold px-2.5 py-1 rounded-lg bg-white text-[#09090b] shrink-0">
                      Connect SDK
                    </button>
                    <button className="text-[8.5px] font-semibold px-2.5 py-1 rounded-lg bg-white/[0.06] border border-white/[0.09] text-white/70 shrink-0">
                      Inspector →
                    </button>
                  </div>
                </div>

                {/* Stats bar */}
                <AnimatePresence>
                  {visTables > 0 && (
                    <motion.div key="stats" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      className="flex items-center gap-2 flex-wrap text-[8px] text-white/35">
                      <span>{visTables} tables</span><Dot /><span>{visApis} endpoints</span><Dot />
                      {showAuth && <><span>Auth</span><Dot /></>}
                      {showStorage && <><span>2 buckets</span><Dot /><span>RLS on {Math.floor(visTables * 0.8)}</span></>}
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* TABLES */}
                <AnimatePresence>
                  {visTables > 0 && (
                    <motion.div key="tables-section"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[8px] font-bold text-white/30 uppercase tracking-wider">Tables</span>
                        <motion.span key={visTables}
                          initial={{ scale: 1.3, color: '#a78bfa' }}
                          animate={{ scale: 1, color: 'rgba(255,255,255,0.5)' }}
                          transition={{ duration: 0.3 }}
                          className="text-[8px] font-bold">{visTables}</motion.span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {WS_TABLES.slice(0, visTables).map((tbl, i) => (
                          <motion.span key={tbl}
                            initial={{ opacity: 0, scale: 0.8, y: 4 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            transition={{ type: 'spring', stiffness: 400, damping: 28, delay: i * 0.025 }}
                            className="text-[8.5px] px-2 py-0.5 rounded-lg border border-white/[0.08] bg-white/[0.025] text-white/55">
                            {tbl}
                          </motion.span>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* API ENDPOINTS */}
                <AnimatePresence>
                  {visApis > 0 && (
                    <motion.div key="apis-section"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[7px] font-bold text-white/30 uppercase tracking-wider">⟨/⟩ API Endpoints</span>
                        <motion.span key={visApis}
                          initial={{ scale: 1.3, color: '#a78bfa' }}
                          animate={{ scale: 1, color: 'rgba(255,255,255,0.5)' }}
                          transition={{ duration: 0.3 }}
                          className="text-[8px] font-bold">{visApis}</motion.span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {WS_APIS.slice(0, visApis).map((api, i) => (
                          <motion.span key={api.path}
                            initial={{ opacity: 0, scale: 0.8, y: 4 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            transition={{ type: 'spring', stiffness: 400, damping: 28, delay: i * 0.03 }}
                            className={`text-[7.5px] px-1.5 py-0.5 rounded-md border font-mono ${
                              api.method === 'POST'
                                ? 'bg-blue-500/10 border-blue-500/20 text-blue-400'
                                : 'bg-[#7c3aed]/10 border-[#7c3aed]/15 text-[#a78bfa]'
                            }`}>
                            <span className="font-bold">{api.method}</span> {api.path}
                          </motion.span>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* AUTH */}
                <AnimatePresence>
                  {showAuth && (
                    <motion.div key="auth" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                      className="flex items-center justify-between border-t border-white/[0.05] pt-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-white/25 text-[9px]">○</span>
                        <span className="text-[8.5px] text-white/40 uppercase tracking-wider font-bold">Auth</span>
                      </div>
                      <span className="text-[8px] text-white/40">JWT · Email / Password · Google</span>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* STORAGE */}
                <AnimatePresence>
                  {showStorage && (
                    <motion.div key="storage" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                      className="flex items-center justify-between border-t border-white/[0.05] pt-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-white/25 text-[9px]">▤</span>
                        <span className="text-[8.5px] text-white/40 uppercase tracking-wider font-bold">Storage</span>
                      </div>
                      <span className="text-[8px] text-white/40">2 buckets · File uploads</span>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Realtime + Functions */}
                <AnimatePresence>
                  {showStorage && (
                    <motion.div key="btns" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      className="flex gap-2 pt-1">
                      <button className="text-[8px] px-2.5 py-1 rounded-lg border border-white/[0.07] text-white/40 flex items-center gap-1">
                        <span>⚡</span> Realtime
                      </button>
                      <button className="text-[8px] px-2.5 py-1 rounded-lg border border-white/[0.07] text-white/40 flex items-center gap-1">
                        <span>⚡</span> Functions (15)
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Governance footer */}
              <div className="border-t border-white/[0.05] px-4 py-1.5 shrink-0">
                <p className="text-[7.5px] text-white/20">🔒 Every mutation governed · locked · snapshotted · audited by Build Runtime</p>
              </div>
            </div>
          </motion.div>
        )}

        {/* ════════════════════ INSPECTOR VIEW ════════════════════ */}
        {view === 'inspector' && (
          <motion.div key="inspector"
            initial={{ opacity: 0, x: 24, scale: 0.985 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 12, scale: 0.99 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="flex w-full h-full">

            {/* LEFT NAV SIDEBAR */}
            <div className="flex flex-col border-r border-white/[0.06] shrink-0 bg-[#0d0d12]" style={{ width: '22%', minWidth: 140 }}>
              {/* Back */}
              <div className="px-3 py-2 border-b border-white/[0.05] shrink-0">
                <p className="text-[8px] text-white/35">← Back to workspace</p>
              </div>

              {/* Project identity */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.05] shrink-0">
                <div className="w-5 h-5 rounded-md bg-[#7c3aed]/25 flex items-center justify-center shrink-0">
                  <span className="text-[9px]">⬡</span>
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] font-semibold text-white/80 truncate">Handmade Marketplace Backend</p>
                  <p className="text-[7px] text-white/30">Build Runtime Inspector</p>
                </div>
              </div>

              {/* Nav */}
              <div className="flex-1 px-2 py-2 space-y-px overflow-hidden">
                <InsSection label="Data" />
                <InsNavItem label="Tables"       icon="▤"  active={true}  />
                <InsNavItem label="APIs"          icon="⚡" active={false} />
                <InsSection label="Access" />
                <InsNavItem label="Auth"          icon="○"  active={false} />
                <InsNavItem label="Storage"       icon="▤"  active={false} />
                <InsSection label="Deploy" />
                <InsNavItem label="Connect Frontend" icon="⟨⟩" active={false} badge="SDK" />
                <InsNavItem label="Publish"       icon="✦"  active={false} />
                <InsSection label="Services" />
                <InsNavItem label="Integrations"  icon="⚡" active={false} />
                <InsNavItem label="Realtime"      icon="◎"  active={false} />
                <InsNavItem label="Functions"     icon="⟨/⟩" active={false} />
                <InsSection label="Operations" />
                <InsNavItem label="Monitoring"    icon="∿"  active={false} />
                <InsNavItem label="Auto-fix"      icon="○"  active={false} />
              </div>

              {/* Footer */}
              <div className="border-t border-white/[0.05] px-3 py-2 shrink-0">
                <p className="text-[7px] text-white/20">Governed · Locked · Audited</p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <div className="w-4 h-4 rounded-full bg-[#7c3aed]/30 flex items-center justify-center text-[7px] font-bold text-white/60">A</div>
                  <span className="text-[8px] text-white/40 truncate">adarsh.c.jose</span>
                </div>
              </div>
            </div>

            {/* CENTER — page header + data panel + detail */}
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              {/* Page header */}
              <div className="flex items-center gap-3 px-4 py-2 border-b border-white/[0.05] bg-[#0d0d12] shrink-0">
                <div className="w-6 h-6 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center shrink-0">
                  <span className="text-[10px]">▤</span>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold text-white/85">Tables</span>
                    <span className="text-[9.5px] font-bold text-white/60">{visInsTables}</span>
                    <span className="text-[7.5px] px-1.5 py-0.5 rounded-md bg-[#7c3aed]/15 border border-[#7c3aed]/20 text-[#a78bfa] font-bold">MANAGED</span>
                  </div>
                  <p className="text-[7.5px] text-white/30">Database tables — built and governed by Build Runtime</p>
                </div>
                <div className="ml-auto">
                  <button className="text-[8.5px] font-semibold px-3 py-1.5 rounded-xl bg-white text-[#09090b]">
                    + Describe a change
                  </button>
                </div>
              </div>

              {/* Tab bar */}
              <div className="flex items-center gap-1 px-4 border-b border-white/[0.05] bg-[#0d0d12] shrink-0" style={{ height: 30 }}>
                <span className="text-[9px] font-semibold text-white/80 px-2 py-1 rounded-md bg-white/[0.05] border border-white/[0.07]">▤ Tables</span>
                <span className="text-[9px] text-white/30 px-2 py-1">⟨/⟩ Schema</span>
              </div>

              {/* Two-column: data panel + detail */}
              <div className="flex flex-1 overflow-hidden min-h-0">
                {/* Data panel */}
                <div className="flex flex-col border-r border-white/[0.05] shrink-0 overflow-hidden" style={{ width: '35%', background: '#0b0b10' }}>
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.05] shrink-0">
                    <span className="text-[9.5px] font-semibold text-white/60">Data</span>
                    <div className="ml-auto flex items-center gap-1">
                      <button className="text-[8px] px-2 py-0.5 rounded-lg border border-white/[0.07] text-white/40">+ Table</button>
                      <button className="text-[8px] w-5 h-5 rounded-lg border border-white/[0.06] text-white/30 flex items-center justify-center">↺</button>
                    </div>
                  </div>

                  {/* Schema group */}
                  <div className="flex-1 overflow-y-auto">
                    <div className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5 px-1 py-1 mb-0.5">
                        <span className="text-white/30 text-[8px]">▼</span>
                        <div className="w-4 h-4 rounded bg-[#7c3aed]/20 flex items-center justify-center">
                          <span className="text-[7px]">▤</span>
                        </div>
                        <span className="text-[8.5px] font-medium text-white/60 truncate flex-1">Handmade Marketplace…</span>
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      </div>

                      {/* Table rows */}
                      <div className="space-y-px pl-2">
                        {INS_TABLES.slice(0, visInsTables).map((tbl, i) => (
                          <motion.div
                            key={tbl}
                            initial={{ opacity: 0, x: -8, filter: 'blur(2px)' }}
                            animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                            transition={{ type: 'spring', stiffness: 380, damping: 30, delay: i * 0.05 }}
                            onClick={() => { setInsSelTable(i); setInsPhase(1); setInsTableLoaded(true) }}
                            className={`flex items-center gap-2 px-2 py-1 rounded-lg transition-all ${
                              insSelTable === i
                                ? 'bg-[#7c3aed]/10 border border-[#7c3aed]/15'
                                : 'hover:bg-white/[0.02] border border-transparent'
                            }`}
                          >
                            <span className={`text-[8px] shrink-0 ${insSelTable === i ? 'text-[#a78bfa]' : 'text-white/30'}`}>▤</span>
                            <span className={`text-[9px] font-mono flex-1 truncate ${insSelTable === i ? 'text-white/80' : 'text-white/50'}`}>{tbl}</span>
                            <span className="text-[7.5px] text-white/25 shrink-0">rows</span>
                          </motion.div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Detail panel */}
                <div className="flex-1 overflow-hidden relative bg-[#09090b]">
                  <AnimatePresence mode="wait">
                    {insPhase === 0 || insSelTable === -1 ? (
                      /* Empty state */
                      <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="absolute inset-0 flex items-center justify-center">
                        <div className="text-center space-y-2">
                          <div className="w-12 h-12 rounded-2xl bg-[#7c3aed]/15 border border-[#7c3aed]/15 flex items-center justify-center mx-auto">
                            <span className="text-[20px] opacity-60">▤</span>
                          </div>
                          <p className="text-[10px] font-semibold text-white/50">Select a Collection</p>
                          <p className="text-[8.5px] text-white/25 max-w-[160px] leading-relaxed">
                            Choose a collection from the sidebar to view and manage its data
                          </p>
                          <button className="text-[8px] px-3 py-1.5 rounded-lg border border-white/[0.07] text-white/30 mt-1">
                            ↺ Refresh
                          </button>
                        </div>
                      </motion.div>
                    ) : (
                      /* Table detail */
                      <motion.div key="detail"
                        initial={{ opacity: 0, x: 16, scale: 0.99 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        exit={{ opacity: 0, x: -8 }}
                        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                        className="absolute inset-0 flex flex-col">
                        {/* Detail header */}
                        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.05] bg-[#0d0d12] shrink-0">
                          <span className="text-[10px] font-semibold text-white/75 font-mono">{INS_TABLES[insSelTable]}</span>
                          <span className="text-[8px] bg-white/[0.04] border border-white/[0.06] px-1.5 py-0.5 rounded text-white/30">3 rows</span>
                          <div className="ml-auto flex gap-1">
                            <span className="px-1.5 py-0.5 rounded text-[8px] bg-[#7c3aed]/10 border border-[#7c3aed]/20 text-[#a78bfa]">Structure</span>
                            <span className="px-1.5 py-0.5 rounded text-[8px] text-white/25">Data</span>
                          </div>
                        </div>
                        {/* Columns */}
                        <AnimatePresence>
                          {insTableLoaded && (
                            <motion.div key="cols" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col flex-1 overflow-hidden">
                              <div className="grid px-3 py-1.5 border-b border-white/[0.04] bg-[#0d0d12] shrink-0"
                                style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
                                {USER_COLUMNS.map(col => (
                                  <div key={col.name} className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-1">
                                      <span className="text-[8px] font-semibold text-white/35 uppercase tracking-wider font-mono">{col.name}</span>
                                      {col.badge && (
                                        <span className={`text-[6px] px-1 py-px rounded border font-bold leading-none ${
                                          col.bc === 'amber'  ? 'bg-amber-500/15 border-amber-500/25 text-amber-400/80' :
                                          col.bc === 'purple' ? 'bg-[#7c3aed]/15 border-[#7c3aed]/20 text-[#a78bfa]/80' :
                                                                'bg-white/[0.05] border-white/[0.08] text-white/35'
                                        }`}>{col.badge}</span>
                                      )}
                                    </div>
                                    <span className="text-[7px] text-white/18 font-mono">{col.type}</span>
                                  </div>
                                ))}
                              </div>
                              <div className="flex-1 overflow-hidden">
                                {USER_ROWS.map((row, ri) => (
                                  <motion.div key={ri} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: ri * 0.08 }}
                                    className="grid px-3 py-1.5 border-b border-white/[0.025] hover:bg-white/[0.015]"
                                    style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
                                    {row.map((cell, ci) => (
                                      <span key={ci} className={`text-[8.5px] font-mono truncate pr-1 ${
                                        ci === 0 ? 'text-white/30' :
                                        ci === 1 ? 'text-sky-400/80' :
                                        ci === 3 ? (cell === 'seller' ? 'text-[#a78bfa]' : 'text-white/50') :
                                        ci === 4 ? 'text-white/25' : 'text-white/60'
                                      }`}>{cell}</span>
                                    ))}
                                  </motion.div>
                                ))}
                                {[...Array(5)].map((_, i) => (
                                  <div key={i} className="grid px-3 py-1.5 border-b border-white/[0.018]"
                                    style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
                                    {[3, 20, 14, 7, 10].map((w, ci) => (
                                      <div key={ci} className="h-1.5 rounded-sm bg-white/[0.02]" style={{ width: w * 4 }} />
                                    ))}
                                  </div>
                                ))}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ─── ProductDemo — standalone section ──────────────────────────────────── */

export function ProductDemo() {
  return (
    <section id="product-demo" className="relative py-24 px-6 bg-[#0a0a0a]">
      <div className="max-w-[1500px] mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl font-semibold text-white mb-3">See it in action</h2>
          <p className="text-white/30 text-sm">Type in plain English. Watch your backend build itself.</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8 }}
          className="relative rounded-2xl overflow-hidden border border-white/[0.07] bg-[#09090b] shadow-[0_0_120px_rgba(124,58,237,0.08)]"
          style={{ aspectRatio: '16/9.2' }}
        >
          <DemoPanel />
        </motion.div>
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="text-center text-[11px] text-white/20 mt-5"
        >
          From plain English → deployed backend. No DevOps required.
        </motion.p>
      </div>
    </section>
  )
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */

function BkAvatar() {
  return (
    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-[#7c3aed] to-[#6d28d9] flex items-center justify-center shrink-0 mt-0.5">
      <span className="text-white text-[7px] font-bold">B</span>
    </div>
  )
}

function Dot() {
  return <span className="text-white/20">·</span>
}

function InsSection({ label }: { label: string }) {
  return <p className="text-[7px] font-bold uppercase tracking-widest text-white/20 px-2 pt-2 pb-0.5">{label}</p>
}

function InsNavItem({ icon, label, active, badge }: { icon: string; label: string; active: boolean; badge?: string }) {
  return (
    <div className={`flex items-center gap-2 px-2 py-1 rounded-lg transition-all ${
      active ? 'bg-white/[0.06] border border-white/[0.08] text-white/85' : 'text-white/35'
    }`}>
      <span className="text-[9px] w-3 text-center shrink-0">{icon}</span>
      <span className="text-[9px] font-medium flex-1 truncate">{label}</span>
      {badge && (
        <span className="text-[6.5px] font-bold px-1 py-0.5 rounded border bg-white/[0.05] border-white/[0.08] text-white/30">{badge}</span>
      )}
    </div>
  )
}
