-- Migration: Add Webhook, WebhookLog, and CustomDomain tables
-- Phase 7 & 8: Webhook System and Custom Domain (PRO Only)

-- Create Webhook table
CREATE TABLE IF NOT EXISTS webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL, -- row.inserted | row.deleted | auth.user.created
    target_url TEXT NOT NULL,
    secret VARCHAR(255) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create index on webhooks
CREATE INDEX IF NOT EXISTS idx_webhooks_project_id ON webhooks(project_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_event_type ON webhooks(event_type);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active);

-- Create WebhookLog table
CREATE TABLE IF NOT EXISTS webhook_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    signature VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING | SUCCESS | FAILED | RETRYING
    status_code INTEGER,
    response_body TEXT,
    error TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create indexes on webhook_logs
CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook_id ON webhook_logs(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_status ON webhook_logs(status);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON webhook_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_next_retry_at ON webhook_logs(next_retry_at);

-- Create CustomDomain table
CREATE TABLE IF NOT EXISTS custom_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    domain VARCHAR(255) NOT NULL UNIQUE,
    verification_token VARCHAR(255) NOT NULL UNIQUE,
    verified BOOLEAN NOT NULL DEFAULT false,
    verified_at TIMESTAMP WITH TIME ZONE,
    dns_record_type VARCHAR(10) NOT NULL DEFAULT 'TXT',
    dns_record_value TEXT NOT NULL,
    ssl_enabled BOOLEAN NOT NULL DEFAULT false,
    ssl_cert_url TEXT,
    active BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create indexes on custom_domains
CREATE INDEX IF NOT EXISTS idx_custom_domains_project_id ON custom_domains(project_id);
CREATE INDEX IF NOT EXISTS idx_custom_domains_domain ON custom_domains(domain);
CREATE INDEX IF NOT EXISTS idx_custom_domains_verified ON custom_domains(verified);
CREATE INDEX IF NOT EXISTS idx_custom_domains_active ON custom_domains(active);

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
DROP TRIGGER IF EXISTS update_webhooks_updated_at ON webhooks;
CREATE TRIGGER update_webhooks_updated_at
    BEFORE UPDATE ON webhooks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_custom_domains_updated_at ON custom_domains;
CREATE TRIGGER update_custom_domains_updated_at
    BEFORE UPDATE ON custom_domains
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Migration complete
SELECT 'Webhook and CustomDomain tables created successfully' as status;
