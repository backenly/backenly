/**
 * OIDC-Compliant Delegation Tables
 * 
 * Migration: Add tables for standards-based OAuth2/OIDC flow
 * 
 * - oauth_authorization_codes: Short-lived authorization codes (10min expiry)
 * - oidc_access_tokens: Access tokens with revocation support
 */

-- Authorization Codes (short-lived, single-use)
-- RFC 6749 Section 4.1 - Authorization Code Grant
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code TEXT NOT NULL UNIQUE,  -- SHA-256 hash of actual code
  project_id TEXT NOT NULL,
  client_id TEXT NOT NULL,  -- replit, lovable, bolt, etc.
  scope TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT,  -- PKCE code challenge (optional)
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  -- Foreign keys
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  
  -- Indexes
  INDEX idx_oauth_codes_code ON oauth_authorization_codes(code),
  INDEX idx_oauth_codes_project ON oauth_authorization_codes(project_id),
  INDEX idx_oauth_codes_expires ON oauth_authorization_codes(expires_at)
);

-- OIDC Access Tokens (revocable)
-- RFC 6749 Section 1.4 - Access Token
-- RFC 7009 - Token Revocation
CREATE TABLE IF NOT EXISTS oidc_access_tokens (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jti TEXT NOT NULL UNIQUE,  -- JWT ID (unique token identifier)
  project_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  -- Foreign keys
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  
  -- Indexes
  INDEX idx_oidc_tokens_jti ON oidc_access_tokens(jti),
  INDEX idx_oidc_tokens_project ON oidc_access_tokens(project_id),
  INDEX idx_oidc_tokens_expires ON oidc_access_tokens(expires_at),
  INDEX idx_oidc_tokens_revoked ON oidc_access_tokens(revoked)
);

-- Cleanup: Remove expired authorization codes (run daily)
-- Authorization codes expire after 10 minutes
CREATE INDEX IF NOT EXISTS idx_oauth_codes_cleanup 
ON oauth_authorization_codes(expires_at) 
WHERE expires_at < NOW();

-- Cleanup: Remove expired access tokens (run daily)
-- Access tokens expire after 1 hour
CREATE INDEX IF NOT EXISTS idx_oidc_tokens_cleanup 
ON oidc_access_tokens(expires_at) 
WHERE expires_at < NOW();

COMMENT ON TABLE oauth_authorization_codes IS 'RFC 6749 Authorization Codes - short-lived, single-use codes for OIDC flow';
COMMENT ON TABLE oidc_access_tokens IS 'RFC 6749 Access Tokens - revocable JWT tokens for API access';
COMMENT ON COLUMN oauth_authorization_codes.code IS 'SHA-256 hash of authorization code (actual code never stored)';
COMMENT ON COLUMN oauth_authorization_codes.code_challenge IS 'PKCE code_challenge for public clients (RFC 7636)';
COMMENT ON COLUMN oidc_access_tokens.jti IS 'JWT ID from token claims - unique identifier for revocation';
COMMENT ON COLUMN oidc_access_tokens.scope IS 'Space-separated OIDC scopes (e.g., "read:schema read:endpoints")';
