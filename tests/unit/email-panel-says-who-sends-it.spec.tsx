/**
 * @jest-environment jsdom
 */
/**
 * The Auth page's Email tab says who sends a project's auth emails, and as
 * whom. Production QA (2026-11-09): on Backenly Cloud it said "Mail sends
 * through the deployment's SMTP environment variables", which a customer
 * cannot see, set or act on. Backenly sends that mail, as the app.
 */
import { act, render, screen } from '@testing-library/react'

let cloud = false
jest.mock('@cloud/control-plane', () => ({
  get CLOUD_CONTROL_PLANE() {
    return cloud
  },
}))

import { EmailSettingsPanel } from '@/components/auth/EmailSettingsPanel'

const SMTP = {
  configured: false,
  enabled: false,
  host: null,
  port: null,
  username: null,
  fromAddress: null,
  fromName: null,
  passwordConfigured: false,
  effectivePort: null,
  portNormalised: false,
  lastTestAt: null,
  lastTestError: null,
  deploymentFallbackAvailable: true,
  deploymentSenderAddress: 'noreply@backenly.com',
  activeSource: 'deployment',
}
const POLICY = {
  appName: null,
  appUrl: null,
  requireEmailVerification: false,
  magicLinksEnabled: true,
  effectiveAppName: 'shopqa',
  effectiveAppUrl: null,
}

beforeEach(() => {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    const body = path.endsWith('/email/smtp')
      ? { smtp: SMTP }
      : path.endsWith('/email/templates')
        ? { templates: [], variables: [] }
        : path.endsWith('/auth-email-settings')
          ? { settings: POLICY }
          : {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
})

async function renderPanel() {
  render(<EmailSettingsPanel projectId="p1" />)
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
}

it('on Cloud, says Backenly sends the mail, as the app, and how to send from your own domain', async () => {
  cloud = true
  await renderPanel()
  expect(screen.getByText('Sent by Backenly')).toBeInTheDocument()
  expect(
    screen.getByText(
      'Backenly sends this project’s auth emails as “shopqa” <noreply@backenly.com>. To send from your own domain, add your SMTP settings below.',
    ),
  ).toBeInTheDocument()
  expect(screen.getByText('With these off, Backenly sends the auth emails.')).toBeInTheDocument()
  expect(screen.getByText('Unchecked, Backenly sends them.')).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/environment variables|deployment’s SMTP/)
})

it('self-hosted, keeps naming the deployment’s variables, and names the sender too', async () => {
  cloud = false
  await renderPanel()
  expect(screen.getByText('Deployment SMTP')).toBeInTheDocument()
  expect(
    screen.getByText('Mail sends through the deployment’s SMTP environment variables as “shopqa” <noreply@backenly.com>.'),
  ).toBeInTheDocument()
  expect(screen.getByText('Unchecked, auth emails fall back to the deployment’s SMTP.')).toBeInTheDocument()
})
