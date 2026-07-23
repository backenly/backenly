import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const OUT_DIR = path.resolve('pitchdeck')
const W = 1920
const H = 1080

const colors = {
  bg: '#f7f7fb',
  ink: '#090b12',
  muted: '#747682',
  line: '#dfe1ea',
  panel: '#ffffff',
  dark: '#121216',
  dark2: '#1b1b22',
  purple: '#7c3cff',
  purple2: '#9b5cff',
  orange: '#f59e0b',
  green: '#16a34a',
  red: '#dc2626',
  blue: '#2563eb',
  cyan: '#0891b2',
}

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function t(text, x, y, size = 28, fill = colors.ink, weight = 500, extra = '') {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${esc(text)}</text>`
}

function rect(x, y, w, h, fill = colors.panel, stroke = colors.line, r = 18, extra = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" ${extra}/>`
}

function line(x1, y1, x2, y2, stroke = colors.line, width = 2, extra = '') {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" ${extra}/>`
}

function pill(text, x, y, fill, stroke, textFill, width = 132) {
  return `${rect(x, y, width, 40, fill, stroke, 10)}${t(text, x + 18, y + 27, 19, textFill, 700)}`
}

function wrap(text, maxChars) {
  const words = text.split(/\s+/)
  const lines = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxChars && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines
}

function multiline(text, x, y, size, fill, weight = 400, maxChars = 48, gap = size * 1.35) {
  return wrap(text, maxChars)
    .map((part, index) => t(part, x, y + index * gap, size, fill, weight))
    .join('')
}

function header(title, subtitle = 'Autonomous Backend Runtime') {
  return `
    ${t(title, 610, 116, 42, colors.ink, 800)}
    ${t(subtitle, 610, 158, 20, '#3c4050', 400)}
    ${pill('Operational', 1536, 120, '#f4efff', '#d7c8ff', colors.purple, 126)}
    ${pill('Connect SDK', 1678, 120, '#ffffff', colors.line, colors.ink, 138)}
    ${t('Updated just now', 1714, 248, 17, '#979aa6', 800, 'letter-spacing="3"')}
  `
}

function brandSidebar(active = 'Backend agent', showNav = true) {
  const nav = [
    ['Backend agent', 92],
    ['Database', 150],
    ['API Builder', 208],
    ['Auth', 266],
    ['Storage', 324],
    ['Realtime', 382],
    ['Deploy', 440],
  ]
  return `
    ${rect(0, 0, 578, H, colors.dark, colors.dark, 0)}
    ${rect(38, 30, 34, 34, colors.purple, colors.purple, 8)}
    ${t('Backenly', 84, 58, 27, '#ffffff', 800)}
    ${t('AI backend builder', 84, 86, 15, '#9ca0ad', 500)}
    ${showNav ? nav.map(([label, y]) => {
      const isActive = label === active
      return `
        ${isActive ? rect(22, y - 30, 522, 46, '#1f1f27', '#2e2e38', 12) : ''}
        <circle cx="40" cy="${y - 7}" r="5" fill="${isActive ? colors.purple2 : '#464650'}"/>
        ${t(label, 60, y, 20, isActive ? '#ffffff' : '#a2a5b1', isActive ? 800 : 500)}
      `
    }).join('') : ''}
  `
}

function chatPanel(prompt = 'Create a production-grade backend for a movie review platform like IMDb.', mode = 'result') {
  const resultBullets = [
    'Created 21 isolated PostgreSQL tables',
    'Generated REST endpoints with JWT auth',
    'Added file storage for posters and media',
    'Enabled realtime channels and audit history',
  ]
  return `
    ${t('Backend agent', 38, 154, 23, '#ffffff', 800)}
    ${t('READY', 190, 154, 15, '#8e919c', 700, 'letter-spacing="3"')}
    ${rect(82, 198, 462, 92, '#202027', '#33333d', 18)}
    ${multiline(prompt, 100, 232, 21, '#ffffff', 600, 46, 29)}
    ${mode === 'prompt' ? `
      ${t('19:00', 22, 356, 16, '#6f727d', 500)}
      ${rect(20, 872, 538, 170, '#1b1b21', '#30303a', 16)}
      ${t('Build a marketplace backend with users, listings,', 38, 920, 22, '#ffffff', 500)}
      ${t('orders, payments, reviews, and realtime chat', 38, 954, 22, '#ffffff', 500)}
      ${rect(512, 984, 30, 30, '#2c2c35', '#2c2c35', 8)}
      ${t('^', 523, 1006, 18, '#777b86', 700)}
    ` : `
      ${t('19:00', 22, 358, 16, '#6f727d', 500)}
      ${t('Movie Review Platform Backend', 22, 406, 23, '#ffffff', 800)}
      ${multiline('A complete backend for reviews, watchlists, ratings, cast, genres, comments, follows, notifications, and media uploads.', 22, 462, 21, '#f1f5ff', 500, 54, 32)}
      ${resultBullets.map((b, i) => `${t('•', 22, 612 + i * 54, 24, '#848896', 800)}${t(b, 38, 612 + i * 54, 21, '#ffffff', 600)}`).join('')}
      ${rect(20, 908, 538, 134, '#1b1b21', '#30303a', 16)}
      ${t('e.g. Add Stripe payments', 38, 956, 20, '#696c76', 500)}
      ${t('/  @', 38, 1008, 22, '#c8cbd5', 700)}
    `}
  `
}

function stat(label, value, sub, x, y, w = 220) {
  return `
    ${line(x - 24, y - 4, x - 24, y + 102, colors.line, 2)}
    ${t(label.toUpperCase(), x, y + 12, 17, '#747782', 800, 'letter-spacing="4"')}
    ${t(value, x, y + 74, 48, colors.ink, 800)}
    ${t(sub, x, y + 106, 18, '#8b8d97', 500)}
  `
}

function metricsRibbon() {
  return `
    ${rect(610, 296, 1266, 148, '#ffffff', colors.line, 18, 'filter="url(#softShadow)"')}
    ${stat('Endpoints', '23', 'managed', 646, 330)}
    ${stat('Tables', '21', 'in schema', 856, 330)}
    ${stat('Functions', '28', 'deployed', 1066, 330)}
    ${stat('Storage', '4', 'buckets', 1276, 330)}
    ${stat('Realtime', 'On', '21 channels', 1488, 330)}
    ${stat('Autonomy', '1', 'needs review', 1700, 330)}
  `
}

function apiTable(x, y, title = 'API Endpoints') {
  const rows = [
    ['GET', '/profiles', 'JWT', '100/min', 'No traffic', '#ede9fe', colors.purple],
    ['LIST', '/movies', 'JWT', '100/min', 'Ready', '#e0f2fe', colors.blue],
    ['CREATE', '/reviews', 'JWT', '60/min', 'Ready', '#dcfce7', colors.green],
    ['SEARCH', '/movies/search', 'JWT', '80/min', 'Indexed', '#fef3c7', colors.orange],
    ['DELETE', '/watchlists/:id', 'JWT', '30/min', 'Guarded', '#fee2e2', colors.red],
  ]
  return `
    ${rect(x, y, 738, 430, '#ffffff', colors.line, 18, 'filter="url(#softShadow)"')}
    ${t(title, x + 24, y + 50, 23, colors.ink, 800)}
    ${t('147 generated routes', x + 180, y + 50, 18, colors.muted, 500)}
    ${['Method', 'Endpoint', 'Auth', 'Limit', 'Status'].map((h, i) => t(h.toUpperCase(), x + [34, 170, 410, 520, 640][i], y + 104, 15, '#979aa6', 800, 'letter-spacing="3"')).join('')}
    ${rows.map((r, i) => {
      const yy = y + 142 + i * 58
      return `
        ${line(x + 24, yy - 22, x + 714, yy - 22, '#ececf2', 1)}
        ${pill(r[0], x + 24, yy - 19, r[5], r[5], r[6], 82)}
        ${t(r[1], x + 170, yy + 8, 20, '#151823', 600, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
        ${t(r[2], x + 422, yy + 8, 18, '#596070', 500)}
        ${t(r[3], x + 520, yy + 8, 18, '#596070', 500)}
        ${t(r[4], x + 640, yy + 8, 18, '#8b8d97', 500)}
      `
    }).join('')}
  `
}

function databaseCard(x, y) {
  const rows = ['activity_logs', 'comments', 'favorites', 'genres', 'movies', 'reviews']
  return `
    ${rect(x, y, 488, 430, '#ffffff', colors.line, 18, 'filter="url(#softShadow)"')}
    ${t('Database', x + 24, y + 50, 23, colors.ink, 800)}
    ${t('21 tables', x + 136, y + 50, 18, colors.muted, 500)}
    ${rows.map((name, i) => {
      const yy = y + 104 + i * 47
      return `
        <circle cx="${x + 38}" cy="${yy - 3}" r="8" fill="#f1f5f9" stroke="#a5acb8"/>
        ${t(name, x + 62, yy + 5, 20, '#242936', 500, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
        ${t(i < 2 ? 'seeded' : 'empty', x + 398, yy + 5, 17, '#8b8d97', 500)}
        ${line(x + 24, yy + 20, x + 464, yy + 20, '#eeeeF4', 1)}
      `
    }).join('')}
    ${t('+ 15 more tables', x + 24, y + 390, 18, colors.muted, 600)}
  `
}

function browserStyle(content, title = 'Backenly workspace') {
  return `
  <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#111827" flood-opacity="0.11"/>
      </filter>
      <filter id="deepShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="30" flood-color="#000000" flood-opacity="0.22"/>
      </filter>
    </defs>
    <style>
      text { font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial, sans-serif; }
    </style>
    <rect width="${W}" height="${H}" fill="${colors.bg}"/>
    ${content}
    ${t(title, 1530, 1030, 18, '#a1a4af', 600)}
  </svg>`
}

function dashboard({
  active = 'Backend agent',
  prompt = 'Create a production-grade backend for a movie review platform like IMDb.',
  chatMode = 'result',
  mainTitle = 'Movie Review Platform',
  extra = '',
} = {}) {
  return browserStyle(`
    ${brandSidebar(active, false)}
    ${chatPanel(prompt, chatMode)}
    ${header(mainTitle)}
    ${t('1 thing needs your call - the execution loop is paused for review.', 614, 248, 21, '#35394a', 500)}
    ${t('Review', 1172, 248, 20, '#dd6b00', 700)}
    ${metricsRibbon()}
    ${apiTable(610, 500)}
    ${databaseCard(1388, 500)}
    ${extra}
  `)
}

function problemDiagram() {
  const boxes = [
    ['Prompt', 'Users describe product in plain English', 160, 296, colors.purple],
    ['Backend bottleneck', 'Schema design, auth, APIs, storage, deploys', 570, 296, colors.orange],
    ['Manual glue', 'Tickets, migrations, docs, SDK wiring', 980, 296, colors.red],
    ['Delayed launch', 'Weeks of blocked product iteration', 1390, 296, colors.blue],
  ]
  return browserStyle(`
    ${rect(74, 74, 1772, 932, '#ffffff', colors.line, 28, 'filter="url(#softShadow)"')}
    ${t('The backend bottleneck slows every app idea', 144, 172, 58, colors.ink, 850)}
    ${t('Teams can prototype UI quickly, but backend reality still requires brittle handoffs and manual configuration.', 148, 226, 25, '#555b68', 500)}
    ${boxes.map(([label, sub, x, y, c], i) => `
      ${rect(x, y, 328, 230, '#fbfbfe', '#e4e6ef', 22)}
      <circle cx="${x + 56}" cy="${y + 62}" r="22" fill="${c}" opacity="0.16"/>
      <circle cx="${x + 56}" cy="${y + 62}" r="9" fill="${c}"/>
      ${t(label, x + 34, y + 124, 29, colors.ink, 800)}
      ${multiline(sub, x + 34, y + 166, 20, '#666b77', 500, 27, 30)}
      ${i < boxes.length - 1 ? `${line(x + 340, y + 115, x + 392, y + 115, '#aeb4c2', 4)}<path d="M ${x + 392} ${y + 115} l -14 -10 v 20 z" fill="#aeb4c2"/>` : ''}
    `).join('')}
    ${rect(220, 650, 1480, 190, '#111216', '#111216', 26)}
    ${t('Backenly removes the wait:', 286, 728, 34, '#ffffff', 850)}
    ${t('natural language -> governed backend plan -> generated database/API/runtime -> SDK-ready product', 286, 782, 28, '#d9dce6', 600)}
  `, 'Problem diagram')
}

function solutionPrompt() {
  return dashboard({
    chatMode: 'prompt',
    prompt: 'Create a backend for a marketplace with users, listings, orders, payments, reviews, and realtime chat.',
    mainTitle: 'Marketplace Backend',
    extra: `
      ${rect(720, 708, 480, 132, '#111216', '#111216', 18)}
      ${t('AI plan detected', 748, 756, 25, '#ffffff', 800)}
      ${t('8 entities, 34 endpoints, 3 policies', 748, 796, 22, '#cbd5e1', 600)}
      ${rect(1230, 708, 446, 132, '#f4efff', '#d7c8ff', 18)}
      ${t('Backend result ready', 1260, 756, 25, colors.purple, 800)}
      ${t('Schema, APIs, auth, storage, realtime', 1260, 796, 22, '#51406d', 600)}
    `,
  })
}

function proofMetrics() {
  return browserStyle(`
    ${brandSidebar('Database')}
    ${header('Production Proof Dashboard', 'Project health, generated backend assets, and runtime status')}
    ${metricsRibbon()}
    ${apiTable(610, 492, 'Generated API Endpoints')}
    ${databaseCard(1388, 492)}
    ${rect(610, 944, 1266, 88, '#111216', '#111216', 18)}
    ${t('Runtime status', 644, 999, 24, '#ffffff', 850)}
    ${t('Auth active', 874, 999, 22, '#bbf7d0', 700)}
    ${t('Storage healthy', 1066, 999, 22, '#bfdbfe', 700)}
    ${t('Realtime on', 1300, 999, 22, '#ddd6fe', 700)}
    ${t('Rollback snapshots: 18', 1504, 999, 22, '#fed7aa', 700)}
  `, 'Product proof')
}

function generatedTablesApis() {
  return browserStyle(`
    ${brandSidebar('Database')}
    ${header('Generated Tables and APIs', 'Every object is inspectable and SDK-ready')}
    ${rect(610, 228, 590, 734, '#ffffff', colors.line, 18, 'filter="url(#softShadow)"')}
    ${t('Tables', 644, 284, 30, colors.ink, 850)}
    ${['users', 'profiles', 'listings', 'orders', 'payments', 'reviews', 'messages', 'attachments', 'notifications'].map((name, i) => `
      ${line(644, 326 + i * 63, 1166, 326 + i * 63, '#edf0f5', 1)}
      ${t(name, 666, 366 + i * 63, 22, '#141722', 600, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
      ${t(['auth', 'profile', 'catalog', 'commerce', 'billing', 'trust', 'chat', 'storage', 'system'][i], 1016, 366 + i * 63, 20, '#7b808c', 500)}
    `).join('')}
    ${apiTable(1240, 228, 'Generated REST APIs')}
    ${rect(1240, 694, 570, 268, '#111216', '#111216', 18)}
    ${t('SDK surface', 1272, 752, 28, '#ffffff', 850)}
    ${t('backend.listings.create(data)', 1272, 808, 24, '#d8b4fe', 700, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
    ${t('backend.orders.list({ filter })', 1272, 856, 24, '#bfdbfe', 700, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
    ${t('backend.realtime.subscribe(...)', 1272, 904, 24, '#bbf7d0', 700, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
  `, 'Generated tables and APIs')
}

function approvalRisk(title = 'Approval and Risk Guardrail') {
  return browserStyle(`
    ${brandSidebar('Backend agent')}
    ${header(title, 'The runtime pauses risky changes before they become backend reality')}
    ${rect(650, 270, 1120, 560, '#ffffff', colors.line, 22, 'filter="url(#softShadow)"')}
    ${pill('Needs approval', 698, 318, '#fff7ed', '#fed7aa', '#c2410c', 178)}
    ${t('Drop table request detected', 698, 398, 42, colors.ink, 850)}
    ${multiline('Backenly has held the execution loop because this change could delete user data. Review the risk summary, audit trail, and rollback snapshot before applying.', 700, 446, 24, '#4f5664', 500, 76, 34)}
    ${rect(700, 570, 306, 148, '#fef2f2', '#fecaca', 18)}
    ${t('Risk', 732, 628, 24, '#991b1b', 850)}
    ${t('Destructive mutation', 732, 676, 24, '#7f1d1d', 700)}
    ${rect(1034, 570, 306, 148, '#f8fafc', '#dbe2ea', 18)}
    ${t('Audit', 1066, 628, 24, '#111827', 850)}
    ${t('Logged before apply', 1066, 676, 24, '#475569', 700)}
    ${rect(1368, 570, 306, 148, '#f0fdf4', '#bbf7d0', 18)}
    ${t('Rollback', 1400, 628, 24, '#166534', 850)}
    ${t('Snapshot ready', 1400, 676, 24, '#166534', 700)}
    ${rect(700, 758, 254, 52, '#111216', '#111216', 12)}
    ${t('Reject', 790, 793, 21, '#ffffff', 800)}
    ${rect(980, 758, 284, 52, '#ffffff', colors.line, 12)}
    ${t('View diff', 1074, 793, 21, colors.ink, 800)}
    ${rect(1290, 758, 326, 52, colors.purple, colors.purple, 12)}
    ${t('Apply safely', 1388, 793, 21, '#ffffff', 800)}
  `, 'Approval risk')
}

function sdkConnect() {
  return browserStyle(`
    ${brandSidebar('Deploy')}
    ${header('SDK and Connect Frontend', 'Generated backend is ready for any frontend')}
    ${rect(650, 252, 550, 588, '#111216', '#111216', 22, 'filter="url(#deepShadow)"')}
    ${t('Install SDK', 700, 318, 34, '#ffffff', 850)}
    ${t('npm install @backenly/client', 700, 394, 25, '#d8b4fe', 700, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
    ${line(700, 438, 1148, 438, '#30303b', 1)}
    ${t('const backend = new BackenlyClient({', 700, 500, 23, '#cbd5e1', 600, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
    ${t('  projectId, apiKey', 700, 542, 23, '#cbd5e1', 600, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
    ${t('})', 700, 584, 23, '#cbd5e1', 600, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
    ${t('await backend.orders.create(data)', 700, 668, 23, '#bbf7d0', 700, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
    ${t('backend.realtime.subscribe(\"orders\")', 700, 716, 23, '#bfdbfe', 700, 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"')}
    ${rect(1260, 252, 510, 588, '#ffffff', colors.line, 22, 'filter="url(#softShadow)"')}
    ${t('Connected apps', 1304, 318, 34, colors.ink, 850)}
    ${['React web app', 'Mobile app', 'Admin console', 'Webhook worker'].map((name, i) => `
      ${rect(1304, 374 + i * 92, 420, 62, '#fbfbfe', '#e7e9f0', 14)}
      <circle cx="1334" cy="${405 + i * 92}" r="9" fill="${colors.green}"/>
      ${t(name, 1360, 414 + i * 92, 23, '#1f2530', 700)}
      ${t('live', 1662, 414 + i * 92, 18, '#16a34a', 800)}
    `).join('')}
  `, 'SDK connect')
}

function safeRuntimeLoop() {
  const nodes = [
    ['Plan', 330, 330, colors.purple],
    ['Dry run', 700, 210, colors.blue],
    ['Approval', 1110, 330, colors.orange],
    ['Apply', 1110, 690, colors.green],
    ['Audit', 700, 810, colors.cyan],
    ['Rollback / repair', 330, 690, colors.red],
  ]
  return browserStyle(`
    ${rect(74, 74, 1772, 932, '#ffffff', colors.line, 28, 'filter="url(#softShadow)"')}
    ${t('Moat: safe runtime loop', 144, 172, 58, colors.ink, 850)}
    ${t('Backenly does not just generate code. It governs each backend change with risk checks, approvals, audit, rollback, and repair.', 148, 226, 25, '#555b68', 500)}
    ${nodes.map(([label, x, y, c]) => `
      ${rect(x, y, 250, 126, '#fbfbfe', '#e6e8f0', 20)}
      <circle cx="${x + 44}" cy="${y + 63}" r="18" fill="${c}" opacity="0.18"/>
      <circle cx="${x + 44}" cy="${y + 63}" r="8" fill="${c}"/>
      ${t(label, x + 78, y + 72, 25, colors.ink, 850)}
    `).join('')}
    <path d="M580 380 C650 270 680 260 700 273" fill="none" stroke="#aeb4c2" stroke-width="5"/>
    <path d="M950 260 C1040 270 1080 306 1110 342" fill="none" stroke="#aeb4c2" stroke-width="5"/>
    <path d="M1235 456 C1270 560 1234 635 1178 690" fill="none" stroke="#aeb4c2" stroke-width="5"/>
    <path d="M1110 780 C1010 866 850 878 950 858" fill="none" stroke="#aeb4c2" stroke-width="5"/>
    <path d="M700 858 C565 858 455 800 580 754" fill="none" stroke="#aeb4c2" stroke-width="5"/>
    <path d="M455 690 C392 582 392 474 455 456" fill="none" stroke="#aeb4c2" stroke-width="5"/>
    ${rect(690, 472, 430, 154, '#111216', '#111216', 24)}
    ${t('Trust timeline', 744, 536, 34, '#ffffff', 850)}
    ${t('Every mutation is explainable, reversible, and inspectable.', 744, 586, 23, '#d9dce6', 600)}
  `, 'Safe runtime loop')
}

function demoThumbnail() {
  return browserStyle(`
    ${rect(90, 90, 1740, 900, '#111216', '#111216', 28, 'filter="url(#deepShadow)"')}
    ${rect(150, 150, 1040, 690, '#f7f7fb', '#f7f7fb', 22)}
    ${brandSidebar('Backend agent').replaceAll('width="578"', 'width="378"')}
    ${t('Watch 60-sec demo', 1260, 336, 66, '#ffffff', 900)}
    ${multiline('Prompt Backenly once and watch it create database tables, APIs, auth, storage, realtime, SDK access, and safety approvals.', 1264, 420, 27, '#d9dce6', 600, 34, 39)}
    <circle cx="1456" cy="660" r="96" fill="${colors.purple}"/>
    <path d="M1428 612 L1428 708 L1512 660 Z" fill="#ffffff"/>
    ${rect(1264, 816, 350, 64, '#ffffff', '#ffffff', 16)}
    ${t('backenly.com/demo', 1300, 858, 25, colors.ink, 850)}
    ${rect(204, 226, 850, 120, '#ffffff', colors.line, 16)}
    ${t('Create a production-grade backend for my app', 238, 300, 32, colors.ink, 800)}
    ${metricsRibbon().replaceAll('610', '204').replaceAll('1266', '850').replaceAll('296', '400')}
  `, 'Demo thumbnail')
}

function teamSlots() {
  return browserStyle(`
    ${rect(74, 74, 1772, 932, '#ffffff', colors.line, 28, 'filter="url(#softShadow)"')}
    ${t('Founder photos needed', 144, 172, 58, colors.ink, 850)}
    ${t('Use verified professional headshots here. I did not fabricate real founder photos.', 148, 226, 25, '#555b68', 500)}
    ${['Adarsh', 'Lakshmi'].map((name, i) => {
      const x = i === 0 ? 300 : 1060
      return `
        ${rect(x, 330, 560, 520, '#f8fafc', '#dfe3ec', 28)}
        <circle cx="${x + 280}" cy="534" r="118" fill="#e8eaf2"/>
        <circle cx="${x + 280}" cy="490" r="52" fill="#cbd1dc"/>
        <path d="M${x + 176} 668 C${x + 206} 594 ${x + 354} 594 ${x + 384} 668 Z" fill="#cbd1dc"/>
        ${t(name, x + 218, 760, 38, colors.ink, 850)}
        ${t('Replace with founder headshot', x + 138, 810, 24, '#69707d', 600)}
      `
    }).join('')}
  `, 'Team photo slots')
}

const images = [
  ['01-cover-main-dashboard.png', dashboard()],
  ['02-problem-bottleneck-diagram.png', problemDiagram()],
  ['03-solution-prompt-to-backend.png', solutionPrompt()],
  ['04-product-proof-metrics-dashboard.png', proofMetrics()],
  ['05-demo-step-1-prompt.png', dashboard({ chatMode: 'prompt', mainTitle: 'Step 1: Prompt Backenly' })],
  ['06-demo-step-2-generated-tables-apis.png', generatedTablesApis()],
  ['07-demo-step-3-approval-risk.png', approvalRisk('Step 3: Approval and Risk Review')],
  ['08-demo-step-4-sdk-connect.png', sdkConnect()],
  ['09-moat-safe-runtime-loop.png', safeRuntimeLoop()],
  ['10-final-demo-thumbnail.png', demoThumbnail()],
  ['11-team-founder-photo-slots-replace.png', teamSlots()],
]

await fs.mkdir(OUT_DIR, { recursive: true })

for (const [name, svg] of images) {
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).resize(W, H).toFile(path.join(OUT_DIR, name))
}

await fs.writeFile(path.join(OUT_DIR, 'README.md'), `# Backenly pitch deck image pack

Generated ${new Date().toISOString().slice(0, 10)}.

All PNGs are 1920x1080, deck-ready, sanitized, and have no browser tabs or private data.

Recommended deck use:
- 01-cover-main-dashboard.png: cover slide
- 02-problem-bottleneck-diagram.png: problem / bottleneck slide
- 03-solution-prompt-to-backend.png: solution slide
- 04-product-proof-metrics-dashboard.png: product proof slide
- 05-demo-step-1-prompt.png through 08-demo-step-4-sdk-connect.png: demo flow slide
- 09-moat-safe-runtime-loop.png or 07-demo-step-3-approval-risk.png: moat / safe runtime slide
- 10-final-demo-thumbnail.png: optional final slide / demo CTA
- 11-team-founder-photo-slots-replace.png: placeholder only. Replace with verified founder headshots for Adarsh and Lakshmi.

Founder photo note:
I did not generate fake headshots. Add real, approved photos as founder-adarsh.png and founder-lakshmi.png when available.
`, 'utf8')

console.log(`Created ${images.length} pitch deck PNGs in ${OUT_DIR}`)
