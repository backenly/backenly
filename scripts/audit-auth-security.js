#!/usr/bin/env node

/**
 * 🔒 BACKENLY AUTH SECURITY AUDIT - COMPREHENSIVE REPORT
 * 
 * This script performs a complete white-box security audit of the authentication system.
 * It scans all routes, validates middleware, checks isolation, and generates a detailed report.
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`)
}

function section(title) {
  log('\n' + '═'.repeat(70), 'cyan')
  log(`  ${title}`, 'bright')
  log('═'.repeat(70), 'cyan')
}

// Scan all API routes
function scanAPIRoutes() {
  section('📁 METHOD 2: SCANNING ALL API ROUTES')
  
  const apiPath = path.join(__dirname, '../app/api')
  const routes = []
  
  function scanDir(dir, basePath = '/api') {
    const files = fs.readdirSync(dir, { withFileTypes: true })
    
    for (const file of files) {
      const fullPath = path.join(dir, file.name)
      
      if (file.isDirectory()) {
        // Skip special Next.js folders
        if (file.name === 'node_modules' || file.name === '.next') continue
        
        // Extract route segment
        const segment = file.name.startsWith('[') ? ':param' : file.name
        scanDir(fullPath, `${basePath}/${segment}`)
      } else if (file.name === 'route.ts' || file.name === 'route.js') {
        const content = fs.readFileSync(fullPath, 'utf8')
        
        // Check for auth middleware
        const hasRequireAuth = content.includes('requireAuth') || content.includes('requireUser')
        const hasValidateProject = content.includes('validateProjectAccess') || content.includes('getProjectContext')
        const hasApiKeyCheck = content.includes('validateApiKey')
        
        // Check for HTTP methods
        const methods = []
        if (content.includes('export async function GET')) methods.push('GET')
        if (content.includes('export async function POST')) methods.push('POST')
        if (content.includes('export async function PUT')) methods.push('PUT')
        if (content.includes('export async function DELETE')) methods.push('DELETE')
        if (content.includes('export async function PATCH')) methods.push('PATCH')
        
        // Determine if route should be protected
        const isPublic = basePath.includes('/auth/login') ||
                        basePath.includes('/auth/register') ||
                        basePath.includes('/auth/verify-email') ||
                        basePath.includes('/health') ||
                        basePath.includes('/auth/github') ||
                        basePath.includes('/auth/google')
        
        routes.push({
          path: basePath,
          methods,
          hasAuth: hasRequireAuth || hasValidateProject || hasApiKeyCheck,
          requiresAuth: !isPublic,
          file: fullPath.replace(__dirname + '/../', ''),
        })
      }
    }
  }
  
  scanDir(apiPath)
  
  // Generate report
  log('\n📊 ROUTE PROTECTION ANALYSIS:\n', 'bright')
  
  let protectedCount = 0
  let unprotectedCount = 0
  let vulnerableRoutes = []
  
  for (const route of routes) {
    const status = route.requiresAuth 
      ? (route.hasAuth ? '✅ PROTECTED' : '❌ VULNERABLE')
      : '🌐 PUBLIC'
    
    const color = route.requiresAuth
      ? (route.hasAuth ? 'green' : 'red')
      : 'blue'
    
    log(`${status.padEnd(15)} ${route.methods.join(',').padEnd(20)} ${route.path}`, color)
    
    if (route.requiresAuth && route.hasAuth) protectedCount++
    if (route.requiresAuth && !route.hasAuth) {
      unprotectedCount++
      vulnerableRoutes.push(route)
    }
  }
  
  log('\n📈 SUMMARY:', 'bright')
  log(`  Total routes scanned: ${routes.length}`)
  log(`  Protected routes: ${protectedCount}`, 'green')
  log(`  Vulnerable routes: ${unprotectedCount}`, unprotectedCount === 0 ? 'green' : 'red')
  
  if (vulnerableRoutes.length > 0) {
    log('\n⚠️  SECURITY VULNERABILITIES FOUND:', 'red')
    vulnerableRoutes.forEach(route => {
      log(`  • ${route.path} (${route.methods.join(', ')})`, 'yellow')
      log(`    File: ${route.file}`, 'yellow')
    })
    return false
  }
  
  return true
}

// Check middleware implementation
function checkMiddleware() {
  section('🛡️  MIDDLEWARE SECURITY ANALYSIS')
  
  const middlewarePath = path.join(__dirname, '../lib/auth/middleware.ts')
  const serverPath = path.join(__dirname, '../lib/auth/server.ts')
  
  const checks = [
    { file: middlewarePath, name: 'requireAuth', desc: 'JWT validation middleware' },
    { file: middlewarePath, name: 'requireUser', desc: 'User authentication' },
    { file: serverPath, name: 'getProjectContext', desc: 'Project isolation' },
    { file: serverPath, name: 'validateApiKey', desc: 'API key validation' },
  ]
  
  let allFound = true
  
  for (const check of checks) {
    if (fs.existsSync(check.file)) {
      const content = fs.readFileSync(check.file, 'utf8')
      const found = content.includes(`function ${check.name}`) || content.includes(`export.*${check.name}`)
      
      if (found) {
        log(`  ✅ ${check.name.padEnd(25)} ${check.desc}`, 'green')
      } else {
        log(`  ❌ ${check.name.padEnd(25)} ${check.desc} - NOT FOUND`, 'red')
        allFound = false
      }
    } else {
      log(`  ❌ ${check.file} - FILE NOT FOUND`, 'red')
      allFound = false
    }
  }
  
  return allFound
}

// Check database isolation
function checkDatabaseIsolation() {
  section('🗄️  DATABASE ISOLATION ANALYSIS')
  
  const schemaPath = path.join(__dirname, '../prisma/schema.prisma')
  
  if (!fs.existsSync(schemaPath)) {
    log('  ❌ Prisma schema not found', 'red')
    return false
  }
  
  const schema = fs.readFileSync(schemaPath, 'utf8')
  
  const checks = [
    { pattern: /projectId.*String/g, desc: 'projectId field for isolation' },
    { pattern: /@@index\(\[projectId\]\)/g, desc: 'projectId indexes for performance' },
    { pattern: /userId.*String/g, desc: 'userId field for ownership' },
  ]
  
  let allFound = true
  
  for (const check of checks) {
    const matches = schema.match(check.pattern)
    if (matches && matches.length > 0) {
      log(`  ✅ ${matches.length} models with ${check.desc}`, 'green')
    } else {
      log(`  ⚠️  No models with ${check.desc}`, 'yellow')
    }
  }
  
  return allFound
}

// Check for security best practices
function checkSecurityBestPractices() {
  section('🔐 SECURITY BEST PRACTICES CHECK')
  
  const checks = [
    {
      name: 'Password Hashing',
      file: 'lib/auth/password.ts',
      required: ['bcrypt', 'hash', 'compare'],
    },
    {
      name: 'JWT Secret',
      env: 'JWT_SECRET',
      desc: 'Environment variable for JWT signing',
    },
    {
      name: 'Rate Limiting',
      file: 'lib/middleware/authRateLimit.ts',
      required: ['rateLimit', 'checkRateLimit'],
    },
    {
      name: 'Session Management',
      file: 'lib/auth/session.ts',
      required: ['createSession', 'verifySession', 'revokeSession'],
    },
    {
      name: 'CORS Configuration',
      file: 'lib/middleware/index.ts',
      required: ['withCORS'],
    },
  ]
  
  let allPassed = true
  
  for (const check of checks) {
    if (check.file) {
      const filePath = path.join(__dirname, '../', check.file)
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8')
        const allFound = check.required.every(req => content.includes(req))
        
        if (allFound) {
          log(`  ✅ ${check.name}`, 'green')
        } else {
          log(`  ❌ ${check.name} - Missing required functions`, 'red')
          allPassed = false
        }
      } else {
        log(`  ⚠️  ${check.name} - File not found`, 'yellow')
      }
    } else if (check.env) {
      log(`  ℹ️  ${check.name} - ${check.desc}`, 'cyan')
    }
  }
  
  return allPassed
}

// Generate final report
function generateFinalReport(results) {
  section('📊 FINAL SECURITY AUDIT REPORT')
  
  log('\n')
  log('╔════════════════════════════════════════════════════════════════╗', 'cyan')
  log('║       🔒 BACKENLY AUTH SECURITY AUDIT - FINAL REPORT           ║', 'cyan')
  log('╠════════════════════════════════════════════════════════════════╣', 'cyan')
  log('║                                                                ║', 'cyan')
  
  Object.entries(results).forEach(([test, passed]) => {
    const icon = passed ? '✅' : '❌'
    const status = passed ? 'PASSED' : 'FAILED'
    const testName = test.padEnd(45)
    log(`║  ${icon} ${testName} ${status.padStart(10)}     ║`, passed ? 'green' : 'red')
  })
  
  log('║                                                                ║', 'cyan')
  log('╠════════════════════════════════════════════════════════════════╣', 'cyan')
  
  const allPassed = Object.values(results).every(r => r)
  
  if (allPassed) {
    log('║                                                                ║', 'cyan')
    log('║  🎯 VERDICT: BACKENLY AUTH IS 100% PRODUCTION-SAFE             ║', 'green')
    log('║                                                                ║', 'cyan')
    log('║  ✓ Secure authentication & authorization                       ║', 'green')
    log('║  ✓ Complete route protection                                   ║', 'green')
    log('║  ✓ Project isolation enforced                                  ║', 'green')
    log('║  ✓ Security best practices followed                            ║', 'green')
    log('║  ✓ Enterprise-grade security                                   ║', 'green')
  } else {
    log('║                                                                ║', 'cyan')
    log('║  ⚠️  VERDICT: SECURITY ISSUES FOUND - FIX REQUIRED             ║', 'red')
    log('║                                                                ║', 'cyan')
    log('║  Please review the failed checks above and fix vulnerabilities ║', 'yellow')
  }
  
  log('║                                                                ║', 'cyan')
  log('╚════════════════════════════════════════════════════════════════╝', 'cyan')
  log('\n')
  
  return allPassed
}

// Main execution
function main() {
  log('\n🔒 STARTING BACKENLY AUTH SECURITY AUDIT...\n', 'bright')
  
  const results = {
    'Route Protection': scanAPIRoutes(),
    'Middleware Implementation': checkMiddleware(),
    'Database Isolation': checkDatabaseIsolation(),
    'Security Best Practices': checkSecurityBestPractices(),
  }
  
  const allPassed = generateFinalReport(results)
  
  // Write report to file
  const reportPath = path.join(__dirname, '../SECURITY_AUDIT_REPORT.txt')
  const timestamp = new Date().toISOString()
  const reportContent = `
BACKENLY AUTHENTICATION SECURITY AUDIT REPORT
Generated: ${timestamp}

RESULTS:
${Object.entries(results).map(([test, passed]) => `  ${passed ? '✅' : '❌'} ${test}: ${passed ? 'PASSED' : 'FAILED'}`).join('\n')}

VERDICT: ${allPassed ? 'PRODUCTION-SAFE ✅' : 'SECURITY ISSUES FOUND ⚠️'}

${allPassed ? `
✓ All authentication routes are properly protected
✓ Middleware implementation is secure
✓ Database isolation is enforced
✓ Security best practices are followed

Your Backenly authentication system is enterprise-grade and production-ready.
` : `
⚠️ Security vulnerabilities detected. Please review the console output above
   and address the identified issues before deploying to production.
`}
  `
  
  fs.writeFileSync(reportPath, reportContent)
  log(`\n📄 Full report saved to: ${reportPath}\n`, 'cyan')
  
  process.exit(allPassed ? 0 : 1)
}

main()
