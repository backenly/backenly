/**
 * A REAL SESSION, ON A REAL SELF-HOSTED DEPLOYMENT
 * ===============================================
 * The specs beside this file assert user-visible behaviour, so they need a
 * signed-in browser. The pre-existing suite in `tests/e2e/` says
 * "assumes user is already authenticated" and nothing ever made that true,
 * which is why it has never run in CI and is not evidence for anything.
 *
 * This makes it true, without a fixture or a mock: it claims the deployment
 * `npm run selfhost` just built through the real signup PAGE, and saves the
 * session cookie the app itself issued. If registration is broken, these tests
 * do not run — which is correct, because a deployment nobody can sign into is
 * not one whose dashboard is worth asserting.
 *
 * The page, not a request composed here. This setup used to POST the setup
 * token to `/api/auth/register` itself, and stayed green while the route
 * demanded a token that no page could send: every operator following the
 * README was refused, on the one path nothing here exercised.
 *
 * A self-hosted install admits exactly one account and then closes
 * registration, so this runs once per deployment, as the first operator.
 */

import { test as setup, expect } from '@playwright/test'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

export const STORAGE_STATE = resolve(__dirname, '../../../.playwright/selfhost-state.json')
const PROJECT_HANDOFF = resolve(__dirname, '../../../.playwright/selfhost-project.json')

setup('sign up the first operator', async ({ page, request, baseURL }) => {
  // Re-runnable.
  //
  // A self-hosted install admits exactly ONE account and then closes
  // registration, and this setup runs again whenever the specs project runs.
  // It also has to run before `npm run bootstrap` adopts the operator as the
  // project's owner, and again after. So a second run reuses the credentials
  // the first one stored rather than trying to register into a closed door.
  const existing = existsSync(PROJECT_HANDOFF)
    ? JSON.parse(readFileSync(PROJECT_HANDOFF, 'utf8'))
    : null

  const email = existing?.email ?? `e2e-${randomBytes(4).toString('hex')}@example.test`
  // Long enough for any password policy, and generated so it is never a
  // literal in the repository.
  const password = existing?.password ?? `E2e!${randomBytes(12).toString('hex')}`

  if (!existing) {
    // The setup token claims the deployment. `npm run selfhost` generated it
    // and CI passes it through, exactly as an operator reads it from the
    // install output. Registration without it is refused on a self-hosted
    // deployment, which is the point.
    const token = process.env.BACKENLY_SETUP_TOKEN?.trim()
    expect(token, 'BACKENLY_SETUP_TOKEN is not exported, so nothing can claim the deployment').toBeTruthy()

    // Entry one: the plain signup page asks for the token while unclaimed.
    // The email form opens on click, and a click before hydration is
    // swallowed, so retry until the form is there.
    await page.goto('/auth/signup')
    await expect(async () => {
      await page.getByText('Continue with Email').click()
      await expect(page.locator('#email')).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 60_000 })
    await expect(
      page.locator('#setupToken'),
      'the signup page shows no setup-token field on an unclaimed deployment'
    ).toBeVisible()

    // Entry two, used for the claim itself: the link the installer prints.
    await page.goto(`/auth/signup?setup_token=${token}`)
    await expect(page.locator('#setupToken')).toHaveValue(token!, { timeout: 60_000 })
    await expect(page, 'the token stayed in the address bar').not.toHaveURL(/setup_token=/)

    await page.fill('#email', email)
    await page.fill('#password', password)
    const [res] = await Promise.all([
      page.waitForResponse(
        r => new URL(r.url()).pathname === '/api/auth/register' && r.request().method() === 'POST'
      ),
      page.getByRole('button', { name: /create account/i }).click(),
    ])
    expect(
      res.ok(),
      `registration through the signup page failed (${res.status()}): ${await res.text()}`
    ).toBe(true)
  }

  // Register returns a token in its BODY and sets no cookie; login is what
  // issues the `auth-token` cookie the app authenticates with. So the setup
  // does what an operator does — sign up, then sign in — rather than lifting
  // the token out of the register response and constructing a cookie by hand.
  // A hand-built cookie would also pass if login were broken, which is exactly
  // the failure this suite should not be blind to.
  const login = await request.post('/api/auth/login', { data: { email, password } })
  expect(login.ok(), `login failed (${login.status()}): ${await login.text()}`).toBe(true)

  // The cookie the application set, not one this file invented. Reading it back
  // from the context is what proves the session is real.
  const cookies = await request.storageState().then(s => s.cookies)
  const auth = cookies.find(c => c.name === 'auth-token')
  expect(auth, 'no auth-token cookie was issued by /api/auth/login').toBeTruthy()

  mkdirSync(dirname(STORAGE_STATE), { recursive: true })
  writeFileSync(
    STORAGE_STATE,
    JSON.stringify({ cookies, origins: [] }, null, 2),
    'utf8'
  )

  // Prove the session actually opens the dashboard before any spec depends on
  // it. A cookie that exists but does not authenticate would otherwise surface
  // as an unrelated failure in every spec at once.
  await page.context().addCookies(cookies)
  await page.goto('/app')
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 30_000 })

  // The single project this deployment is.
  //
  // BACKENLY_PROJECT_ID is the authority: bootstrap pinned it, it names the
  // workspace schema, and it cannot drift. The API listing is a fallback for
  // running this against a deployment whose env is not readable from here.
  //
  // Reading it from the listing alone was wrong once already — the shape did
  // not match, `list[0].id` came back undefined, and every spec navigated to
  // /app/projects/undefined/... which redirects to the project list. Four
  // specs then failed on "element not found" for a page they were never on.
  let id = process.env.BACKENLY_PROJECT_ID?.trim() || ''

  if (!id) {
    const projects = await request.get('/api/projects')
    expect(projects.ok(), `could not list projects: ${projects.status()}`).toBe(true)
    const body = await projects.json()
    const list = Array.isArray(body) ? body : (body.projects ?? body.data ?? [])
    expect(Array.isArray(list) && list.length > 0, 'the deployment has no project').toBe(true)
    id = list[0]?.id ?? ''
  }

  // Asserted rather than assumed, so a bad shape fails HERE with a clear
  // message instead of as a mystery redirect in every spec.
  expect(
    typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id),
    `could not determine the project id (got ${JSON.stringify(id)})`
  ).toBe(true)

  // Ownership, asserted right here.
  //
  // This is the whole claim of the setup-token change: signing up binds the
  // administrator to the project in the SAME transaction, so there is no
  // second `npm run bootstrap` and no window in which the only account cannot
  // use the dashboard. If adoption regressed, the listing below is empty and
  // this fails immediately rather than as four mysterious redirects later.
  const owned = await request.get('/api/projects')
  expect(owned.ok(), `could not list projects after signup: ${owned.status()}`).toBe(true)
  const ownedBody = await owned.json()
  const ownedList = Array.isArray(ownedBody) ? ownedBody : (ownedBody.projects ?? ownedBody.data ?? [])
  expect(
    Array.isArray(ownedList) && ownedList.length > 0,
    'the account that just signed up owns no project - adoption did not happen at signup'
  ).toBe(true)

  // The password is stored so a rerun of this setup can log in rather than
  // register. The file is gitignored and lives only for the life of the job.
  writeFileSync(PROJECT_HANDOFF, JSON.stringify({ id, email, password }, null, 2), 'utf8')
  void baseURL
})
