/**
 * Database Route Monitor
 * 
 * Monitors database API routes and automatically fixes compilation issues
 * Usage: npx tsx scripts/monitor-database-routes.ts
 */

import fs from 'fs'
import path from 'path'

interface RouteHealth {
  route: string
  exists: boolean
  hasValidExport: boolean
  importsValid: boolean
  syntaxValid: boolean
  status: 'HEALTHY' | 'UNHEALTHY' | 'ERROR'
  issues: string[]
}

async function checkRouteFile(filePath: string): Promise<RouteHealth> {
  const issues: string[] = []
  let hasValidExport = false
  let importsValid = true
  let syntaxValid = true

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    
    // Check for valid exports
    if (!content.includes('export async function') && !content.includes('export const')) {
      issues.push('No valid export found')
      hasValidExport = false
    } else {
      hasValidExport = true
    }
    
    // Check for duplicate imports
    const importMatches = content.match(/import\s+{[^}]*}\s+from\s+['"][^'"]+['"]/g) || []
    const importStrings = importMatches.map(imp => imp.trim())
    const uniqueImports = new Set(importStrings)
    if (importStrings.length !== uniqueImports.size) {
      issues.push('Duplicate imports detected')
      importsValid = false
    }
    
    // Check for basic syntax issues
    if (content.includes('export async function') && content.includes('withAuth')) {
      // Check if withAuth is properly imported
      if (!content.includes("from '@/lib/auth/route-protection'") && content.includes('withAuth')) {
        issues.push('withAuth not properly imported')
        importsValid = false
      }
    }
    
    // Check for mismatched braces/parentheses (basic check)
    const openBraces = (content.match(/\{/g) || []).length
    const closeBraces = (content.match(/\}/g) || []).length
    if (openBraces !== closeBraces) {
      issues.push('Mismatched braces')
      syntaxValid = false
    }
    
    const openParens = (content.match(/\(/g) || []).length
    const closeParens = (content.match(/\)/g) || []).length
    if (openParens !== closeParens) {
      issues.push('Mismatched parentheses')
      syntaxValid = false
    }
    
    return {
      route: path.basename(filePath),
      exists: true,
      hasValidExport,
      importsValid,
      syntaxValid,
      status: issues.length === 0 ? 'HEALTHY' : 'UNHEALTHY',
      issues,
    }
  } catch (error: any) {
    return {
      route: path.basename(filePath),
      exists: false,
      hasValidExport: false,
      importsValid: false,
      syntaxValid: false,
      status: 'ERROR',
      issues: [error.message],
    }
  }
}

async function checkDatabaseRoutes() {
  console.log('\n🔍 Database Route Health Check\n')
  console.log('═'.repeat(60))
  
  const dbRoutesPath = path.join(process.cwd(), 'app', 'api', 'database')
  const routeFiles = [
    'schemas/route.ts',
    'tables/route.ts', 
    'rows/route.ts',
    'structure/route.ts',
    'indexes/route.ts',
    'relationships/route.ts',
  ]
  
  const results: RouteHealth[] = []
  
  for (const routeFile of routeFiles) {
    const fullPath = path.join(dbRoutesPath, routeFile)
    const health = await checkRouteFile(fullPath)
    results.push(health)
    
    const statusEmoji = health.status === 'HEALTHY' ? '✅' : 
                      health.status === 'UNHEALTHY' ? '⚠️' : '❌'
    
    console.log(`${statusEmoji} ${health.route}: ${health.status}`)
    
    if (health.issues.length > 0) {
      for (const issue of health.issues) {
        console.log(`   ❌ ${issue}`)
      }
    }
  }
  
  console.log('═'.repeat(60))
  
  const healthyCount = results.filter(r => r.status === 'HEALTHY').length
  const unhealthyCount = results.filter(r => r.status === 'UNHEALTHY').length
  const errorCount = results.filter(r => r.status === 'ERROR').length
  
  console.log(`\n📊 Summary: ${healthyCount} healthy, ${unhealthyCount} unhealthy, ${errorCount} errors\n`)
  
  if (errorCount > 0 || unhealthyCount > 0) {
    console.log('🔧 Recommended fixes:')
    console.log('1. Run: npm run dev (restart server)')
    console.log('2. Check for syntax errors in the problematic files')
    console.log('3. Verify all imports are correct')
    console.log('4. Ensure all exports are properly formatted\n')
  } else {
    console.log('🎉 All database routes are healthy!\n')
  }
  
  return results
}

// Auto-fix common issues
async function fixCommonIssues() {
  console.log('\n🔧 Attempting to fix common issues...\n')
  
  const dbRoutesPath = path.join(process.cwd(), 'app', 'api', 'database', 'schemas', 'route.ts')
  
  try {
    let content = fs.readFileSync(dbRoutesPath, 'utf8')
    
    // Remove duplicate imports
    const lines = content.split('\n')
    const seenImports = new Set<string>()
    const uniqueLines: string[] = []
    
    for (const line of lines) {
      if (line.trim().startsWith('import ')) {
        if (!seenImports.has(line.trim())) {
          seenImports.add(line.trim())
          uniqueLines.push(line)
        }
      } else {
        uniqueLines.push(line)
      }
    }
    
    const newContent = uniqueLines.join('\n')
    if (newContent !== content) {
      fs.writeFileSync(dbRoutesPath, newContent)
      console.log('✅ Fixed duplicate imports in schemas/route.ts')
    } else {
      console.log('✅ No duplicate imports found in schemas/route.ts')
    }
  } catch (error) {
    console.log('⚠️ Could not fix schemas/route.ts:', error)
  }
}

async function runMonitor() {
  await checkDatabaseRoutes()
  await fixCommonIssues()
}

runMonitor().catch(console.error)
