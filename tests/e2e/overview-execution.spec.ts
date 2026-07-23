import { test, expect } from '@playwright/test'

/**
 * Overview Page Execution Tests
 * 
 * Tests the Backend Execution Engine including:
 * - AI prompt execution
 * - Execution logs
 * - Rollback metadata
 * - Recent actions log
 */

test.describe('Backend Execution Engine', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app/projects')
    await page.click('[data-testid="project-card"]:first-child')
  })

  test('should execute backend update with CI-style logs', async ({ page }) => {
    // Verify Backend Execution Engine header
    await expect(page.locator('h1:has-text("Backend Execution Engine")')).toBeVisible()
    
    // Fill in update prompt
    await page.fill('textarea[placeholder*="Describe what you want"]', 'Add email verification to user accounts')
    
    // Click Update Backend button
    await page.click('button:has-text("Update Backend")')
    
    // Verify execution timeline appears
    await expect(page.locator('text=Analyzing request')).toBeVisible({ timeout: 5000 })
    
    // Wait for execution to complete
    await expect(page.locator('text=Backend updated successfully')).toBeVisible({ timeout: 30000 })
    
    // Verify rollback metadata is displayed
    await expect(page.locator('text=Database Backup Created')).toBeVisible()
    await expect(page.locator('text=Migration ID:')).toBeVisible()
    await expect(page.locator('text=Snapshot:')).toBeVisible()
  })

  test('should display recent AI actions log', async ({ page }) => {
    // Make an update
    await page.fill('textarea[placeholder*="Describe what you want"]', 'Add product reviews feature')
    await page.click('button:has-text("Update Backend")')
    
    // Wait for completion
    await expect(page.locator('text=Backend updated successfully')).toBeVisible({ timeout: 30000 })
    
    // Verify action appears in execution log
    await expect(page.locator('text=Execution Log')).toBeVisible()
    await expect(page.locator('text=Add product reviews feature')).toBeVisible()
  })

  test('should persist actions in localStorage', async ({ page }) => {
    // Make an update
    const testPrompt = 'Add advanced search filters'
    await page.fill('textarea[placeholder*="Describe what you want"]', testPrompt)
    await page.click('button:has-text("Update Backend")')
    await page.waitForTimeout(5000)
    
    // Reload page
    await page.reload()
    
    // Verify action persists
    await expect(page.locator(`text=${testPrompt}`)).toBeVisible()
  })

  test('should show execution steps with timestamps', async ({ page }) => {
    await page.fill('textarea[placeholder*="Describe what you want"]', 'Enable real-time notifications')
    await page.click('button:has-text("Update Backend")')
    
    // Wait for timeline
    await page.waitForTimeout(2000)
    
    // Verify timestamp format appears
    const timestamps = page.locator('[class*="font-mono"] span').first()
    await expect(timestamps).toBeVisible()
  })

  test('should display backend status checklist', async ({ page }) => {
    // Verify status items are visible
    await expect(page.locator('text=Backend Status')).toBeVisible()
    await expect(page.locator('text=APIs')).toBeVisible()
    await expect(page.locator('text=Data')).toBeVisible()
    await expect(page.locator('text=Auth')).toBeVisible()
    await expect(page.locator('text=Storage')).toBeVisible()
    
    // Verify all show "Ready" or similar status
    const readyStatuses = page.locator('text=Ready, text=Managed, text=Enabled, text=Configured')
    await expect(readyStatuses.first()).toBeVisible()
  })
})

test.describe('Quick Actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app/projects')
    await page.click('[data-testid="project-card"]:first-child')
  })

  test('should navigate to Use in Your App', async ({ page }) => {
    await page.click('button:has-text("Use in Your App")')
    
    // Verify navigation
    await expect(page).toHaveURL(/\/connect/)
    await expect(page.locator('text=SDK Snippets')).toBeVisible()
  })

  test('should navigate to Go Live', async ({ page }) => {
    await page.click('button:has-text("Go Live")')
    
    // Verify navigation
    await expect(page).toHaveURL(/\/deploy/)
    await expect(page.locator('h1:has-text("Go Live")')).toBeVisible()
  })
})
