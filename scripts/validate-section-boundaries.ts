/**
 * SECTION BOUNDARY VALIDATION SCRIPT
 * ===================================
 * 
 * This script checks that no section violates the Golden Rule:
 * "Only Database Management can create backend reality"
 * 
 * Run: npx tsx scripts/validate-section-boundaries.ts
 */

import * as fs from 'fs'
import * as path from 'path'

const VIOLATIONS = {
  API_BUILDER_CREATES_APIS: /createApiDefinition|prisma\.apiDefinition\.create/,
  API_BUILDER_CREATES_TABLES: /CREATE\s+TABLE|createTable|prisma\.table\.create/,
  CONNECT_CREATES_APIS: /createApiDefinition|prisma\.apiDefinition\.create/,
  DEPLOY_CREATES_APIS: /createApiDefinition|generateApi/,
  MONITORING_MODIFIES: /prisma\.(table|apiDefinition)\.(create|update|delete)/,
}

interface Violation {
  file: string
  line: number
  pattern: string
  content: string
}

const violations: Violation[] = []

function checkFile(filePath: string, section: string) {
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  
  lines.forEach((line, index) => {
    // Skip comments
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
      return
    }
    
    // Check for violations based on section
    if (section === 'api-builder') {
      if (VIOLATIONS.API_BUILDER_CREATES_APIS.test(line)) {
        violations.push({
          file: filePath,
          line: index + 1,
          pattern: 'Creates API Definition',
          content: line.trim(),
        })
      }
      if (VIOLATIONS.API_BUILDER_CREATES_TABLES.test(line)) {
        violations.push({
          file: filePath,
          line: index + 1,
          pattern: 'Creates Table',
          content: line.trim(),
        })
      }
    }
    
    if (section === 'connect') {
      if (VIOLATIONS.CONNECT_CREATES_APIS.test(line)) {
        violations.push({
          file: filePath,
          line: index + 1,
          pattern: 'Creates API',
          content: line.trim(),
        })
      }
    }
    
    if (section === 'deploy') {
      if (VIOLATIONS.DEPLOY_CREATES_APIS.test(line)) {
        violations.push({
          file: filePath,
          line: index + 1,
          pattern: 'Creates/Generates API',
          content: line.trim(),
        })
      }
    }
    
    if (section === 'monitoring') {
      if (VIOLATIONS.MONITORING_MODIFIES.test(line)) {
        violations.push({
          file: filePath,
          line: index + 1,
          pattern: 'Modifies Backend',
          content: line.trim(),
        })
      }
    }
  })
}

function scanDirectory(dir: string, section: string) {
  const files = fs.readdirSync(dir, { withFileTypes: true })
  
  for (const file of files) {
    const filePath = path.join(dir, file.name)
    
    if (file.isDirectory()) {
      scanDirectory(filePath, section)
    } else if (file.name.endsWith('.tsx') || file.name.endsWith('.ts')) {
      checkFile(filePath, section)
    }
  }
}

console.log('🔍 Scanning for Section Boundary Violations...\n')

// Scan each section
const sections = [
  { path: 'app/app/api-builder', name: 'api-builder' },
  { path: 'app/app/connect', name: 'connect' },
  { path: 'app/app/deploy', name: 'deploy' },
  { path: 'app/app/monitoring', name: 'monitoring' },
]

for (const section of sections) {
  const fullPath = path.join(process.cwd(), section.path)
  if (fs.existsSync(fullPath)) {
    console.log(`Checking ${section.name}...`)
    scanDirectory(fullPath, section.name)
  }
}

console.log('\n📊 RESULTS:\n')

if (violations.length === 0) {
  console.log('✅ NO VIOLATIONS FOUND!')
  console.log('\nAll sections respect the Golden Rule:')
  console.log('"Only Database Management can create backend reality"\n')
} else {
  console.log(`❌ Found ${violations.length} violation(s):\n`)
  
  violations.forEach((v, i) => {
    console.log(`${i + 1}. ${v.file}:${v.line}`)
    console.log(`   Pattern: ${v.pattern}`)
    console.log(`   Code: ${v.content}`)
    console.log()
  })
  
  process.exit(1)
}

console.log('🎯 Section Positioning Verified!')
console.log('Intent → Confirm → Real Backend → Manage Reality\n')
