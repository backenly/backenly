import { test, expect } from '@playwright/test'

/**
 * Deployment Flow E2E Tests
 * 
 * Tests the complete deployment flow including:
 * - Go Live functionality
 * - Deployment logs
 * - Health checks
 * - Rollback capability
 */

test.describe('Deployment Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to a project (assumes project exists)
    await page.goto('/app/projects')
    await page.click('[data-testid="project-card"]:first-child')
  })

  test('should deploy backend to production', async ({ page }) => {
    // Navigate to Deploy page
    await page.click('text=Go Live')
    
    // Wait for deploy page to load
    await expect(page.locator('h1:has-text("Go Live")')).toBeVisible()
    
    // Click Go Live button
    await page.click('button:has-text("Go Live")')
    
    // Wait for modal to appear
    await expect(page.locator('h2:has-text("Go Live")')).toBeVisible()
    
    // Verify deployment package summary is shown
    await expect(page.locator('text=Ready to Publish')).toBeVisible({ timeout: 10000 })
    
    // Click Go Live in modal
    await page.click('button:has-text("Go Live"):last-of-type')
    
    // Wait for deployment logs to appear
    await expect(page.locator('text=Deployment Progress')).toBeVisible({ timeout: 5000 })
    
    // Verify deployment steps appear with timestamps
    await expect(page.locator('text=Provisioning production environment')).toBeVisible()
    await expect(page.locator('text=Deploying backend code')).toBeVisible()
    
    // Wait for deployment to complete
    await expect(page.locator('text=Deployment complete')).toBeVisible({ timeout: 60000 })
    
    // Verify health checks appear
    await expect(page.locator('text=Health Status')).toBeVisible()
    
    // Verify button changes to "Deployed"
    await expect(page.locator('button:has-text("Deployed")')).toBeVisible()
  })

  test('should display health check status', async ({ page }) => {
    // Deploy backend first
    await page.click('text=Go Live')
    await page.click('button:has-text("Go Live")')
    await page.click('button:has-text("Go Live"):last-of-type')
    
    // Wait for health checks
    await expect(page.locator('text=Health Status')).toBeVisible({ timeout: 30000 })
    
    // Verify all health check categories are present
    await expect(page.locator('text=API')).toBeVisible()
    await expect(page.locator('text=Database')).toBeVisible()
    await expect(page.locator('text=Auth')).toBeVisible()
    
    // Verify health status indicators (Healthy/Connected/Active)
    const healthyCount = await page.locator('text=Healthy').count()
    const connectedCount = await page.locator('text=Connected').count()
    expect(healthyCount + connectedCount).toBeGreaterThan(0)
  })

  test('should show deployment history', async ({ page }) => {
    // Navigate to deploy page
    await page.click('text=Go Live')
    
    // Verify deployment history section
    await expect(page.locator('h3:has-text("Deployment History")')).toBeVisible()
    
    // Check for either deployments or empty state
    const hasDeployments = await page.locator('[data-testid="deployment-card"]').count() > 0
    const hasEmptyState = await page.locator('text=Not live yet').isVisible()
    
    expect(hasDeployments || hasEmptyState).toBeTruthy()
  })

  test('should display rollback button for live deployments', async ({ page }) => {
    // Navigate to deploy page
    await page.click('text=Go Live')
    
    // Wait for deployments to load
    await page.waitForTimeout(2000)
    
    // Check if there are live deployments
    const liveDeployments = page.locator('[data-testid="deployment-card"]:has-text("live")')
    const count = await liveDeployments.count()
    
    if (count > 0) {
      // Verify rollback button is present
      await expect(liveDeployments.first().locator('button:has-text("Rollback")')).toBeVisible()
    }
  })

  test('should open rollback confirmation modal', async ({ page }) => {
    // Navigate to deploy page
    await page.click('text=Go Live')
    await page.waitForTimeout(2000)
    
    // Find a live deployment
    const liveDeployment = page.locator('[data-testid="deployment-card"]:has-text("live")').first()
    const exists = await liveDeployment.count() > 0
    
    if (exists) {
      // Click rollback button
      await liveDeployment.locator('button:has-text("Rollback")').click()
      
      // Verify modal appears
      await expect(page.locator('h2:has-text("Confirm Rollback")')).toBeVisible()
      
      // Verify warning message
      await expect(page.locator('text=This action cannot be undone')).toBeVisible()
      
      // Verify checkbox requirement
      await expect(page.locator('input[type="checkbox"]')).toBeVisible()
      
      // Cancel rollback
      await page.click('button:has-text("Cancel")')
      
      // Verify modal closes
      await expect(page.locator('h2:has-text("Confirm Rollback")')).not.toBeVisible()
    }
  })
})

test.describe('Deployment Monitoring', () => {
  test('should display CI-style logs with timestamps', async ({ page }) => {
    await page.goto('/app/projects')
    await page.click('[data-testid="project-card"]:first-child')
    await page.click('text=Go Live')
    await page.click('button:has-text("Go Live")')
    await page.click('button:has-text("Go Live"):last-of-type')
    
    // Wait for logs to appear
    await expect(page.locator('text=Deployment Progress')).toBeVisible({ timeout: 5000 })
    
    // Verify timestamp format (HH:MM:SS)
    const timestamp = page.locator('[class*="font-mono"] span:first-child').first()
    await expect(timestamp).toBeVisible()
    
    const timestampText = await timestamp.textContent()
    expect(timestampText).toMatch(/\d{2}:\d{2}:\d{2}/)
  })

  test('should show success indicators for completed steps', async ({ page }) => {
    await page.goto('/app/projects')
    await page.click('[data-testid="project-card"]:first-child')
    await page.click('text=Go Live')
    await page.click('button:has-text("Go Live")')
    await page.click('button:has-text("Go Live"):last-of-type')
    
    // Wait for first step to complete
    await expect(page.locator('text=Environment provisioned')).toBeVisible({ timeout: 10000 })
    
    // Verify green checkmark appears
    const successIcons = page.locator('[class*="text-green-400"]')
    await expect(successIcons.first()).toBeVisible()
  })
})
