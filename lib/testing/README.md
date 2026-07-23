# Intent → Reality Verification System

## Overview

This is **not unit testing**. This is **system integrity testing** that proves Backenly operates as an **intent-driven backend OS**, not a tool.

## Core Principle

**One-way flow only:**

```
User Intent (Plain English)
        ↓
Orchestration Engine
        ↓
Execution Layer
        ↓
Advanced View (Read-only projection)
```

❌ Never the reverse  
❌ Never bidirectional  
❌ Never manual sync

## What This Proves

After all tests pass, you can:

1. **Type only English sentences**
2. **Open Advanced Mode**
3. **Point to any table/API/auth rule** and say: *"This exists because I said this sentence"*
4. **Undo a sentence**
5. **Watch everything disappear cleanly** — including storage
6. **Never see a mismatch**

If that holds, **your system is fundamentally correct.**

## Test Suites

### 1. Intent → Reality Verification

**File:** `lib/testing/intent-reality-verification.ts`

**Purpose:** Verify that Advanced sections are read-only projections of executed intent.

**Parts:**
- **Part 1:** Canonical intent execution test (5 intents)
- **Part 2:** Advanced section projection verification (tables, APIs, auth, storage, monitoring)
- **Part 3:** Reverse integrity check (read-only enforcement)
- **Part 4:** Intent drift detection (unexplained state)
- **Part 5:** Undo/rollback verification (state restoration)
- **Part 6:** Deployment consistency test (no hidden state)

**API Endpoint:** `POST /api/verification/intent-reality`

**Usage:**
```typescript
import { runCompleteVerification } from '@/lib/testing/intent-reality-verification'

const report = await runCompleteVerification(projectId, userId)
console.log(report.overallPass) // true if system is correct
```

### 2. Red Flag Detection

**File:** `lib/testing/red-flag-detection.ts`

**Purpose:** Continuous monitoring for system integrity violations.

**Red Flags (System is broken if any detected):**
1. Advanced Mode shows something user didn't describe
2. Storage exists without user-facing behavior
3. APIs exist without intent explanation
4. Undo removes logic but leaves artifacts
5. Deployment succeeds with drift

**Usage:**
```typescript
import { scanForRedFlags } from '@/lib/testing/red-flag-detection'

const report = await scanForRedFlags(context)
if (!report.systemHealthy) {
  console.error('🚨 RED FLAGS DETECTED')
}
```

### 3. Multi-Tenant Safety Tests

**File:** `lib/testing/multi-tenant-safety-tests.ts`

**Purpose:** Verify cross-project operations fail safely.

**Tests:**
- Token from Project A rejected in Project B
- Storage access blocked across projects
- Database queries isolated by RLS
- Rollback scoped to single project
- Intent history isolated per project

**Usage:**
```typescript
import { runSafetyTests } from '@/lib/testing/multi-tenant-safety-tests'

const results = await runSafetyTests()
// All tests must fail (cross-project access blocked)
```

### 4. Deployment Guard

**File:** `lib/testing/deployment-guard.ts`

**Purpose:** Block deployment if system integrity is compromised.

**Checks:**
- Red flag scan
- Intent-reality verification
- Intent history exists
- Rollback points available

**Usage:**
```typescript
import { canDeploy } from '@/lib/testing/deployment-guard'

const result = await canDeploy(context)
if (!result.allowed) {
  console.error('⛔ Deployment blocked:', result.blockedBy)
}
```

**Integrated into:** `lib/deployment/project-scoped-deployment.ts` — `deployProject()` function automatically runs guard before deploying.

### 5. Intent Lineage Hash (Optional Hardening)

**File:** `lib/testing/intent-lineage-hash.ts`

**Purpose:** Cryptographically provable drift detection.

**Features:**
- Hash each executed intent (SHA-256)
- Store hash on all derived artifacts
- Verify intent chain integrity
- Detect tampering cryptographically

**API Endpoint:** `POST /api/testing/lineage-proof`

**Usage:**
```typescript
import { verifyIntentChain, generateLineageProof } from '@/lib/testing/intent-lineage-hash'

// Verify chain integrity
const chainCheck = await verifyIntentChain(context)
if (!chainCheck.valid) {
  console.error('Intent chain broken at:', chainCheck.brokenAt)
}

// Generate cryptographic proof
const proof = await generateLineageProof(context)
console.log(proof)
```

### 6. Time-Travel Diff Viewer (Optional Hardening)

**File:** `lib/testing/time-travel-diff-viewer.ts`

**Purpose:** Trace any artifact back to its originating intent.

**Features:**
- "This table exists because of Intent #4"
- View system state at any intent
- Generate diffs between intent states
- Full intent timeline with state evolution

**API Endpoint:** `POST /api/testing/time-travel`

**Usage:**
```typescript
import { explainArtifact, generateIntentTimeline } from '@/lib/testing/time-travel-diff-viewer'

// Explain artifact origin
const explanation = await explainArtifact(context, 'table', 'users')
console.log(explanation)
// Output: "This table 'users' was created by intent #2: 'Users should be able to sign up...'"

// Generate full timeline
const timeline = await generateIntentTimeline(context)
console.log(timeline)
```

**API Actions:**
- `explain` - Trace artifact to origin intent
- `timeline` - Full intent timeline
- `diff` - Diff between two intent states
- `state` - Get state at specific intent
- `query` - Interactive time-travel query

## Comprehensive Test Runner

**File:** `lib/testing/comprehensive-test-runner.ts`

**Purpose:** Execute all test suites and produce certification.

**API Endpoint:** `POST /api/testing/comprehensive`

**Usage:**
```typescript
import { runAllTests, exportVerificationCertificate } from '@/lib/testing/comprehensive-test-runner'

const report = await runAllTests(projectId, userId)
const certificate = exportVerificationCertificate(report)

console.log(certificate)
```

**Certificate includes:**
- Intent → Reality consistency: PASS/FAIL
- No unexplained state: PASS/FAIL
- Multi-tenant isolation: PASS/FAIL
- Deployment readiness: READY/BLOCKED

## Running Tests

### Option 1: API Endpoint

```bash
curl -X POST http://localhost:3000/api/testing/comprehensive \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId": "your-project-id"}'
```

### Option 2: Programmatically

```typescript
import { runAllTests } from '@/lib/testing/comprehensive-test-runner'

const report = await runAllTests('project-id', 'user-id')

if (report.overallHealthy && report.readyToDeploy) {
  console.log('✅ System verified - ready to deploy')
} else {
  console.error('❌ System integrity compromised')
}
```

### Option 3: Quick Health Check

```typescript
import { quickHealthCheck } from '@/lib/testing/comprehensive-test-runner'

const { healthy, issues } = await quickHealthCheck(projectId, userId)
if (!healthy) {
  console.error('Issues:', issues)
}
```

## Deployment Flow

When you call `deployProject()`:

1. **Deployment guard runs automatically**
2. **Red flag scan executes**
3. **Intent-reality verification runs**
4. **If any check fails → deployment blocked**
5. **If all pass → deployment proceeds**

```typescript
import { deployProject } from '@/lib/deployment/project-scoped-deployment'

try {
  const deployment = await deployProject(context, deploymentId)
  console.log('Deployed to:', deployment.url)
} catch (error) {
  if (error.code === 'DEPLOYMENT_BLOCKED') {
    console.error('Deployment blocked:', error.message)
    // Fix issues and try again
  }
}
```

## Success Criteria

**System is fundamentally correct if:**

✅ All state is derived from user intent (English sentences)  
✅ Advanced sections are read-only projections  
✅ No hidden state or manual overrides exist  
✅ Rollback restores all derived state consistently  
✅ Multi-tenant isolation prevents cross-project access  
✅ Deployment reflects verified, drift-free state

**If ANY of these fail → system is broken.**

## One-Line Rule

> **If a request can affect more than one project, the system is broken.**

This verification system ensures that rule holds mathematically.

## Files Created

### Core Testing
- `lib/testing/intent-reality-verification.ts` - Main verification system
- `lib/testing/red-flag-detection.ts` - Continuous integrity monitoring
- `lib/testing/multi-tenant-safety-tests.ts` - Cross-project isolation tests
- `lib/testing/deployment-guard.ts` - Pre-deployment verification
- `lib/testing/comprehensive-test-runner.ts` - Full test suite runner

### API Endpoints
- `app/api/verification/intent-reality/route.ts` - Intent verification endpoint
- `app/api/testing/comprehensive/route.ts` - Full test suite endpoint

### Integration
- `lib/deployment/project-scoped-deployment.ts` - Updated with deployment guard

## Final Truth

**If this test passes, then:**

- Backenly is not a BaaS
- It is an **intent-driven backend OS**
- And the **sentence box truly owns reality**

---

*System integrity is not negotiable.*
