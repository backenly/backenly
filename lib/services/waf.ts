/**
 * Web Application Firewall (WAF) Service
 * Detects and blocks common attack patterns
 */

export type AttackType = 'sql_injection' | 'xss' | 'path_traversal' | 'command_injection' | 'other'

export interface AttackDetection {
  detected: boolean
  attackType?: AttackType
  pattern?: string
  confidence: number // 0-1
}

/**
 * SQL Injection patterns
 *
 * NOTE: Keep these patterns high-precision — they run on EVERY API request.
 * Avoid matching single characters like =, %, +, or * which appear in
 * legitimate query strings and cause catastrophic false positives.
 * The WAF is a last-resort guard; parameterized queries are the primary defence.
 */
const SQL_INJECTION_PATTERNS = [
  /\b(UNION\s+ALL\s+SELECT|UNION\s+SELECT)\b/i,          // UNION-based injection
  /\bINFORMATION_SCHEMA\b/i,                              // schema enumeration
  /\bSYSTEM_USER\s*\(\s*\)/i,                             // fingerprinting
  /\bWAITFOR\s+DELAY\b/i,                                 // time-based blind
  /\bSLEEP\s*\(\s*\d+\s*\)/i,                             // MySQL time-based
  /\bBENCHMARK\s*\(/i,                                    // MySQL fingerprint
  /(\bOR\b|\bAND\b)\s+['"]?\w+['"]?\s*=\s*['"]?\w+['"]?\s*(--|#|\/\*)/i, // OR/AND tautology with comment
  /;\s*(DROP|ALTER|TRUNCATE|DELETE\s+FROM|UPDATE\s+\w+\s+SET)\b/i, // stacked queries
  /\bEXEC\s*\(/i,                                          // stored proc exec
  /\bxp_cmdshell\b/i,                                     // MSSQL RCE
  /'[^']*'\s*OR\s*'[^']*'\s*=\s*'/i,                     // classic ' OR '1'='1
]

/**
 * XSS (Cross-Site Scripting) patterns
 */
const XSS_PATTERNS = [
  /<script[^>]*>.*?<\/script>/gi,
  /<iframe[^>]*>.*?<\/iframe>/gi,
  /javascript:/i,
  /on\w+\s*=/i, // onclick=, onerror=, etc.
  /<img[^>]*src[^>]*=.*javascript:/i,
  /<svg[^>]*>.*<script/i,
  /<body[^>]*onload/i,
  /<input[^>]*onfocus/i,
  /<link[^>]*href.*javascript:/i,
  /<meta[^>]*http-equiv.*refresh/i,
  /expression\s*\(/i, // CSS expression
  /vbscript:/i,
  /data:text\/html/i,
]

/**
 * Path Traversal patterns
 */
const PATH_TRAVERSAL_PATTERNS = [
  /\.\.\//g,
  /\.\.\\/g,
  /\.\.%2F/i,
  /\.\.%5C/i,
  /\.\.%252F/i,
  /\.\.%255C/i,
  /\.\.%c0%af/i,
  /\.\.%c1%9c/i,
  /\.\.%2e%2e%2f/i,
  /\.\.%2e%2e%5c/i,
]

/**
 * Command Injection patterns
 *
 * NOTE: Patterns here MUST NOT match normal URL characters like (, ), [, ], &.
 * These characters are common in legitimate query strings and path segments.
 * Only match sequences that are unambiguously shell injection — never single chars.
 */
const COMMAND_INJECTION_PATTERNS = [
  /`[^`]{1,200}`/,                                        // backtick command substitution
  /\$\([^)]{1,200}\)/,                                    // $(cmd) substitution
  /\|\s*(bash|sh|cmd\.exe|powershell)\b/i,                // pipe to shell interpreter
  /;\s*(bash|sh|cmd\.exe|powershell|wget|curl)\b/i,       // semicolon shell chaining
  /\bexec\s*\(\s*['"]?(bash|sh|cmd|powershell)/i,         // exec("bash"...)
]

/**
 * Check for SQL injection attacks
 */
function detectSQLInjection(input: string): AttackDetection {
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      return {
        detected: true,
        attackType: 'sql_injection',
        pattern: pattern.toString(),
        confidence: 0.8,
      }
    }
  }
  return { detected: false, confidence: 0 }
}

/**
 * Check for XSS attacks
 */
function detectXSS(input: string): AttackDetection {
  for (const pattern of XSS_PATTERNS) {
    if (pattern.test(input)) {
      return {
        detected: true,
        attackType: 'xss',
        pattern: pattern.toString(),
        confidence: 0.9,
      }
    }
  }
  return { detected: false, confidence: 0 }
}

/**
 * Check for path traversal attacks
 */
function detectPathTraversal(input: string): AttackDetection {
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(input)) {
      return {
        detected: true,
        attackType: 'path_traversal',
        pattern: pattern.toString(),
        confidence: 0.85,
      }
    }
  }
  return { detected: false, confidence: 0 }
}

/**
 * Check for command injection attacks
 */
function detectCommandInjection(input: string): AttackDetection {
  for (const pattern of COMMAND_INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      return {
        detected: true,
        attackType: 'command_injection',
        pattern: pattern.toString(),
        confidence: 0.75,
      }
    }
  }
  return { detected: false, confidence: 0 }
}

/**
 * Scan a string for attack patterns
 */
export function scanForAttacks(input: string): AttackDetection {
  if (!input || typeof input !== 'string') {
    return { detected: false, confidence: 0 }
  }

  // Check all attack types
  const checks = [
    detectSQLInjection(input),
    detectXSS(input),
    detectPathTraversal(input),
    detectCommandInjection(input),
  ]

  // Return the highest confidence detection
  const detected = checks.find((check) => check.detected)
  if (detected) {
    return detected
  }

  return { detected: false, confidence: 0 }
}

/**
 * Scan request data (query params, body, headers) for attacks
 */
export function scanRequest(data: {
  query?: Record<string, any>
  body?: any
  headers?: Record<string, string>
  path?: string
}): AttackDetection {
  const inputs: string[] = []

  // Check query parameters
  if (data.query) {
    Object.values(data.query).forEach((value) => {
      if (typeof value === 'string') {
        inputs.push(value)
      } else if (typeof value === 'object') {
        inputs.push(JSON.stringify(value))
      }
    })
  }

  // Check request body
  if (data.body) {
    if (typeof data.body === 'string') {
      inputs.push(data.body)
    } else if (typeof data.body === 'object') {
      inputs.push(JSON.stringify(data.body))
    }
  }

  // Check headers — only referer is a realistic injection vector.
  // user-agent is NOT scanned: legitimate tools (curl, wget, Postman) would
  // false-positive on the command-injection keyword list.
  if (data.headers) {
    const scanHeaders = ['referer']
    Object.entries(data.headers).forEach(([key, value]) => {
      if (scanHeaders.includes(key.toLowerCase()) && typeof value === 'string') {
        inputs.push(value)
      }
    })
  }

  // Check path
  if (data.path) {
    inputs.push(data.path)
  }

  // Scan all inputs
  for (const input of inputs) {
    const detection = scanForAttacks(input)
    if (detection.detected) {
      return detection
    }
  }

  return { detected: false, confidence: 0 }
}

/**
 * Sanitize input for logging (remove sensitive data)
 */
export function sanitizeForLogging(input: string, maxLength = 500): string {
  if (!input) return ''
  
  // Truncate long inputs
  let sanitized = input.length > maxLength 
    ? input.substring(0, maxLength) + '...' 
    : input
  
  // Remove potential sensitive patterns (basic)
  sanitized = sanitized.replace(/password[=:]\s*[^\s&]+/gi, 'password=***')
  sanitized = sanitized.replace(/api[_-]?key[=:]\s*[^\s&]+/gi, 'api_key=***')
  sanitized = sanitized.replace(/token[=:]\s*[^\s&]+/gi, 'token=***')
  sanitized = sanitized.replace(/secret[=:]\s*[^\s&]+/gi, 'secret=***')
  
  return sanitized
}

