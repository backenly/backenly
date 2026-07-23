/**
 * SECTION 6: TYPO NORMALIZATION LAYER
 * 
 * Deterministic, dictionary-based typo correction.
 * Runs BEFORE semantic classification.
 * 
 * Features:
 * - Common verb typos (craete → create, delte → delete)
 * - Singular/plural normalization
 * - Simple transpositions
 * 
 * IMPORTANT: This does NOT use LLM.
 * Pure deterministic dictionary-based correction.
 */

/**
 * Common verb typo corrections
 * Maps typo → correct word
 */
const VERB_TYPO_DICTIONARY: Record<string, string> = {
  // Create variants
  'craete': 'create',
  'crate': 'create',
  'creat': 'create',
  'creatw': 'create',
  'ceate': 'create',
  'creae': 'create',
  'craet': 'create',
  'creatte': 'create',
  'creeate': 'create',
  'createe': 'create',
  
  // Delete variants
  'delte': 'delete',
  'delet': 'delete',
  'deleet': 'delete',
  'delate': 'delete',
  'deltte': 'delete',
  'deleete': 'delete',
  'deltee': 'delete',
  
  // Update variants
  'updat': 'update',
  'upadte': 'update',
  'updaet': 'update',
  'updte': 'update',
  'uppdate': 'update',
  'updatte': 'update',
  'udate': 'update',
  
  // Add variants
  'ad': 'add',
  'addd': 'add',
  'aadd': 'add',
  
  // Remove variants
  'rmove': 'remove',
  'remov': 'remove',
  'reomve': 'remove',
  'removee': 'remove',
  'remvoe': 'remove',
  
  // Build variants
  'buil': 'build',
  'buidl': 'build',
  'biuld': 'build',
  'buildd': 'build',
  
  // Make variants
  'mak': 'make',
  'mkae': 'make',
  'maek': 'make',
  'makee': 'make',
  
  // Get variants
  'gett': 'get',
  'geet': 'get',
  'gte': 'get',
  
  // Set variants
  'sett': 'set',
  'seet': 'set',
  'ste': 'set',
  
  // List variants
  'lsit': 'list',
  'lis': 'list',
  'lisst': 'list',
  
  // Show variants
  'shwo': 'show',
  'sohw': 'show',
  'showw': 'show',
  
  // Edit variants
  'edti': 'edit',
  'editr': 'edit',
  'edi': 'edit',
  
  // Enable variants
  'enabl': 'enable',
  'enabel': 'enable',
  'eanbel': 'enable',
  
  // Disable variants
  'disabl': 'disable',
  'disbale': 'disable',
  'diable': 'disable',
  
  // Configure variants
  'confgiure': 'configure',
  'configur': 'configure',
  'configue': 'configure',
  
  // Setup variants
  'stup': 'setup',
  'setpu': 'setup',
  'steup': 'setup',
}

/**
 * Common noun typo corrections
 */
const NOUN_TYPO_DICTIONARY: Record<string, string> = {
  // Table variants
  'tabel': 'table',
  'tabl': 'table',
  'talbe': 'table',
  
  // Database variants
  'databse': 'database',
  'databaes': 'database',
  'databsae': 'database',
  'datbase': 'database',
  
  // User variants
  'usr': 'user',
  'usre': 'user',
  'uesr': 'user',
  
  // API variants
  'aip': 'api',
  'pia': 'api',
  
  // Auth variants
  'atuh': 'auth',
  'auht': 'auth',
  'athentication': 'authentication',
  'authenticaiton': 'authentication',
  
  // Schema variants
  'schmea': 'schema',
  'shcema': 'schema',
  'scheam': 'schema',
  
  // Field variants
  'feild': 'field',
  'fild': 'field',
  'fileds': 'fields',
  'feilds': 'fields',
  
  // Column variants
  'colum': 'column',
  'coulmn': 'column',
  'collumn': 'column',
  
  // Storage variants
  'stroage': 'storage',
  'storgae': 'storage',
  'stoarge': 'storage',
  
  // Backend variants
  'beckend': 'backend',
  'baceknd': 'backend',
  'bakend': 'backend',
  
  // Project variants
  'porject': 'project',
  'projcet': 'project',
  'proejct': 'project',
  
  // Review variants
  'reveiw': 'review',
  'reviwe': 'review',
  'reivew': 'review',
  
  // Order variants
  'ordr': 'order',
  'oderr': 'order',
  'ordeer': 'order',
  
  // Product variants
  'prodcut': 'product',
  'prodctu': 'product',
  'porduct': 'product',
  
  // Customer variants
  'custoemr': 'customer',
  'cusotmer': 'customer',
  'cutomer': 'customer',
  
  // Comment variants
  'commetn': 'comment',
  'comemnt': 'comment',
  'commnent': 'comment',
  
  // Post variants
  'psot': 'post',
  'pots': 'post',
}

/**
 * Plural normalization rules
 * Common plural typos or inconsistencies
 */
const PLURAL_NORMALIZATIONS: Record<string, string> = {
  'user': 'users',
  'table': 'tables',
  'product': 'products',
  'order': 'orders',
  'customer': 'customers',
  'review': 'reviews',
  'comment': 'comments',
  'post': 'posts',
  'category': 'categories',
  'item': 'items',
}

/**
 * Normalize a single word using dictionary
 */
function normalizeWord(word: string): { original: string; corrected: string; wasFixed: boolean } {
  const lowerWord = word.toLowerCase()
  
  // Check verb dictionary
  if (VERB_TYPO_DICTIONARY[lowerWord]) {
    return {
      original: word,
      corrected: VERB_TYPO_DICTIONARY[lowerWord],
      wasFixed: true,
    }
  }
  
  // Check noun dictionary
  if (NOUN_TYPO_DICTIONARY[lowerWord]) {
    return {
      original: word,
      corrected: NOUN_TYPO_DICTIONARY[lowerWord],
      wasFixed: true,
    }
  }
  
  return {
    original: word,
    corrected: word,
    wasFixed: false,
  }
}

/**
 * Normalize plural forms for entity names
 * "create user table" → "create users table"
 */
function normalizePlural(word: string): string {
  const lowerWord = word.toLowerCase()
  return PLURAL_NORMALIZATIONS[lowerWord] || word
}

export interface TypoNormalizationResult {
  originalMessage: string
  normalizedMessage: string
  corrections: Array<{
    original: string
    corrected: string
    position: number
  }>
  wasModified: boolean
}

/**
 * Main typo normalization function
 * 
 * Runs deterministic dictionary-based correction on input message.
 * DOES NOT use LLM.
 * 
 * @param message - The user's input message
 * @returns Normalized message with corrections tracked
 */
export function normalizeTypos(message: string): TypoNormalizationResult {
  const corrections: TypoNormalizationResult['corrections'] = []
  
  // Split into words while preserving positions
  const words = message.split(/(\s+)/)
  const normalizedWords: string[] = []
  let currentPosition = 0
  
  for (const segment of words) {
    // If whitespace, keep as-is
    if (/^\s+$/.test(segment)) {
      normalizedWords.push(segment)
      currentPosition += segment.length
      continue
    }
    
    // Normalize the word
    const result = normalizeWord(segment)
    
    if (result.wasFixed) {
      corrections.push({
        original: result.original,
        corrected: result.corrected,
        position: currentPosition,
      })
      normalizedWords.push(result.corrected)
    } else {
      normalizedWords.push(segment)
    }
    
    currentPosition += segment.length
  }
  
  const normalizedMessage = normalizedWords.join('')
  
  return {
    originalMessage: message,
    normalizedMessage,
    corrections,
    wasModified: corrections.length > 0,
  }
}

/**
 * Normalize entity name (applies plural normalization)
 * 
 * "user" → "users"
 * "review" → "reviews"
 */
export function normalizeEntityName(entityName: string): string {
  return normalizePlural(entityName)
}

/**
 * Quick check if message likely contains typos
 * Can be used for fast pre-filtering
 */
export function likelyContainsTypos(message: string): boolean {
  const lowerMessage = message.toLowerCase()
  const allTypos = [...Object.keys(VERB_TYPO_DICTIONARY), ...Object.keys(NOUN_TYPO_DICTIONARY)]
  
  return allTypos.some(typo => lowerMessage.includes(typo))
}

/**
 * Get all known corrections for debugging/testing
 */
export function getAllKnownTypos(): { verbs: string[]; nouns: string[] } {
  return {
    verbs: Object.keys(VERB_TYPO_DICTIONARY),
    nouns: Object.keys(NOUN_TYPO_DICTIONARY),
  }
}
