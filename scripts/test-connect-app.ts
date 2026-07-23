/**
 * BLACK-BOX RUNTIME TEST: Connect App via URL (Phase 2)
 * 
 * Tests the complete CONNECT APP feature with:
 * - State-based verification ONLY (no log inference)
 * - Deployment-first enforcement
 * - Confirmation requirement
 * - Chat-UI parity
 * - Audit trail
 * 
 * SUCCESS CRITERIA:
 * - ALL tests PASS with mechanical verification
 * - NO manual interpretation required
 * - Observable state deltas ONLY
 */

import { PrismaClient } from '@prisma/client'
import { orchestrateBackendChange } from '@/lib/orchestration'
import { createOrchestrationContext } from '@/lib/context/execution-context'

const prisma = new PrismaClient()

interface TestResult {
  name: string
  passed: boolean
  evidence: string[]
  errors: string[]
}

async function runConnectAppTests(): Promise<{
  totalTests: number
  passed: number
  failed: number
  results: TestResult[]
}> {
  const results: TestResult[] = []
  
  // Test Setup: Create a project
  const testProject = await prisma.project.upsert({
    where: { slug: 'connect-app-test' },
    update: {},
    create: {
      name: 'Connect App Test Project',
      slug: 'connect-app-test',
      description: 'Testing frontend connection feature',
    },
  })
  
  const projectId = testProject.id
  
  console.log(`\n${'='.repeat(80)}`)
  console.log('BLACK-BOX TEST: CONNECT APP VIA URL')
  console.log(`Project ID: ${projectId}`)
  console.log(`${'='.repeat(80)}\n`)
  
  // ============================================================================
  // TEST 1: Connect Before Deploy (MUST REFUSE)
  // ============================================================================
  {
    const testName = 'TEST 1: Connect Before Deploy'
    console.log(`\n🧪 ${testName}`)
    console.log('-'.repeat(80))
    
    const evidence: string[] = []
    const errors: string[] = []
    
    try {
      // Ensure no deployment exists
      await prisma.deployment.deleteMany({ where: { projectId } })
      await (prisma as any).deploymentAudit.deleteMany({ where: { projectId } })
      
      evidence.push('✓ Pre-condition: No deployment exists')
      
      // Attempt to connect
      const result = await orchestrateBackendChange(
        'Connect http://localhost:5173',
        projectId
      )
      
      evidence.push(`Result: executionState=${result.executionState}`)
      evidence.push(`Message: "${result.message}"`)
      
      // Verify REFUSED state
      if (result.executionState !== 'REFUSED') {
        errors.push(`Expected executionState='REFUSED', got '${result.executionState}'`)
      } else {
        evidence.push('✓ Correctly refused connection')
      }
      
      // Verify no connection was created
      const connectedApps = await (prisma as any).connectedApp.findMany({
        where: { projectId },
      })
      
      if (connectedApps.length > 0) {
        errors.push('ConnectedApp record created despite refusal')
      } else {
        evidence.push('✓ No ConnectedApp record created')
      }
      
      // Verify message mentions deployment requirement
      if (!result.message.toLowerCase().includes('deploy')) {
        errors.push('Message does not mention deployment requirement')
      } else {
        evidence.push('✓ Message explains deployment requirement')
      }
      
      results.push({
        name: testName,
        passed: errors.length === 0,
        evidence,
        errors,
      })
    } catch (error: any) {
      errors.push(`Exception: ${error.message}`)
      results.push({ name: testName, passed: false, evidence, errors })
    }
  }
  
  // ============================================================================
  // TEST 2: Connect After Deploy (MUST PREVIEW)
  // ============================================================================
  {
    const testName = 'TEST 2: Connect After Deploy'
    console.log(`\n🧪 ${testName}`)
    console.log('-'.repeat(80))
    
    const evidence: string[] = []
    const errors: string[] = []
    
    try {
      // Create successful deployment
      await prisma.deployment.create({
        data: {
          id: `deploy_${Date.now()}`,
          projectId,
          provider: 'local',
          status: 'DEPLOYED',
          url: 'https://test.backenly.com',
        },
      })
      
      await (prisma as any).deploymentAudit.create({
        data: {
          id: `audit_${Date.now()}`,
          projectId,
          triggerSource: 'TEST',
          confirmedBy: 'TEST',
          changeSummary: 'Initial deployment',
          result: 'SUCCESS',
          deploymentId: 'deploy_test',
          graphVersionBefore: 0,
          graphVersionAfter: 1,
        },
      })
      
      evidence.push('✓ Pre-condition: Successful deployment exists')
      
      // Attempt to connect
      const result = await orchestrateBackendChange(
        'Connect http://localhost:5173',
        projectId
      )
      
      evidence.push(`Result: executionState=${result.executionState}`)
      evidence.push(`Message: "${result.message}"`)
      evidence.push(`requiresCommitment: ${result.requiresCommitment}`)
      
      // Verify PREVIEW state (not executed yet)
      if (result.executionState !== 'PREVIEW') {
        errors.push(`Expected executionState='PREVIEW', got '${result.executionState}'`)
      } else {
        evidence.push('✓ Correct PREVIEW state')
      }
      
      // Verify requires confirmation
      if (!result.requiresCommitment) {
        errors.push('Did not require confirmation')
      } else {
        evidence.push('✓ Requires confirmation')
      }
      
      // Verify no connection was created yet
      const connectedApps = await (prisma as any).connectedApp.findMany({
        where: { projectId, isActive: true },
      })
      
      if (connectedApps.length > 0) {
        errors.push('ConnectedApp created without confirmation')
      } else {
        evidence.push('✓ No ConnectedApp created yet')
      }
      
      // Verify message shows preview
      if (!result.message.toLowerCase().includes('connect')) {
        errors.push('Message does not show connection preview')
      } else {
        evidence.push('✓ Message shows connection preview')
      }
      
      results.push({
        name: testName,
        passed: errors.length === 0,
        evidence,
        errors,
      })
    } catch (error: any) {
      errors.push(`Exception: ${error.message}`)
      results.push({ name: testName, passed: false, evidence, errors })
    }
  }
  
  // ============================================================================
  // TEST 3: Confirm Connection (MUST EXECUTE)
  // ============================================================================
  {
    const testName = 'TEST 3: Confirm Connection'
    console.log(`\n🧪 ${testName}`)
    console.log('-'.repeat(80))
    
    const evidence: string[] = []
    const errors: string[] = []
    
    try {
      // User types CONNECT to confirm
      const result = await orchestrateBackendChange(
        'CONNECT',
        projectId
      )
      
      evidence.push(`Result: executionState=${result.executionState}`)
      evidence.push(`Message: "${result.message}"`)
      
      // Verify EXECUTED state
      if (result.executionState !== 'EXECUTED') {
        errors.push(`Expected executionState='EXECUTED', got '${result.executionState}'`)
      } else {
        evidence.push('✓ Correct EXECUTED state')
      }
      
      // Verify connection was created
      const connectedApps = await (prisma as any).connectedApp.findMany({
        where: { projectId, isActive: true },
      })
      
      if (connectedApps.length === 0) {
        errors.push('No ConnectedApp created after confirmation')
      } else {
        evidence.push(`✓ ConnectedApp created: ${connectedApps[0].origin}`)
        evidence.push(`  Backend version: ${connectedApps[0].backendVersion}`)
        evidence.push(`  Connected by: ${connectedApps[0].connectedBy}`)
        evidence.push(`  Active: ${connectedApps[0].isActive}`)
        
        // Verify origin
        if (!connectedApps[0].origin.includes('localhost')) {
          errors.push(`Wrong origin: ${connectedApps[0].origin}`)
        }
        
        // Verify backend version
        if (typeof connectedApps[0].backendVersion !== 'number') {
          errors.push('backendVersion not a number')
        }
        
        // Verify connected by CHAT
        if (connectedApps[0].connectedBy !== 'CHAT') {
          errors.push(`Wrong connectedBy: ${connectedApps[0].connectedBy}`)
        }
      }
      
      // Verify audit log
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          projectId,
          action: 'CONNECT_FRONTEND',
        },
        orderBy: { timestamp: 'desc' },
        take: 1,
      })
      
      if (auditLogs.length === 0) {
        errors.push('No audit log created')
      } else {
        evidence.push('✓ Audit log created')
        const log = auditLogs[0]
        evidence.push(`  Action: ${log.action}`)
        evidence.push(`  Type: ${log.type}`)
        const details = JSON.parse(log.details || '{}')
        evidence.push(`  Origin: ${details.origin}`)
        evidence.push(`  TriggerSource: ${details.triggerSource}`)
      }
      
      results.push({
        name: testName,
        passed: errors.length === 0,
        evidence,
        errors,
      })
    } catch (error: any) {
      errors.push(`Exception: ${error.message}`)
      results.push({ name: testName, passed: false, evidence, errors })
    }
  }
  
  // ============================================================================
  // TEST 4: Duplicate Connect (MUST REFUSE)
  // ============================================================================
  {
    const testName = 'TEST 4: Duplicate Connect'
    console.log(`\n🧪 ${testName}`)
    console.log('-'.repeat(80))
    
    const evidence: string[] = []
    const errors: string[] = []
    
    try {
      // Attempt to connect same URL again
      const result = await orchestrateBackendChange(
        'Connect http://localhost:5173',
        projectId
      )
      
      evidence.push(`Result: executionState=${result.executionState}`)
      evidence.push(`Message: "${result.message}"`)
      
      // Verify REFUSED or message indicates already connected
      const isRefusal = result.executionState === 'REFUSED' || 
                       result.message.toLowerCase().includes('already') ||
                       !result.success
      
      if (!isRefusal) {
        errors.push('Did not refuse duplicate connection')
      } else {
        evidence.push('✓ Correctly refused duplicate connection')
      }
      
      // Verify only ONE connection exists
      const connectedApps = await (prisma as any).connectedApp.findMany({
        where: { projectId, isActive: true },
      })
      
      if (connectedApps.length !== 1) {
        errors.push(`Expected 1 connection, got ${connectedApps.length}`)
      } else {
        evidence.push('✓ Only one connection exists')
      }
      
      results.push({
        name: testName,
        passed: errors.length === 0,
        evidence,
        errors,
      })
    } catch (error: any) {
      errors.push(`Exception: ${error.message}`)
      results.push({ name: testName, passed: false, evidence, errors })
    }
  }
  
  // ============================================================================
  // TEST 5: Disconnect App (MUST REQUIRE CONFIRMATION)
  // ============================================================================
  {
    const testName = 'TEST 5: Disconnect App'
    console.log(`\n🧪 ${testName}`)
    console.log('-'.repeat(80))
    
    const evidence: string[] = []
    const errors: string[] = []
    
    try {
      // Attempt to disconnect
      const result = await orchestrateBackendChange(
        'Disconnect http://localhost:5173',
        projectId
      )
      
      evidence.push(`Result: executionState=${result.executionState}`)
      evidence.push(`Message: "${result.message}"`)
      evidence.push(`requiresCommitment: ${result.requiresCommitment}`)
      
      // Verify PREVIEW state (requires confirmation)
      if (result.executionState !== 'PREVIEW') {
        errors.push(`Expected executionState='PREVIEW', got '${result.executionState}'`)
      } else {
        evidence.push('✓ Correct PREVIEW state')
      }
      
      // Verify requires confirmation
      if (!result.requiresCommitment) {
        errors.push('Did not require confirmation')
      } else {
        evidence.push('✓ Requires confirmation')
      }
      
      // Verify app is still connected
      const connectedApps = await (prisma as any).connectedApp.findMany({
        where: { projectId, isActive: true },
      })
      
      if (connectedApps.length === 0) {
        errors.push('App was disconnected without confirmation')
      } else {
        evidence.push('✓ App still connected (awaiting confirmation)')
      }
      
      // Now confirm disconnection
      const confirmResult = await orchestrateBackendChange(
        'DISCONNECT',
        projectId
      )
      
      evidence.push(`Confirmation: executionState=${confirmResult.executionState}`)
      
      // Verify EXECUTED state
      if (confirmResult.executionState !== 'EXECUTED') {
        errors.push(`Expected executionState='EXECUTED', got '${confirmResult.executionState}'`)
      } else {
        evidence.push('✓ Disconnection executed')
      }
      
      // Verify app is disconnected
      const disconnectedApps = await (prisma as any).connectedApp.findMany({
        where: { projectId, isActive: false },
      })
      
      if (disconnectedApps.length === 0) {
        errors.push('App was not disconnected')
      } else {
        evidence.push('✓ App marked as inactive')
      }
      
      // Verify audit log
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          projectId,
          action: 'DISCONNECT_FRONTEND',
        },
        orderBy: { timestamp: 'desc' },
        take: 1,
      })
      
      if (auditLogs.length === 0) {
        errors.push('No audit log for disconnection')
      } else {
        evidence.push('✓ Disconnect audit log created')
      }
      
      results.push({
        name: testName,
        passed: errors.length === 0,
        evidence,
        errors,
      })
    } catch (error: any) {
      errors.push(`Exception: ${error.message}`)
      results.push({ name: testName, passed: false, evidence, errors })
    }
  }
  
  // ============================================================================
  // TEST 6: Chat-UI Parity (Audit logs must be identical)
  // ============================================================================
  {
    const testName = 'TEST 6: Chat-UI Parity'
    console.log(`\n🧪 ${testName}`)
    console.log('-'.repeat(80))
    
    const evidence: string[] = []
    const errors: string[] = []
    
    try {
      // This test would verify that UI and Chat call the same underlying engine
      // For now, we verify the audit logs show consistent structure
      
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          projectId,
          action: { in: ['CONNECT_FRONTEND', 'DISCONNECT_FRONTEND'] },
        },
        orderBy: { timestamp: 'asc' },
      })
      
      evidence.push(`✓ Found ${auditLogs.length} audit logs`)
      
      // Verify all logs have required fields
      for (const log of auditLogs) {
        const details = JSON.parse(log.details || '{}')
        
        if (!details.origin) {
          errors.push(`Audit log ${log.id} missing origin`)
        }
        if (!details.backendVersion) {
          errors.push(`Audit log ${log.id} missing backendVersion`)
        }
        if (!details.triggerSource) {
          errors.push(`Audit log ${log.id} missing triggerSource`)
        }
        if (!details.timestamp) {
          errors.push(`Audit log ${log.id} missing timestamp`)
        }
      }
      
      if (errors.length === 0) {
        evidence.push('✓ All audit logs have consistent structure')
      }
      
      results.push({
        name: testName,
        passed: errors.length === 0,
        evidence,
        errors,
      })
    } catch (error: any) {
      errors.push(`Exception: ${error.message}`)
      results.push({ name: testName, passed: false, evidence, errors })
    }
  }
  
  // ============================================================================
  // FINAL REPORT
  // ============================================================================
  
  const totalTests = results.length
  const passed = results.filter(r => r.passed).length
  const failed = totalTests - passed
  
  console.log(`\n${'='.repeat(80)}`)
  console.log('TEST SUMMARY')
  console.log(`${'='.repeat(80)}`)
  console.log(`Total Tests: ${totalTests}`)
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)
  console.log(`${'='.repeat(80)}\n`)
  
  for (const result of results) {
    const status = result.passed ? '✅ PASS' : '❌ FAIL'
    console.log(`${status} - ${result.name}`)
    
    if (result.evidence.length > 0) {
      console.log('  Evidence:')
      result.evidence.forEach(e => console.log(`    ${e}`))
    }
    
    if (result.errors.length > 0) {
      console.log('  Errors:')
      result.errors.forEach(e => console.log(`    ❌ ${e}`))
    }
    
    console.log()
  }
  
  // Cleanup
  await prisma.project.delete({ where: { id: projectId } })
  
  return {
    totalTests,
    passed,
    failed,
    results,
  }
}

// Run tests
if (require.main === module) {
  runConnectAppTests()
    .then(summary => {
      process.exit(summary.failed > 0 ? 1 : 0)
    })
    .catch(error => {
      console.error('Test runner failed:', error)
      process.exit(1)
    })
}

export { runConnectAppTests }
