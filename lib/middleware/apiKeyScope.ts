/**
 * API Key Route Scoping Middleware
 * 
 * SECURITY: Public API keys can ONLY access specific routes (auth endpoints).
 * This prevents accidental exposure of sensitive endpoints.
 *
 * Public/anon keys are scoped strictly — this is the standard BaaS posture.
 */

export interface ApiKeyInfo {
  type: 'public' | 'secret';
  projectId: string;
  permissions?: string[];
}

/**
 * Routes that public API keys are allowed to access
 */
const PUBLIC_KEY_ALLOWLIST = [
  '/auth/register',
  '/auth/login',
  '/auth/refresh', // If you add refresh token support
  // Future: Add other read-only endpoints here
];

/**
 * Check if a route is allowed for a public API key
 */
export function isRouteAllowedForPublicKey(apiPath: string): boolean {
  // Normalize path (remove query params, trailing slash)
  const normalizedPath = apiPath.split('?')[0].replace(/\/$/, '');
  
  return PUBLIC_KEY_ALLOWLIST.some(allowed => 
    normalizedPath === allowed || normalizedPath.startsWith(allowed + '/')
  );
}

/**
 * Validate API key has permission to access a route
 * 
 * @throws Error if permission denied
 */
export function validateApiKeyScope(apiKey: ApiKeyInfo, apiPath: string): void {
  // Secret keys have full access
  if (apiKey.type === 'secret') {
    return;
  }
  
  // Public keys have restricted access
  if (apiKey.type === 'public') {
    if (!isRouteAllowedForPublicKey(apiPath)) {
      throw new Error(
        `Public API key cannot access '${apiPath}'. ` +
        `Allowed routes: ${PUBLIC_KEY_ALLOWLIST.join(', ')}. ` +
        `Use a secret API key for other endpoints.`
      );
    }
  }
}

/**
 * Get API key type from key string
 */
export function getApiKeyType(apiKey: string): 'public' | 'secret' | null {
  if (apiKey.startsWith('bk_public_')) {
    return 'public';
  }
  if (apiKey.startsWith('bk_secret_')) {
    return 'secret';
  }
  return null;
}
