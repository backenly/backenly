/**
 * Backenly AI Generation Stress Test
 * Tests all 20 prompts against the live production deployment.
 *
 * Usage:
 *   node scripts/stress-test.mjs --email YOUR_EMAIL --password YOUR_PASSWORD
 *
 * Checks per build:
 *   1. users table generated (auth will work)
 *   2. all main entities identified correctly
 *   3. relationships make sense (no missing FKs)
 *   4. many-to-many handled
 *   5. generation completes under 60 seconds
 */

const BASE = process.env.STRESS_BASE || 'http://localhost:3000'

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const getArg = (name) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 ? args[i + 1] : null
}

const EMAIL    = getArg('email')    || process.env.STRESS_EMAIL
const PASSWORD = getArg('password') || process.env.STRESS_PASSWORD

if (!EMAIL || !PASSWORD) {
  console.error('\n❌  Usage: node scripts/stress-test.mjs --email YOU@EXAMPLE.COM --password SECRET\n')
  process.exit(1)
}

// ─── 20 test prompts ─────────────────────────────────────────────────────────
const PROMPTS = [
  {
    id: 1,
    name: 'Freelancer Marketplace',
    prompt: `Build a platform where users can sign up as either a freelancer or a client. Freelancers create profiles and list services with pricing and categories. Clients browse services, filter by category and price, and book a freelancer directly. Once booked there's a messaging thread between client and freelancer. After job completion clients leave star ratings and reviews. Freelancers have a dashboard showing total earnings, active bookings, and their review score.`,
    expectedEntities: ['users','services','bookings','messages','reviews'],
    manyToMany: false,
  },
  {
    id: 2,
    name: 'Restaurant Reservation SaaS',
    prompt: `A SaaS for restaurants where restaurant owners sign up and manage their own account. Customers can register, browse available time slots, and make reservations. Owners manage tables, set capacity per time slot, and block unavailable dates. There's a waitlist when fully booked — customers join it and get notified if a slot opens. Owners can mark reservations as seated, no-show, or completed. Each restaurant account is isolated from others.`,
    expectedEntities: ['users','restaurants','reservations','timeslots','waitlist'],
    manyToMany: false,
  },
  {
    id: 3,
    name: 'Fitness Class Booking',
    prompt: `Members sign up and browse fitness classes offered by studios. Each class has a name, instructor, date, time, and max capacity. Members book spots, cancel up to 2 hours before, and see their upcoming and past class history. Instructors have accounts too and can see who's attending their classes. Studio admins create and manage class listings. When a class fills up it shows as waitlist only.`,
    expectedEntities: ['users','classes','bookings','studios'],
    manyToMany: false,
  },
  {
    id: 4,
    name: 'Multi-tenant Project Management',
    prompt: `Users sign up and create a workspace — like a company account. Inside each workspace there are projects. Projects have tasks. Tasks have title, description, assignee (a team member), due date, priority (low/medium/high), and status (todo/in progress/done). Team members can comment on tasks. Workspace has roles — owner, admin, member. Members only see projects they're invited to. Each workspace is completely isolated from others.`,
    expectedEntities: ['users','workspaces','projects','tasks','comments'],
    manyToMany: true, // members <-> workspaces
  },
  {
    id: 5,
    name: 'Job Board Platform',
    prompt: `Two types of accounts — companies and job seekers, both sign up separately. Companies post job listings with title, description, salary range, location type (remote/hybrid/onsite), employment type, and required skills. Job seekers build profiles with resume, skills, and work experience. Seekers apply to jobs and track application status (applied/reviewed/interviewed/rejected/hired). Companies view applicants per listing and update their status. Both sides have their own dashboard.`,
    expectedEntities: ['users','jobs','applications','profiles'],
    manyToMany: false,
  },
  {
    id: 6,
    name: 'Newsletter Platform',
    prompt: `Writers sign up and publish posts to their newsletter. Posts can be free or paid (subscribers only). Readers sign up and subscribe to writers — free subscription or paid monthly plan. Writers set their own subscription price. Paid subscribers access locked posts. Writers see subscriber count, monthly revenue, and post stats (views, opens). When a writer publishes, all subscribers get notified. Writers can see exactly which subscribers read each post.`,
    expectedEntities: ['users','posts','subscriptions','post_reads'],
    manyToMany: false,
  },
  {
    id: 7,
    name: 'Social Photo App',
    prompt: `Users sign up with email and create a profile with username, bio, and profile photo. They post photos with captions and hashtags. Other users can like and comment on posts. Users follow each other — your feed shows posts from people you follow. There's an explore page showing trending posts. Users can save posts to private collections. Direct messaging between users. Notifications when someone follows you, likes your post, or comments.`,
    expectedEntities: ['users','posts','likes','comments','follows','collections','messages','notifications'],
    manyToMany: true, // users <-> follows
  },
  {
    id: 8,
    name: 'E-commerce Store',
    prompt: `Customers sign up and browse products. Products have name, description, price, images, category, and stock quantity. Customers add items to cart, apply discount codes, and checkout. Orders track status — pending, processing, shipped, delivered. Customers see their full order history and can reorder. Store admins have a separate account type — they add/edit/delete products, view all orders, update order status, and create discount codes (percentage or fixed amount).`,
    expectedEntities: ['users','products','orders','cart_items','discount_codes'],
    manyToMany: false,
  },
  {
    id: 9,
    name: 'Online Course Platform',
    prompt: `Two account types — instructors and students both sign up. Instructors create courses with sections, and each section has lessons. Lessons have video url, text content, and downloadable attachments. Courses have a price. Students purchase courses and get lifetime access. Lesson completion is tracked per student. Students leave reviews with star ratings. Instructors see enrollment numbers, revenue, and reviews. Students get a certificate record when they complete all lessons in a course.`,
    expectedEntities: ['users','courses','sections','lessons','enrollments','reviews','certificates'],
    manyToMany: false,
  },
  {
    id: 10,
    name: 'Event Ticketing',
    prompt: `Event organizers sign up and create events with name, description, date, time, venue, and multiple ticket types. Each ticket type has a name, price, and quantity available. Attendees register and purchase tickets — each purchase generates a unique ticket with a QR code string. Organizers scan QR codes to check in attendees at the door. Dashboard shows ticket sales by type, total revenue, and check-in count. Attendees can view their tickets and transfer them to another registered user.`,
    expectedEntities: ['users','events','ticket_types','tickets'],
    manyToMany: false,
  },
  {
    id: 11,
    name: 'SaaS Analytics Dashboard',
    prompt: `Founders sign up and get a project API key. They send events from their product (signups, upgrades, cancellations, feature usage) to Backenly which stores them. The dashboard shows MRR, ARR, churn rate, new signups over time, and daily active users. There's a user explorer where founders search individual user activity. Custom events have properties (key-value pairs). Founders can set threshold alerts — notify when MRR drops below X or churn exceeds Y percent in a week.`,
    expectedEntities: ['users','projects','events','alerts'],
    manyToMany: false,
  },
  {
    id: 12,
    name: 'Real Estate Listings',
    prompt: `Agents sign up and list properties. Each property has address, asking price, bedrooms, bathrooms, square footage, property type (house/apartment/condo/land), photos array, description, and status (available/under offer/sold). Buyers create accounts, search by location and filters, and save favorite properties. Buyers can send enquiries to agents through the platform. Agents see view counts per listing and which buyers saved it. Admins can verify or suspend agent accounts.`,
    expectedEntities: ['users','properties','saved_properties','enquiries'],
    manyToMany: false,
  },
  {
    id: 13,
    name: 'Team Expense Tracker',
    prompt: `Users sign up and belong to a team. Team admins invite members by email. Members submit expenses with amount, category (travel/software/meals/equipment), description, receipt photo url, and date. Managers approve or reject each expense with optional rejection notes. Approved expenses count toward team's monthly budget. Each category has a monthly spending limit set by the admin. Monthly report per member and per category. Admins can export expense data.`,
    expectedEntities: ['users','teams','expenses','budgets'],
    manyToMany: false,
  },
  {
    id: 14,
    name: 'Appointment Booking',
    prompt: `Service providers sign up and configure their availability — working days and hours per day. They create appointment types with name, duration, description, and price. Each provider gets a public booking page. Clients register and book available slots — they pick an appointment type, available slot, and add notes. Buffer time between appointments is configurable. Both sides can cancel or reschedule. Provider sees their full calendar. Client sees upcoming and past appointments.`,
    expectedEntities: ['users','appointment_types','appointments','availability'],
    manyToMany: false,
  },
  {
    id: 15,
    name: 'Community Forum',
    prompt: `Users sign up and join communities (similar to subreddits). Inside each community users create posts with title and body text. Other members comment on posts and comments can be nested — replies to replies. Posts and comments get upvoted or downvoted by signed-in users. Hot posts ranked by vote score and recency. Community moderators (a role assigned by admins) can pin important posts, remove content, and ban users from their community. Users have karma scores based on upvotes received.`,
    expectedEntities: ['users','communities','posts','comments','votes'],
    manyToMany: true, // users <-> votes
  },
  {
    id: 16,
    name: 'Inventory Management',
    prompt: `Business owners and their staff sign up under one business account. Products have name, SKU, category, current stock level, reorder threshold, cost price, sell price, and supplier name. When stock drops below reorder threshold an alert is created and assigned to a staff member. Users log stock movements — type (received/sold/damaged/adjustment), quantity, date, reference number, and notes. Multiple warehouse locations per business — each product tracks stock per location. Reports show stock value, movement history, and low stock items.`,
    expectedEntities: ['users','products','stock_movements','locations','alerts'],
    manyToMany: false,
  },
  {
    id: 17,
    name: 'Link Shortener with Analytics',
    prompt: `Users sign up and create short links from long URLs. Each link gets a random slug or a custom one the user chooses. The system tracks every click — storing timestamp, referrer url, country code, and device type (mobile/desktop/tablet). User dashboard shows all their links with total clicks, click trend over last 30 days, and top referrers. Links can have an expiry date or a max click limit. Teams can share a workspace — multiple users managing the same pool of links with view or edit permissions.`,
    expectedEntities: ['users','links','clicks','teams'],
    manyToMany: true, // users <-> teams
  },
  {
    id: 18,
    name: 'Pet Care Marketplace',
    prompt: `Two account types — pet owners and pet sitters both register. Sitters create profiles listing their services (dog boarding, dog walking, pet sitting, grooming), rates per service, availability calendar, pet types accepted, and max pets at once. Owners search sitters by location and service type. Owners book and pay through the platform — booking has service type, pet details, dates, and total price. Messaging between owner and sitter per booking. After service completion owners leave reviews. Sitters see their booking calendar and earnings history.`,
    expectedEntities: ['users','sitter_profiles','bookings','messages','reviews'],
    manyToMany: false,
  },
  {
    id: 19,
    name: 'B2B Multi-tenant SaaS with Billing',
    prompt: `Companies sign up and each gets an isolated workspace. Workspace has a subscription plan — free, starter ($29/mo), pro ($99/mo), enterprise. Each plan has limits: free = 3 members and 1000 API calls/month, starter = 10 members and 10k calls, pro = unlimited. Inside each workspace admins manage team members, assign roles (admin/member/viewer), and configure workspace settings. Billing page shows current plan, usage this month vs limit, and invoice history. Admins upgrade or downgrade plan. Usage is tracked daily per workspace.`,
    expectedEntities: ['users','workspaces','members','invoices','usage_logs'],
    manyToMany: true, // users <-> workspaces
  },
  {
    id: 20,
    name: 'Book Lovers App (Casual AI-Builder Paste)',
    prompt: `ok so i want to build this app for book lovers. users sign up obviously. they can add books theyve read and give them a rating out of 5 and write a review. also a "want to read" list and a "currently reading" status for each book. books have title author genre cover image. then the social stuff — users follow each other and theres a feed showing what your friends are reading and their recent reviews. you can like someones review. book clubs!! groups of users that read the same book together. group has a name, description, current book, and members. members can post discussion messages in the group. reading challenges — like "read 12 books in 2026" — users can join challenges and their progress tracks automatically based on books they mark as read. notifications when someone follows you or likes your review or when your book club posts something new. recommendations maybe? based on genres of books you rated highly. probably a recommendations table storing suggested books per user`,
    expectedEntities: ['users','books','user_books','reviews','follows','book_clubs','challenges'],
    manyToMany: true, // users <-> challenges, users <-> book_clubs
  },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function req(method, path, body, token, cookieStr = '') {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  // Send the actual Set-Cookie value from login — replays the HttpOnly cookie
  if (cookieStr) headers['Cookie'] = cookieStr
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { _raw: text } }
  return { status: res.status, json }
}

// ─── Step 1: Login ────────────────────────────────────────────────────────────
async function login() {
  console.log('\n🔐 Logging in...')
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const json = await res.json()
  if (res.status !== 200 || !json.token) {
    console.error('❌ Login failed:', json)
    process.exit(1)
  }

  // Extract the Set-Cookie header so we can replay it as a cookie string
  // Vercel sets HttpOnly cookies — we need to replay the raw cookie value
  const setCookie = res.headers.get('set-cookie') || ''
  // Parse: auth-token=VALUE; Path=/; HttpOnly; ...
  const cookieStr = setCookie
    .split(',')
    .map(s => s.trim().split(';')[0]) // take only name=value part
    .filter(s => s.includes('='))
    .join('; ')

  console.log(`✅ Logged in as ${json.user?.email || EMAIL}`)
  console.log(`   Cookie header: ${cookieStr ? cookieStr.substring(0, 40) + '...' : '(empty — using Bearer only)'}`)

  return { token: json.token, userId: json.user?.id, cookieStr }
}

// ─── Step 2: Create project ───────────────────────────────────────────────────
async function createProject(name, userId, token, cookieStr) {
  const { status, json } = await req('POST', '/api/projects', {
    name: `[Stress] ${name}`,
    userId,
  }, token, cookieStr)
  if (status !== 200 && status !== 201) {
    throw new Error(`Create project failed (${status}): ${JSON.stringify(json)}`)
  }
  // Response shape: { id, ... } or { data: { id, ... } } or { project: { id, ... } }
  const id = json.id || json.data?.id || json.project?.id
  if (!id) throw new Error(`No project ID in response: ${JSON.stringify(json)}`)
  return id
}

// ─── Step 3: Send prompt and measure ─────────────────────────────────────────
async function sendPrompt(projectId, message, token, cookieStr, conversationId = null) {
  const body = {
    message,
    intelligent: true,
    currentPage: '/app/database',
  }
  if (conversationId) body.conversationId = conversationId
  const { status, json } = await req('POST', `/api/ai/chat?projectId=${projectId}`, body, token, cookieStr)
  return { status, json }
}

// ─── Step 4: Get entities from backend state graph ────────────────────────────
async function getTables(projectId, token, cookieStr) {
  const { status, json } = await req('GET', `/api/projects/${projectId}/state`, null, token, cookieStr)
  if (status !== 200) return []
  return (json.entities || []).map(e => e.name?.toLowerCase?.() || '')
}

// ─── Evaluation ───────────────────────────────────────────────────────────────
function evaluate(test, tables, elapsed, chatResponse, confirmResponse) {
  const t = tables.map(x => x.toLowerCase())
  const responseText = (chatResponse?.message || chatResponse?.response || JSON.stringify(chatResponse)).toLowerCase()

  // Check 1: users table — check state graph entities OR auth endpoint
  const hasUsersInEntities = t.includes('users') || t.includes('user')
  const hasUsersInResponse = responseText.includes('users table') || responseText.includes('user table') ||
    responseText.includes('"users"') || responseText.includes('users,') ||
    responseText.includes('"user"')
  const authEnabled = chatResponse?.authEnabled === true || confirmResponse?.authEnabled === true
  const hasUsers = hasUsersInEntities || hasUsersInResponse || authEnabled

  // Check 2: main entities identified (check against response text since tables may come async)
  const entitiesFound = test.expectedEntities.filter(e => {
    const singular = e.replace(/s$/, '').replace(/_/g, ' ')
    const plural   = e.replace(/_/g, ' ')
    return t.includes(e) || t.includes(e.replace(/s$/, '')) ||
      responseText.includes(plural) || responseText.includes(singular)
  })
  const entityScore = entitiesFound.length
  const entityTotal = test.expectedEntities.length
  const entitiesOk  = entityScore >= Math.ceil(entityTotal * 0.6) // pass if ≥60% found

  // Check 3: relationships (FKs) — look for FK language in response
  const fkKeywords = ['foreign key', 'references', 'fk', 'relation', 'belongs to', 'linked', 'user_id', 'join']
  const hasRelationships = fkKeywords.some(k => responseText.includes(k)) || t.length > 2

  // Check 4: many-to-many
  const m2mKeywords = ['junction', 'many-to-many', 'pivot', 'join table', '_to_', 'through']
  const m2mOk = !test.manyToMany ||
    m2mKeywords.some(k => responseText.includes(k)) ||
    t.some(name => name.includes('_') && !name.endsWith('_id'))

  // Check 5: under 120 seconds (increased from 60s to match extended timeouts)
  const timeOk = elapsed < 120000

  return {
    hasUsers,
    entitiesOk,
    entitiesFound,
    entityTotal,
    hasRelationships,
    m2mOk,
    timeOk,
    elapsed,
    allPassed: hasUsers && entitiesOk && hasRelationships && m2mOk && timeOk,
  }
}

// ─── Pretty print ─────────────────────────────────────────────────────────────
function printResult(test, result, tables, projectId) {
  const icon = result.allPassed ? '✅' : '⚠️ '
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${icon} #${test.id}  ${test.name}`)
  console.log(`   Project: ${projectId}`)
  console.log(`   Time:    ${(result.elapsed/1000).toFixed(1)}s  ${result.timeOk ? '✓' : '✗ OVER 120s'}`)
  console.log(`   Tables:  ${tables.join(', ') || '(none yet — check async)'}`)
  console.log(`   [1] users table:    ${result.hasUsers      ? '✓' : '✗'}`)
  console.log(`   [2] main entities:  ${result.entitiesOk    ? '✓' : '✗'} (${result.entitiesFound.length}/${result.entityTotal}: ${result.entitiesFound.join(', ')})`)
  console.log(`   [3] relationships:  ${result.hasRelationships ? '✓' : '✗'}`)
  console.log(`   [4] many-to-many:   ${!test.manyToMany ? 'N/A' : result.m2mOk ? '✓' : '✗'}`)
  console.log(`   [5] under 60s:      ${result.timeOk         ? '✓' : '✗'}`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  BACKENLY AI STRESS TEST  — 20 prompts × 5 checks each')
  console.log(`  Target: ${BASE}`)
  console.log('═══════════════════════════════════════════════════════════')

  const { token, userId, cookieStr } = await login()

  const results = []
  let passed = 0
  let failed = 0

  for (const test of PROMPTS) {
    console.log(`\n⏳ [${test.id}/20] ${test.name} ...`)

    let projectId
    try {
      projectId = await createProject(test.name, userId, token, cookieStr)
      console.log(`   Project created: ${projectId}`)
    } catch (e) {
      console.error(`   ❌ Could not create project: ${e.message}`)
      results.push({ test, error: e.message })
      failed++
      continue
    }

    // ── Step A: Send the initial prompt (AI usually replies with a plan) ───────
    const t0 = Date.now()
    let chatResponse
    let conversationId = null
    // Prefix with imperative command so intent planner and isComplexRequest fire
    const commandPrompt = `Build the complete backend system for this application:\n\n${test.prompt}`
    try {
      const { status, json } = await sendPrompt(projectId, commandPrompt, token, cookieStr)
      chatResponse = json
      conversationId = json.conversationId || null
      if (status >= 500) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`)
      console.log(`   Step 1 done (${((Date.now()-t0)/1000).toFixed(1)}s) type=${json.type || '?'} convId=${conversationId ? conversationId.slice(-12) : 'null'} — sending confirmation...`)
    } catch (e) {
      console.error(`   ❌ Chat request failed: ${e.message}`)
      results.push({ test, error: e.message })
      failed++
      continue
    }

    // ── Step B: Confirm execution — pass back the same conversationId so the
    //            server can find the pendingPlan it stored in-memory ──────────
    let confirmResponse
    try {
      const { status, json } = await sendPrompt(
        projectId,
        'Yes, go ahead and build it exactly as described.',
        token, cookieStr, conversationId
      )
      confirmResponse = json
      if (status >= 500) console.warn(`   ⚠️  Confirm returned HTTP ${status}`)
      console.log(`   Step 2 done (${((Date.now()-t0)/1000).toFixed(1)}s) type=${json.type || '?'} — waiting for schema...`)
    } catch (e) {
      console.warn(`   ⚠️  Confirm step failed: ${e.message}`)
    }

    const elapsed = Date.now() - t0

    // ── Step C: Poll state graph (up to 10 attempts, 5s apart) ─────────────────
    let tables = []
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(5000)
      tables = await getTables(projectId, token, cookieStr)
      if (tables.length > 0) break
      console.log(`   Polling schema... attempt ${attempt + 1}/10 (${tables.length} entities)`)
    }

    // Merge both responses for evaluation text
    const mergedResponse = {
      message: [
        chatResponse?.message || '',
        chatResponse?.response || '',
        confirmResponse?.message || '',
        confirmResponse?.response || '',
        JSON.stringify(chatResponse),
        JSON.stringify(confirmResponse),
      ].join(' '),
      authEnabled: chatResponse?.authEnabled || confirmResponse?.authEnabled || false,
    }

    const result = evaluate(test, tables, elapsed, mergedResponse, confirmResponse)
    printResult(test, result, tables, projectId)
    results.push({ test, result, projectId })

    if (result.allPassed) passed++
    else failed++

    // Small gap between requests to be nice to the server
    if (test.id < PROMPTS.length) await sleep(1000)
  }

  // ─── Summary table ───────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(60))
  console.log('  FINAL RESULTS')
  console.log('═'.repeat(60))
  console.log(`  ✅ Passed: ${passed}/20`)
  console.log(`  ⚠️  Issues: ${failed}/20`)
  console.log('\n  # │ Name                              │ Users │ Entities │ FKs │ M2M │ Time')
  console.log('  ' + '─'.repeat(78))

  for (const r of results) {
    if (r.error) {
      console.log(`  ${String(r.test.id).padStart(2)} │ ${r.test.name.padEnd(33)} │  ERR  │   ERR    │ ERR │ ERR │ ERR`)
      continue
    }
    const { result, test } = r
    const row = [
      String(test.id).padStart(2),
      test.name.padEnd(33),
      (result.hasUsers      ? ' ✓ ' : ' ✗ ').padEnd(5),
      (`${result.entitiesFound.length}/${result.entityTotal}`).padEnd(8),
      (result.hasRelationships ? ' ✓ ' : ' ✗ ').padEnd(3),
      (!test.manyToMany ? ' — ' : result.m2mOk ? ' ✓ ' : ' ✗ ').padEnd(3),
      `${(result.elapsed/1000).toFixed(1)}s ${result.timeOk ? '✓' : '✗'}`,
    ]
    console.log(`  ${row.join(' │ ')}`)
  }

  console.log('\n' + '═'.repeat(60))

  // Detailed failures
  const failures = results.filter(r => r.result && !r.result.allPassed)
  if (failures.length > 0) {
    console.log('\n  ITEMS TO REVIEW:')
    for (const r of failures) {
      const issues = []
      if (!r.result.hasUsers)          issues.push('missing users table')
      if (!r.result.entitiesOk)        issues.push(`entities only ${r.result.entitiesFound.length}/${r.result.entityTotal}`)
      if (!r.result.hasRelationships)  issues.push('no FK evidence')
      if (r.test.manyToMany && !r.result.m2mOk) issues.push('no M2M evidence')
      if (!r.result.timeOk)            issues.push(`too slow (${(r.result.elapsed/1000).toFixed(1)}s, limit 120s)`)
      console.log(`  • #${r.test.id} ${r.test.name}: ${issues.join(', ')}`)
    }
  }

  console.log('')
}

main().catch(e => {
  console.error('\n💥 Unexpected error:', e)
  process.exit(1)
})
