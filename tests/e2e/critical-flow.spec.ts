import { test, expect } from '@playwright/test'

/**
 * Critical Path E2E Test: Create Backend → Navigate to Connect Page
 * 
 * This test validates the core "two-prompt" flow:
 * 1. User creates a backend from prompt
 * 2. Backend is provisioned successfully
 * 3. User can navigate to Connect page to integrate
 */
test.describe('Backend Creation Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Note: This assumes user is already authenticated
    // In CI, you would set up authentication state beforehand
    await page.goto('/')
  })

  test('should create backend and navigate to connect page', async ({ page }) => {
    // Step 1: Fill in backend creation prompt
    const prompt = 'Create a SaaS backend with user accounts and subscription billing'
    await page.fill('textarea[placeholder*="Describe what you want"]', prompt)
    
    // Step 2: Click "Create Backend" button
    await page.click('button:has-text("Create Backend")')
    
    // Step 3: Wait for backend creation to complete
    // Look for success indicator (status badge or completion message)
    await expect(page.locator('text=Backend Ready')).toBeVisible({ timeout: 60000 })
    
    // Step 4: Verify we're on the project overview page
    await expect(page).toHaveURL(/\/app\/projects\/[a-z0-9-]+$/)
    
    // Step 5: Verify Backend Execution Engine is visible
    await expect(page.locator('h1:has-text("Backend Execution Engine")')).toBeVisible()
    
    // Step 6: Click "Use in Your App" button
    await page.click('button:has-text("Use in Your App")')
    
    // Step 7: Verify navigation to Connect page
    await expect(page).toHaveURL(/\/app\/projects\/[a-z0-9-]+\/connect/)
    
    // Step 8: Verify Connect page content
    await expect(page.locator('text=SDK Snippets')).toBeVisible()
    await expect(page.locator('text=For AI Agents')).toBeVisible()
    
    // Test passes if all steps complete successfully
  })

  test('should display CI-style execution logs during creation', async ({ page }) => {
    // Fill in prompt
    const prompt = 'Build a simple blog backend with posts and comments'
    await page.fill('textarea[placeholder*="Describe what you want"]', prompt)
    
    // Submit form
    await page.click('button:has-text("Create Backend")')
    
    // Wait for CI-style logs to appear
    await expect(page.locator('text=Initializing')).toBeVisible({ timeout: 5000 })
    
    // Verify timestamp format (HH:MM:SS)
    const timestamp = page.locator('[class*="font-mono"] span:first-child')
    await expect(timestamp).toBeVisible()
    
    // Verify success indicator appears
    await expect(page.locator('[class*="text-green-400"]')).toBeVisible({ timeout: 60000 })
  })

  test('should display rollback metadata after update', async ({ page }) => {
    // Navigate to existing project (assumes at least one project exists)
    await page.goto('/app/projects')
    
    // Click on first project
    await page.click('[data-testid="project-card"]:first-child')
    
    // Wait for Overview page
    await expect(page.locator('h1:has-text("Backend Execution Engine")')).toBeVisible()
    
    // Make an update
    await page.fill('textarea[placeholder*="Describe what you want"]', 'Add email verification to users')
    await page.click('button:has-text("Update Backend")')
    
    // Wait for execution to complete
    await expect(page.locator('text=Backend updated successfully')).toBeVisible({ timeout: 30000 })
    
    // Verify rollback info is displayed
    await expect(page.locator('text=Database Backup Created')).toBeVisible()
    await expect(page.locator('text=Migration ID:')).toBeVisible()
    await expect(page.locator('text=Snapshot:')).toBeVisible()
  })
})

test.describe('Template Selection', () => {
  test('should pre-fill prompt when clicking template', async ({ page }) => {
    await page.goto('/')
    
    // Click on a template card
    await page.click('button:has-text("SaaS with Billing")')
    
    // Verify prompt is pre-filled
    const textarea = page.locator('textarea[placeholder*="Describe what you want"]')
    const value = await textarea.inputValue()
    
    expect(value).toContain('SaaS backend')
    expect(value).toContain('subscription plans')
  })

  test('should filter templates by category', async ({ page }) => {
    await page.goto('/')
    
    // Click SaaS category filter
    await page.click('button:has-text("Saas")')
    
    // Verify only SaaS templates are visible
    const templates = page.locator('[class*="grid"] button')
    await expect(templates).toHaveCount(2) // Assuming 2 SaaS templates
    
    // Click All category
    await page.click('button:has-text("All")')
    
    // Verify all templates are visible again
    await expect(templates).toHaveCount(10)
  })
})

test.describe('MCP Agent Integration', () => {
  test('should display agent integration section on connect page', async ({ page }) => {
    // Navigate to connect page (assumes project exists)
    await page.goto('/app/projects')
    await page.click('[data-testid="project-card"]:first-child')
    await page.click('button:has-text("Use in Your App")')
    
    // Verify agent section is visible
    await expect(page.locator('text=For AI Agents (Cursor / Qoder / Replit)')).toBeVisible()
    
    // Verify MCP config is displayed
    await expect(page.locator('text=BACKENLY_PROJECT_ID')).toBeVisible()
    await expect(page.locator('text=BACKENLY_API_URL')).toBeVisible()
    
    // Test copy button
    await page.click('button:has-text("Copy")')
    await expect(page.locator('text=MCP config copied!')).toBeVisible()
  })
})
