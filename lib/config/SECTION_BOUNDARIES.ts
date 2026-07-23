/**
 * BACKENLY SECTION BOUNDARIES - NON-NEGOTIABLE POSITIONING
 * =========================================================
 * 
 * This file defines what each section is ALLOWED and NOT ALLOWED to do.
 * These rules ensure Backenly feels predictable, trustworthy, and professional.
 * 
 * CORE PRINCIPLE:
 * Intent → Confirm → Real Backend → Manage Reality
 * 
 * ❌ No fake resources
 * ❌ No silent side-effects
 * ❌ No "magic" without confirmation
 * ✅ One-way transitions are explicit
 * ✅ Database is the source of truth
 * 
 * 🚨 GOLDEN RULE:
 * Only Database section can create backend reality. All other sections manage it.
 */

export const SECTION_BOUNDARIES = {
  /**
   * 1️⃣ API BUILDER
   * Purpose: Manage real APIs (not create them)
   */
  API_BUILDER: {
    name: 'API Builder',
    purpose: 'Manage real APIs',
    
    allowed: [
      'View only real API Definitions from database',
      'Edit API behavior (filters, auth, rate limits)',
      'Version APIs (v1, v2, etc.)',
      'Enable / disable existing APIs',
      'Test real API endpoints',
      'Configure API documentation',
    ],
    
    notAllowed: [
      'Create APIs without tables',
      'Show "planned" or "preview" APIs',
      'Execute workspace TypeScript files',
      'Generate fake endpoints',
      'Create tables',
      'Modify database schema',
    ],
    
    reasoning: 'API Builder manages reality — it never creates it. If something is shown here, it must be callable right now.',
    
    sourceOfTruth: 'api_definitions table (database)',
    emptyState: 'Redirect to Database Management with clear CTA',
  },

  /**
   * 2️⃣ DATABASE (CORE SECTION)
   * Purpose: Convert intent into reality
   */
  DATABASE: {
    name: 'Database Management',
    purpose: 'Convert intent into reality',
    
    allowed: [
      'Plan tables (show metadata before creation)',
      'Show warnings before "Make Real" action',
      'Create real database tables',
      'Auto-create API Definitions with tables',
      'Edit table structure (with warnings)',
      'View real table data',
      'Insert/update/delete rows',
    ],
    
    notAllowed: [
      'Silent table creation without confirmation',
      'Auto-rebuilding schema after edits',
      'Regenerating from metadata after tables exist',
      'Showing fake/temporary tables',
      'Creating APIs without tables',
    ],
    
    reasoning: 'Database is where intent becomes irreversible reality. This is why confirmation modal is mandatory.',
    
    sourceOfTruth: 'Workspace PostgreSQL schema + tables table (platform)',
    requiresConfirmation: true,
    isIrreversible: true,
  },

  /**
   * 3️⃣ FILE STORAGE
   * Purpose: Store real files
   */
  FILE_STORAGE: {
    name: 'File Storage',
    purpose: 'Store real files',
    
    allowed: [
      'Create real storage buckets',
      'Generate upload/download API endpoints',
      'Apply auth policies to buckets',
      'Set file size limits',
      'Show real file usage metrics',
      'Delete files/buckets with confirmation',
    ],
    
    notAllowed: [
      'Temporary or mock storage',
      'Fake file URLs',
      'Auto-upload without user action',
      'Simulated file listings',
      'Preview mode for buckets',
    ],
    
    reasoning: 'Files are data — they must be real and durable. Storage must behave like production from day one.',
    
    sourceOfTruth: 'storage_buckets + storage_files tables',
    requiresConfirmation: true,
  },

  /**
   * 4️⃣ CONNECT APP
   * Purpose: Connect real apps (bridge, not factory)
   */
  CONNECT_APP: {
    name: 'Connect App',
    purpose: 'Connect real apps to backend',
    
    allowed: [
      'Show base URLs for API access',
      'Generate SDK code snippets',
      'Display environment configurations',
      'Rotate API keys',
      'Show CORS settings',
      'Provide integration examples',
    ],
    
    notAllowed: [
      'Modify backend behavior',
      'Create APIs or tables',
      'Change database schema',
      'Generate new features',
      'Execute backend code',
    ],
    
    reasoning: 'Connect App only connects — it never creates. This section is a bridge, not a factory.',
    
    sourceOfTruth: 'api_keys + projects tables (read-only view)',
  },

  /**
   * 5️⃣ DEPLOY
   * Purpose: Publish real backend
   */
  DEPLOY: {
    name: 'Deploy',
    purpose: 'Publish already-working backend',
    
    allowed: [
      'Publish backend to production',
      'Assign custom domains',
      'Set environment variables',
      'Enable production mode',
      'Show deployment status',
      'Rollback to previous versions',
    ],
    
    notAllowed: [
      'Generate APIs during deploy',
      'Change database structure',
      'Run code generation',
      'Create new tables',
      'Modify API definitions',
    ],
    
    reasoning: 'Deploy exposes reality — it does not create it. Backend already works before deploy.',
    
    sourceOfTruth: 'deployments table',
    prerequisite: 'APIs must exist and work locally',
  },

  /**
   * 6️⃣ AUTHENTICATION
   * Purpose: Protect real access
   */
  AUTHENTICATION: {
    name: 'Authentication',
    purpose: 'Protect real APIs and data',
    
    allowed: [
      'Protect existing API endpoints',
      'Attach auth policies to tables',
      'Manage users and roles',
      'Rotate JWT secrets',
      'Configure OAuth providers',
      'Set password policies',
    ],
    
    notAllowed: [
      'Auth without APIs existing',
      'Auth without tables existing',
      'Fake login systems for testing',
      'Creating APIs through auth',
      'Modifying database through auth UI',
    ],
    
    reasoning: 'Auth exists to protect reality, not simulate it. Auth always attaches to something real.',
    
    sourceOfTruth: 'users + roles + api_keys tables',
    prerequisite: 'APIs and tables must exist first',
  },

  /**
   * 7️⃣ API KEYS (ADVANCED)
   * Purpose: Grant controlled access
   */
  API_KEYS: {
    name: 'API Keys',
    purpose: 'Grant controlled access to real APIs',
    
    allowed: [
      'Generate new API keys',
      'Scope permissions per key',
      'Monitor usage per key',
      'Revoke access',
      'Set rate limits per key',
      'Audit key activity',
    ],
    
    notAllowed: [
      'Create APIs through keys',
      'Bypass database rules',
      'Act as logic layer',
      'Modify backend structure',
      'Generate fake keys',
    ],
    
    reasoning: 'Keys unlock doors — they never build rooms. No key = no access. Key ≠ API.',
    
    sourceOfTruth: 'api_keys table',
    prerequisite: 'APIs must exist to grant access to',
  },

  /**
   * 8️⃣ MONITORING
   * Purpose: Observe real usage
   */
  MONITORING: {
    name: 'Monitoring',
    purpose: 'Observe real API calls and metrics',
    
    allowed: [
      'Display real API call logs',
      'Show real error traces',
      'Track latency and performance',
      'Show database impact metrics',
      'Alert on anomalies',
      'Export logs',
    ],
    
    notAllowed: [
      'Simulated traffic',
      'Fake metrics for preview',
      'Estimated usage',
      'Test data in production view',
      'Modifying APIs from monitoring',
    ],
    
    reasoning: 'Monitoring proves your backend is real. If traffic appears here, it truly happened.',
    
    sourceOfTruth: 'logs + metrics tables',
    displayOnly: true,
  },
} as const

/**
 * VALIDATION HELPERS
 * Use these to check if an action is allowed in a section
 */

export function canSectionCreateApis(section: keyof typeof SECTION_BOUNDARIES): boolean {
  // Only Database can create APIs (alongside tables)
  return section === 'DATABASE'
}

export function canSectionCreateTables(section: keyof typeof SECTION_BOUNDARIES): boolean {
  // Only Database can create tables
  return section === 'DATABASE'
}

export function canSectionModifyBackend(section: keyof typeof SECTION_BOUNDARIES): boolean {
  // Only Database and Authentication (for policies) can modify backend
  return section === 'DATABASE' || section === 'AUTHENTICATION'
}

export function requiresConfirmation(section: keyof typeof SECTION_BOUNDARIES): boolean {
  const config = SECTION_BOUNDARIES[section]
  return 'requiresConfirmation' in config && config.requiresConfirmation === true
}

export function isReadOnly(section: keyof typeof SECTION_BOUNDARIES): boolean {
  const config = SECTION_BOUNDARIES[section]
  return 'displayOnly' in config && config.displayOnly === true
}

/**
 * SECTION PURPOSE SUMMARY
 * One-line purpose for quick reference
 */
export const SECTION_PURPOSES = {
  DATABASE: 'Convert intent into reality',
  API_BUILDER: 'Manage real APIs',
  FILE_STORAGE: 'Store real files',
  AUTHENTICATION: 'Protect real access',
  API_KEYS: 'Grant controlled access',
  CONNECT_APP: 'Connect real apps',
  DEPLOY: 'Publish real backend',
  MONITORING: 'Observe real usage',
} as const

/**
 * GOLDEN RULE ENFORCEMENT
 * 
 * This function throws an error if a section tries to violate boundaries.
 * Use in middleware or action handlers.
 */
export function enforceGoldenRule(
  section: keyof typeof SECTION_BOUNDARIES,
  action: 'CREATE_API' | 'CREATE_TABLE' | 'MODIFY_SCHEMA'
): void {
  if (action === 'CREATE_API' && section !== 'DATABASE') {
    throw new Error(
      `GOLDEN RULE VIOLATION: ${section} cannot create APIs. Only Database Management can create backend reality.`
    )
  }
  
  if (action === 'CREATE_TABLE' && section !== 'DATABASE') {
    throw new Error(
      `GOLDEN RULE VIOLATION: ${section} cannot create tables. Only Database Management can create backend reality.`
    )
  }
  
  if (action === 'MODIFY_SCHEMA' && section !== 'DATABASE') {
    throw new Error(
      `GOLDEN RULE VIOLATION: ${section} cannot modify schema. Only Database Management can modify backend reality.`
    )
  }
}

export default SECTION_BOUNDARIES
