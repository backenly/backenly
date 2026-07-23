/**
 * ENGINE MODE CONFIGURATION
 * 
 * Controls execution behavior based on environment:
 * - runtime: Full execution with real database migrations (production/development)
 * - integration: Test-safe mode that skips real DDL and validates execution plans only
 * - simulation: Dry-run mode for preview/testing
 */

export type EngineMode = 'runtime' | 'integration' | 'simulation'

/**
 * Get current engine mode from environment
 */
export function getEngineMode(): EngineMode {
  const mode = process.env.ENGINE_MODE
  
  if (mode === 'integration') {
    return 'integration'
  }
  
  if (mode === 'simulation') {
    return 'simulation'
  }
  
  // Default to runtime mode
  return 'runtime'
}

/**
 * Check if engine is in integration test mode
 */
export function isIntegrationMode(): boolean {
  return getEngineMode() === 'integration'
}

/**
 * Check if engine should execute real database migrations
 */
export function shouldExecuteRealMigrations(): boolean {
  const mode = getEngineMode()
  return mode === 'runtime'
}

/**
 * Check if engine should persist graph changes
 */
export function shouldPersistGraph(): boolean {
  const mode = getEngineMode()
  return mode === 'runtime' || mode === 'integration'
}

/**
 * Get appropriate success message based on mode
 */
export function getModeSpecificMessage(changes: any[], mode: EngineMode = getEngineMode()): string {
  if (mode === 'integration') {
    const tableCount = changes.filter((c: any) => c.type === 'table').length
    const apiCount = changes.filter((c: any) => c.type === 'api').length
    
    const parts: string[] = []
    if (tableCount > 0) {
      parts.push(`Validated ${tableCount} table${tableCount === 1 ? '' : 's'}`)
    }
    if (apiCount > 0) {
      parts.push(`Validated ${apiCount} API${apiCount === 1 ? '' : 's'}`)
    }
    
    return parts.length > 0 
      ? `${parts.join(', ')} (integration mode - no real DDL executed)`
      : 'Execution plan validated (integration mode)'
  }
  
  // Runtime mode - real execution messages
  const tablesCreated = changes.filter((c: any) => c.type === 'table' && c.action === 'created').length
  const apisCreated = changes.filter((c: any) => c.type === 'api' && c.action === 'created').length
  
  const parts: string[] = []
  if (tablesCreated > 0) {
    parts.push(`Created ${tablesCreated} ${tablesCreated === 1 ? 'table' : 'tables'}`)
  }
  if (apisCreated > 0) {
    parts.push(`Generated ${apisCreated} ${apisCreated === 1 ? 'API' : 'APIs'}`)
  }
  
  return parts.length > 0 ? parts.join('. ') + '.' : 'Changes applied.'
}