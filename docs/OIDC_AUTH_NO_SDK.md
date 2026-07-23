# OIDC-Compliant Auth (No SDK Required)

## Philosophy

Backenly uses **standards-based OIDC/OAuth2** for frontend authentication. No SDK required—just standard HTTP requests following RFC 6749 and OpenID Connect Core 1.0.

**Audit-compliant, zero magic, pure standards.**

---

## How It Works

### 1. Authorization (Redirect Flow)

Frontend redirects user to Backenly authorization endpoint:

```javascript
// Step 1: Generate PKCE code verifier (recommended for security)
function generateCodeVerifier() {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function generateCodeChallenge(verifier) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    .then(hash => {
      return btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
    })
}

// Step 2: Initiate authorization
async function connectToBackendly(projectId) {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  
  // Store verifier for token exchange
  sessionStorage.setItem('pkce_verifier', codeVerifier)
  
  // Build authorization URL (RFC 6749 Section 4.1.1)
  const authUrl = new URL('https://backenly.app/api/oidc/authorize')
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', 'your-app-name')  // replit, lovable, etc.
  authUrl.searchParams.set('project_id', projectId)
  authUrl.searchParams.set('scope', 'read:schema read:endpoints call:apis')
  authUrl.searchParams.set('redirect_uri', window.location.origin + '/callback')
  authUrl.searchParams.set('state', crypto.randomUUID())  // CSRF protection
  authUrl.searchParams.set('code_challenge', codeChallenge)  // PKCE
  authUrl.searchParams.set('code_challenge_method', 'S256')
  
  // Redirect to authorization endpoint
  window.location.href = authUrl.toString()
}
```

### 2. Handle Callback (Exchange Code for Token)

After user approves, Backenly redirects back with authorization code:

```javascript
// Step 3: Handle callback and exchange code for token
async function handleCallback() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const state = params.get('state')
  
  if (!code) {
    throw new Error('No authorization code received')
  }
  
  // Retrieve PKCE verifier
  const codeVerifier = sessionStorage.getItem('pkce_verifier')
  sessionStorage.removeItem('pkce_verifier')
  
  // Exchange code for access token (RFC 6749 Section 4.1.3)
  const response = await fetch('https://backenly.app/api/oidc/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: window.location.origin + '/callback',
      client_id: 'your-app-name',
      code_verifier: codeVerifier,  // PKCE
    }),
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(`Token exchange failed: ${error.error_description}`)
  }
  
  // Parse token response (RFC 6749 Section 5.1)
  const tokens = await response.json()
  // {
  //   access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  //   token_type: "Bearer",
  //   expires_in: 3600,
  //   scope: "read:schema read:endpoints call:apis"
  // }
  
  // Store token securely
  sessionStorage.setItem('backenly_token', tokens.access_token)
  sessionStorage.setItem('backenly_expires', Date.now() + tokens.expires_in * 1000)
  
  return tokens.access_token
}
```

### 3. Make API Requests (Standard Bearer Token)

Use the access token for all API requests:

```javascript
// Step 4: Make authenticated API requests
async function callBackendAPI(endpoint, options = {}) {
  const token = sessionStorage.getItem('backenly_token')
  
  if (!token) {
    throw new Error('Not authenticated - please connect first')
  }
  
  // Check token expiration
  const expiresAt = parseInt(sessionStorage.getItem('backenly_expires'))
  if (Date.now() >= expiresAt) {
    throw new Error('Token expired - please re-authenticate')
  }
  
  // Standard Bearer token authentication (RFC 6750)
  const response = await fetch(endpoint, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,  // ← STANDARD HTTP, NO SDK
    },
  })
  
  return response
}

// Example: Fetch schema
async function getSchema() {
  const response = await callBackendAPI('https://backenly.app/api/v1/schema')
  return response.json()
}

// Example: Create record
async function createUser(data) {
  const response = await callBackendAPI('https://backenly.app/api/v1/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return response.json()
}
```

### 4. Token Revocation (Logout)

Revoke token when user disconnects:

```javascript
// Step 5: Revoke token on logout
async function disconnect() {
  const token = sessionStorage.getItem('backenly_token')
  
  if (token) {
    // Revoke token (RFC 7009)
    await fetch('https://backenly.app/api/oidc/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        token: token,
        client_id: 'your-app-name',
      }),
    })
  }
  
  // Clear local storage
  sessionStorage.removeItem('backenly_token')
  sessionStorage.removeItem('backenly_expires')
}
```

---

## Security Features

### ✅ Standards-Based (Auditable)
- RFC 6749 - OAuth 2.0 Authorization Framework
- RFC 7636 - PKCE for OAuth Public Clients
- RFC 6750 - Bearer Token Usage
- RFC 7009 - Token Revocation
- OpenID Connect Core 1.0

### ✅ Short-Lived Tokens
- Authorization codes expire in 10 minutes
- Access tokens expire in 1 hour
- Single-use authorization codes
- Automatic expiration enforcement

### ✅ Scoped Access
- Tokens scoped to specific project
- Granular permissions (read:schema, call:apis, etc.)
- Project isolation enforced in token claims

### ✅ Revocable
- Instant revocation via `/api/oidc/revoke`
- Server-side revocation tracking
- No "eternal" access tokens

### ✅ No Secrets in Frontend
- No API keys in browser
- No client secrets (PKCE instead)
- Authorization codes transmitted securely
- Tokens never in URL (only in POST body)

---

## No SDK Required

This is **pure HTTP**. Works with:
- `fetch()` (vanilla JS)
- `axios` (popular HTTP client)
- Standard OAuth2 libraries (e.g., `oauth2-client`)
- Any HTTP client in any language

**No custom SDK. No magic. Just standards.**

---

## Iframe Handshake (Alternative)

For seamless UX without full-page redirects:

```javascript
// Alternative: Iframe handshake
function connectViaIframe(projectId) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe')
    iframe.style.display = 'none'
    
    // Build authorization URL
    const authUrl = new URL('https://backenly.app/api/oidc/authorize')
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', 'your-app-name')
    authUrl.searchParams.set('project_id', projectId)
    authUrl.searchParams.set('scope', 'read:schema read:endpoints call:apis')
    authUrl.searchParams.set('redirect_uri', 'https://backenly.app/api/oidc/iframe-callback')
    authUrl.searchParams.set('display', 'iframe')
    
    iframe.src = authUrl.toString()
    
    // Listen for token message
    window.addEventListener('message', function handler(event) {
      if (event.origin !== 'https://backenly.app') return
      
      if (event.data.type === 'oidc_token') {
        sessionStorage.setItem('backenly_token', event.data.access_token)
        sessionStorage.setItem('backenly_expires', Date.now() + event.data.expires_in * 1000)
        
        document.body.removeChild(iframe)
        window.removeEventListener('message', handler)
        resolve(event.data.access_token)
      }
    })
    
    document.body.appendChild(iframe)
  })
}
```

---

## Migration from Custom Tokens

If you're currently using Backenly's legacy delegation tokens (`del_*`):

1. Replace `del_*` tokens with OIDC flow
2. Update Authorization headers to use `Bearer` tokens
3. Re-authenticate users on next login
4. Legacy tokens continue working during transition
5. Legacy tokens deprecated after 90 days

**OIDC is the new standard. Audit-compliant. Zero magic.**
