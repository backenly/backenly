/**
 * Non-Features System (Phase 15)
 * 
 * Defines what Backenly DOES NOT do to maintain simplicity.
 * AI must politely refuse these requests.
 */

export interface NonFeature {
  pattern: RegExp
  category: 'custom-sql' | 'manual-schema' | 'webhooks' | 'logic-editors' | 'config-exposure' | 'realtime-config' | 'traditional-backend'
  refusalMessage: string
  alternative?: string
}

/**
 * Explicit list of non-features
 * These maintain product simplicity and prevent scope creep
 */
export const NON_FEATURES: NonFeature[] = [
  // Frontend / UI development — Backenly is backend-only
  {
    pattern: /\b(build|create|make|generate|design|code)\b.{0,30}\b(frontend|front[\s-]end|ui|user interface|react|vue|angular|svelte|next\.?js|webpage|website|landing page|html|css)\b/i,
    category: 'config-exposure',
    refusalMessage: "Backenly is a backend-as-a-service platform — I build APIs, databases, and auth, not frontend UIs.",
    alternative: "Connect your own frontend using the SDK from the **Connect** tab. I'll keep the backend running for you.",
  },

  // Custom SQL
  // Only matches explicit SQL/DB technical requests
  // Safe: will not match normal English descriptions like "write a description"
  {
    pattern: /\bwrite\b.*\bsql\b|\bcustom\b.*\bquery\b|\braw\b.*\bsql\b|\bexecute\b.*\bsql\b/i,
    category: 'custom-sql',
    refusalMessage: "Backenly handles database operations automatically. You don't need to write SQL.",
    alternative: "Just describe what you want in plain English, and I'll handle the database work.",
  },
  // Only matches explicit SQL/DB technical constructs
  // Safe: will not match "review", "overview", "preview", "trigger a notification",
  //       "trigger an email", "index page", "view their orders", "view counts"
  {
    // Note: "create trigger", "create index" are intentionally excluded — Backenly supports those via AI chat.
    // "raw sql" / "custom sql" are ALSO excluded now: read-only SQL is a supported
    // surface (run_query). Refusing the phrase outright made the agent deny a
    // capability it has. Only the write-shaped constructs below stay refused.
    pattern: /\b(stored procedure|materialized view|database trigger|db trigger|sql function|pg function|drop index|create view)\b/i,
    category: 'custom-sql',
    refusalMessage: "Backenly manages database optimization automatically.",
    alternative: "Describe what you need, and I'll set it up the right way.",
  },

  // Manual Schema Editing
  // Only matches explicit requests to manually edit schema infrastructure
  // Safe: will not match "manually add a field" (legitimate builder request)
  // Note: "modify column type" is intentionally NOT blocked — the AI handles ALTER COLUMN TYPE
  //       safely with automatic data migration (ALTER_COLUMN_TYPE action).
  {
    pattern: /\bmanually\b.*\bedit\b.*\bschema\b|\bdirect\b.*\baccess\b.*\bschema\b/i,
    category: 'manual-schema',
    refusalMessage: "Backenly handles this automatically. You don't need to manage it.",
    alternative: "Tell me what needs to change, and I'll make it happen safely.",
  },
  // Only matches explicit schema tooling requests
  // Safe: will not match "schema for my app" or "migration from monolith"
  {
    pattern: /\bschema editor\b|\bmigration file\b|\bmanual migration\b/i,
    category: 'manual-schema',
    refusalMessage: "Schema changes happen automatically when you describe what you need.",
    alternative: "Just say what should change, like 'add a price field to products'.",
  },

  // Webhooks
  // Only matches explicit webhook configuration tooling requests
  // Safe: will not match "notify via webhook" (legitimate integration description)
  {
    pattern: /\bwebhook\b.*\bbuilder\b|\bwebhook\b.*\bconfiguration\b.*\bpanel\b|\bwebhook\b.*\bendpoint\b.*\beditor\b/i,
    category: 'webhooks',
    refusalMessage: "Webhooks work automatically when you describe integrations.",
    alternative: "Tell me what should happen when something changes, and I'll set it up.",
  },
  {
    pattern: /\bconfigure\b.*\bwebhook\b|\bsetup\b.*\bwebhook\b.*\bmanually\b|\bwebhook\b.*\bpayload\b.*\bformat\b/i,
    category: 'webhooks',
    refusalMessage: "Integration happens through simple descriptions, not manual configuration.",
  },

  // Logic Editors / Conditional Logic
  // Only matches explicit requests for visual logic-editor tools
  // Safe: will not match "if user cancels, send email" (legitimate behavior description)
  {
    pattern: /\bif.*then.*else\b.*\beditor\b|\bconditional logic builder\b|\bworkflow editor\b/i,
    category: 'logic-editors',
    refusalMessage: "Logic is built through conversation, not visual editors.",
    alternative: "Describe the behavior you want, like 'notify admins when orders exceed $1000'.",
  },
  {
    pattern: /\bvisual workflow\b|\bdrag.*drop.*logic\b|\bflow builder\b/i,
    category: 'logic-editors',
    refusalMessage: "Backenly creates logic from your descriptions.",
    alternative: "Just explain what should happen, and I'll implement it.",
  },

  // Configuration Exposure
  // Only matches explicit requests for environment variable editors or raw config files
  // Safe: will not match "configure availability" or "set configuration"
  {
    pattern: /\benvironment variable editor\b|\b\.env\b.*\beditor\b|\bconfig file editor\b/i,
    category: 'config-exposure',
    refusalMessage: "Configuration is managed automatically for security.",
    alternative: "Backenly handles secure configuration behind the scenes.",
  },
  // Only matches explicit requests to manually configure CORS/rate-limit/security panels
  // Safe: will not match "security features", "rate plans", "settings page"
  {
    pattern: /\bcors settings panel\b|\brate limit config\b|\bsecurity settings panel\b/i,
    category: 'config-exposure',
    refusalMessage: "Security settings are automatically optimized.",
    alternative: "Backenly ensures your app is secure without manual configuration.",
  },

  // Advanced/Technical Features
  // Only matches explicit requests for infrastructure tuning keywords
  // Safe: will not match "optimize user experience" or "connection between users and posts"
  {
    pattern: /\bconnection pooling\b|\bdatabase tuning\b|\bquery optimization panel\b/i,
    category: 'config-exposure',
    refusalMessage: "Performance optimization happens automatically.",
    alternative: "Backenly scales and optimizes as your app grows.",
  },
  {
    pattern: /\bkubernetes\b|\bdocker config\b|\binfrastructure setup\b/i,
    category: 'config-exposure',
    refusalMessage: "Infrastructure is managed automatically.",
    alternative: "Just build your app—hosting and scaling are handled for you.",
  },

  // Realtime Configuration
  // Refuses manual WebSocket / channel / subscription configuration.
  // Realtime is automatic — users just call .subscribe() in the SDK.
  {
    pattern: /\bconfigure\b.*\bwebsocket\b|\bwebsocket\b.*\bchannel\b|\bsubscription\b.*\bchannel\b|\bchannel\b.*\bconfigur/i,
    category: 'realtime-config',
    refusalMessage: "Realtime subscriptions are automatic in Backenly — no channel configuration needed.",
    alternative: "Just call `backend.<table>.subscribe(callback)` in your frontend. It works instantly.",
  },
  {
    pattern: /\bsetup\b.*\bpubsub\b|\bconfigure\b.*\bpubsub\b|\bpubsub\b.*\bchannel\b/i,
    category: 'realtime-config',
    refusalMessage: "Backenly handles pub/sub automatically.",
    alternative: "Tell me which data should update live — I'll set up the subscriptions for you.",
  },
  {
    pattern: /\bmanually\b.*\bsubscri|\bsubscription\b.*\bconfigur|\bconfigure\b.*\brealtime\b/i,
    category: 'realtime-config',
    refusalMessage: "Realtime is a built-in feature of every table — nothing to configure.",
    alternative: "Use `backend.<table>.subscribe(callback)` in your frontend to receive live updates.",
  },

  // ─── Traditional Backend Code Requests ────────────────────────────────────
  // These are things a traditional backend developer would ask for that have
  // NO equivalent in a BaaS. The translation layer handles ambiguous cases
  // (e.g. "users controller" → "users table"). These patterns catch explicit
  // requests for code files, frameworks, and architecture patterns.

  // Explicit code file requests
  {
    pattern: /\b(controller|route|router)\s*(file|class|folder|directory|module)\b|\b(controllers|routes|routers)\s*(folder|directory|module)\b/i,
    category: 'traditional-backend',
    refusalMessage: "In Backenly, you don't create controller or route files — those are generated automatically the moment you describe your data.",
    alternative: "Tell me what your app needs to manage (e.g. *'I need a products catalog and user orders'*) and I'll build the full backend for you.",
  },
  // Express / Fastify / Koa / Hapi — framework setup requests
  {
    pattern: /\b(set up|setup|install|create|initialize|init)\b.{0,25}\b(express|fastify|koa|hapi|nest\.?js|adonis)\b/i,
    category: 'traditional-backend',
    refusalMessage: "Backenly is your backend — you don't need Express, Fastify, or any other framework.",
    alternative: "Your APIs are already running. Check the **Connect** tab for your base URL and SDK snippet.",
  },
  // MVC / Repository / Service Layer architecture patterns
  {
    pattern: /\b(mvc|model[\s-]view[\s-]controller|repository pattern|service layer|layered architecture|clean architecture|hexagonal architecture)\b/i,
    category: 'traditional-backend',
    refusalMessage: "Backenly abstracts away architecture patterns — you describe what you want, not how to structure it.",
    alternative: "Just describe your app's data and behaviour in plain language — I'll handle the architecture.",
  },
  // Explicit server entry-point files
  {
    pattern: /\b(create|generate|write|make)\b.{0,20}\b(server\.js|app\.js|index\.js|main\.ts|server\.ts|app\.ts)\b/i,
    category: 'traditional-backend',
    refusalMessage: "You don't have a server file to manage — Backenly runs your backend for you.",
    alternative: "Your backend is already live. Use the **Connect** tab to get your base URL.",
  },
  // npm / package management
  {
    pattern: /\b(npm install|yarn add|pnpm add|install\s+express|install\s+fastify|install\s+prisma|install\s+sequelize)\b/i,
    category: 'traditional-backend',
    refusalMessage: "You don't manage packages or dependencies — Backenly handles all of that.",
    alternative: "Focus on describing your backend logic — all the infrastructure is taken care of.",
  },
  // ORM / query builder setup
  {
    pattern: /\b(set up|setup|configure|install)\b.{0,25}\b(prisma|sequelize|typeorm|drizzle|knex|mongoose|objection)\b/i,
    category: 'traditional-backend',
    refusalMessage: "Backenly manages the database layer — you never interact with an ORM directly.",
    alternative: "Describe the data you need to store and I'll create the tables and APIs for you.",
  },
  // Middleware files (auth middleware is handled by translation layer for ambiguous cases)
  {
    pattern: /\b(create|add|write|build)\b.{0,25}\bmiddleware\s+(file|function|class|module|folder)\b/i,
    category: 'traditional-backend',
    refusalMessage: "Middleware is handled automatically by Backenly — there's nothing to configure.",
    alternative: "If you need authentication or access control, just say so and I'll set it up.",
  },
  // Dockerfile / docker-compose for the app server
  {
    pattern: /\b(create|write|generate|add)\b.{0,25}\b(dockerfile|docker[\s-]?compose|containerize)\b/i,
    category: 'traditional-backend',
    refusalMessage: "Backenly handles deployment and containerization — you don't need a Dockerfile.",
    alternative: "Your backend is deployed automatically. Use the **Publish** tab to manage deployments.",
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// OPTION 2: BaaS Translation Layer
// Silently converts traditional backend developer vocabulary into BaaS-native
// intent BEFORE it reaches the non-feature check or the intent planner.
//
// Rule: if the request DESCRIBES a concept (e.g. "users controller" = managing
// users) → translate to its BaaS equivalent.
// Rule: if the request asks for a CODE ARTIFACT (e.g. "controller file") →
// let the non-feature check handle it as a hard refusal.
// ─────────────────────────────────────────────────────────────────────────────

export interface BaasTranslation {
  /** The rewritten message sent to the AI */
  message: string
  /** Whether any translation occurred */
  translated: boolean
  /** Human-readable note about what was translated — for internal logging */
  note?: string
}

export function translateToBaasIntent(message: string): BaasTranslation {
  let msg = message
  const notes: string[] = []

  // Helper: mark a translation and push a note
  const mark = (note: string) => notes.push(note)

  // ── 1. "[verb] [entity] controller" → "[verb] [entity] table"
  //    e.g. "create a users controller" → "create a users table"
  //    Guards:
  //    - skip if followed by "file/class/folder" (caught by non-feature check)
  //    - skip if entity is auth/jwt/session/login/signup/permission/role — these describe
  //      authentication architecture, NOT database tables, and translating them causes
  //      ENABLE_AUTH to fire incorrectly instead of returning a routing explanation
  if (
    /\b\w+\s+controller\b(?!\s*(file|class|folder|module|directory))/i.test(msg) &&
    !/\b(auth|authentication|jwt|session|login|signup|sign.?up|sign.?in|permission|role|user)\s+controller\b/i.test(msg)
  ) {
    msg = msg.replace(/\b(\w+)\s+controller\b(?!\s*(file|class|folder|module|directory))/gi, '$1 table')
    mark('controller → table')
  }

  // ── 2. "routes for [entity]" / "add routes for [entity]" → "table for [entity]"
  //    e.g. "add routes for products" → "add table for products"
  //    Guard: skip if followed by "file/folder"
  if (/\broutes?\b(?!\s*(file|folder|module|directory)).{0,10}\bfor\s+\w+/i.test(msg)) {
    msg = msg.replace(/\broutes?\b(?!\s*(file|folder|module|directory))(.{0,10})\bfor\s+(\w+)/gi, 'table$2for $3')
    mark('routes → table')
  }

  // ── 3. "[verb] [entity] model" → "[verb] [entity] table"
  //    e.g. "define a post model" → "define a post table"
  //    Guard: skip "model file/class", "AI model", "machine learning model", "3D model"
  if (/\b\w+\s+model\b(?!\s*(file|class|folder|module))(?!.*\b(AI|machine learning|deep learning|3D|language)\b)/i.test(msg)) {
    msg = msg.replace(/\b(\w+)\s+model\b(?!\s*(file|class|folder|module))/gi, '$1 table')
    mark('model → table')
  }

  // ── 4. "CRUD for [entity]" / "CRUD endpoints for [entity]" → "table for [entity]"
  //    e.g. "set up CRUD for orders" → "set up table for orders"
  if (/\bCRUD\b.{0,20}\bfor\s+\w+/i.test(msg)) {
    msg = msg.replace(/\bCRUD\b(.{0,20})\bfor\s+(\w+)/gi, 'table$1for $2')
    mark('CRUD → table')
  }

  // ── 5. "REST API for [entity]" / "REST endpoints for [entity]" → "table for [entity]"
  //    e.g. "create REST API for tasks" → "create table for tasks"
  if (/\bREST\b.{0,30}\bfor\s+\w+/i.test(msg)) {
    msg = msg.replace(/\bREST\b.{0,30}\bfor\s+(\w+)/gi, (_, entity) => `table for ${entity}`)
    mark('REST API → table')
  }

  // ── 6. "[auth/JWT] middleware" → "authentication"
  //    e.g. "add JWT middleware" → "add authentication"
  //    e.g. "middleware for authentication" → "authentication"
  if (/\b(auth(?:entication)?|JWT)\s+middleware\b/i.test(msg)) {
    msg = msg.replace(/\b(auth(?:entication)?|JWT)\s+middleware\b/gi, 'authentication')
    mark('auth middleware → authentication')
  }
  if (/\bmiddleware\s+for\s+(auth(?:entication)?|JWT)\b/i.test(msg)) {
    msg = msg.replace(/\bmiddleware\s+for\s+(auth(?:entication)?|JWT)\b/gi, 'authentication')
    mark('middleware for auth → authentication')
  }

  // ── 7. "[verb] [entity] service" → "[verb] [entity] table"
  //    e.g. "create a payment service" → "create a payment table"
  //    Guard: "service" alone without an entity noun is left as-is; also skip
  //    "service file/class/layer" (caught by non-feature patterns)
  if (/\b\w+\s+service\b(?!\s*(file|class|layer|module|folder|directory))/i.test(msg)) {
    msg = msg.replace(/\b(\w+)\s+service\b(?!\s*(file|class|layer|module|folder|directory))/gi, '$1 table')
    mark('service → table')
  }

  // ── 8. "endpoint(s) for [entity]" → "API for [entity]"
  //    e.g. "add endpoints for invoices" → "add API for invoices"
  if (/\bendpoints?\s+for\s+\w+/i.test(msg)) {
    msg = msg.replace(/\bendpoints?\s+for\s+(\w+)/gi, 'API for $1')
    mark('endpoints → API')
  }

  return {
    message: msg,
    translated: notes.length > 0,
    note: notes.length > 0 ? notes.join(', ') : undefined,
  }
}

/**
 * Check if a user intent is a non-feature request
 */
export function isNonFeatureRequest(intent: string): {
  isNonFeature: boolean
  refusal?: NonFeature
} {
  const intentLower = intent.toLowerCase()

  for (const nonFeature of NON_FEATURES) {
    if (nonFeature.pattern.test(intentLower)) {
      return {
        isNonFeature: true,
        refusal: nonFeature,
      }
    }
  }

  return { isNonFeature: false }
}

/**
 * Generate polite refusal message
 */
export function generateRefusalMessage(refusal: NonFeature): string {
  let message = refusal.refusalMessage

  if (refusal.alternative) {
    message += `\n\n${refusal.alternative}`
  }

  return message
}

/**
 * PRINCIPLES:
 * 
 * 1. Say "no" politely and confidently
 * 2. Explain WHY we don't do it (simplicity, security, automation)
 * 3. Offer the Backenly alternative
 * 4. Never apologize for saying no
 * 5. Reinforce that this is a feature, not a limitation
 * 
 * GOOD:
 * "Backenly handles this automatically. You don't need to manage it."
 * 
 * BAD:
 * "Sorry, we don't support that feature yet."
 */
