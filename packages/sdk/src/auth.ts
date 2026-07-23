import type { BackenlyClient } from './client'
import type { AuthResponse, User } from './types'
import { normalizeError } from './errors'

export class AuthModule {
  constructor(private client: BackenlyClient) {}

  private get baseUrl() {
    return `/api/v1/${this.client.getProjectId()}/auth`
  }

  /**
   * Register a new end-user.
   *
   * @example
   * const { user, token } = await backend.auth.signUp({ email, password })
   */
  async signUp(opts: { email: string; password: string; name?: string }): Promise<AuthResponse>
  async signUp(email: string, password: string): Promise<AuthResponse>
  async signUp(
    emailOrOpts: string | { email: string; password: string; name?: string },
    password?: string
  ): Promise<AuthResponse> {
    try {
      const body =
        typeof emailOrOpts === 'string'
          ? { email: emailOrOpts, password }
          : emailOrOpts

      const response = await this.client.request(`${this.baseUrl}/signup`, {
        method: 'POST',
        body: JSON.stringify(body),
        skipAuth: true,
      })

      if (response?.data?.token) {
        this.client.setUserToken(response.data.token)
      } else if (response?.token) {
        this.client.setUserToken(response.token)
      }

      return response?.data ?? response
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /**
   * Sign in an existing end-user.
   *
   * @example
   * const { user, token } = await backend.auth.signIn({ email, password })
   */
  async signIn(opts: { email: string; password: string }): Promise<AuthResponse>
  async signIn(email: string, password: string): Promise<AuthResponse>
  async signIn(
    emailOrOpts: string | { email: string; password: string },
    password?: string
  ): Promise<AuthResponse> {
    try {
      const body =
        typeof emailOrOpts === 'string'
          ? { email: emailOrOpts, password }
          : emailOrOpts

      const response = await this.client.request(`${this.baseUrl}/signin`, {
        method: 'POST',
        body: JSON.stringify(body),
        skipAuth: true,
      })

      if (response?.data?.token) {
        this.client.setUserToken(response.data.token)
      } else if (response?.token) {
        this.client.setUserToken(response.token)
      }

      return response?.data ?? response
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /**
   * Silently renew an expiring (or recently expired) JWT without forcing the
   * user to sign in again.  Call this before the token expires — e.g. in a
   * background interval or whenever you receive a 401 from another endpoint.
   *
   * The refreshed token is automatically stored in localStorage so subsequent
   * SDK calls use it immediately.
   *
   * @example
   * const { token } = await backend.auth.refreshToken()
   */
  async refreshToken(opts?: { token?: string }): Promise<{ token: string; user: User }> {
    try {
      const currentToken = opts?.token ?? this.client.getUserToken()
      const response = await this.client.request(`${this.baseUrl}/refresh-token`, {
        method: 'POST',
        body: JSON.stringify(currentToken ? { token: currentToken } : {}),
      })

      const data = response?.data ?? response
      if (data?.token) {
        this.client.setUserToken(data.token)
      }

      return data
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /**
   * Log out the current user and revoke their token server-side.
   * Revoked tokens are immediately rejected by all protected endpoints —
   * they cannot be reused even before their natural expiry.
   *
   * @example
   * await backend.auth.logout()
   */
  async logout(opts?: { token?: string }): Promise<void> {
    try {
      const currentToken = opts?.token ?? this.client.getUserToken()
      await this.client.request(`${this.baseUrl}/logout`, {
        method: 'POST',
        body: JSON.stringify(currentToken ? { token: currentToken } : {}),
      })
    } catch {
      // Logout must never throw — even if the server rejects, clear locally
    } finally {
      this.client.setUserToken(null)
    }
  }

  /**
   * @deprecated Use logout() instead (server-side revocation).
   * This alias remains for backwards compatibility — it calls logout() now.
   */
  signOut(): void {
    this.logout().catch(() => {})
  }

  /**
   * Initiate the forgot-password flow.  An email is sent if SMTP is
   * configured on the server; otherwise the reset token is returned in the
   * response so you can deliver it through your own email provider.
   *
   * @example
   * await backend.auth.forgotPassword({ email: 'user@example.com' })
   */
  async forgotPassword(opts: { email: string }): Promise<{ message: string; resetToken?: string; resetUrl?: string }> {
    try {
      const response = await this.client.request(`${this.baseUrl}/forgot-password`, {
        method: 'POST',
        body: JSON.stringify(opts),
      })
      return response?.data ?? response
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /**
   * Complete the password-reset flow.  Pass the token from the reset email
   * (or from the forgotPassword response if SMTP is not configured) plus the
   * new password.  Returns a fresh JWT so the user is automatically signed in.
   *
   * @example
   * const { token, user } = await backend.auth.resetPassword({ token, password: newPassword })
   */
  async resetPassword(opts: { token: string; password: string }): Promise<AuthResponse> {
    try {
      const response = await this.client.request(`${this.baseUrl}/reset-password`, {
        method: 'POST',
        body: JSON.stringify(opts),
      })

      const data = response?.data ?? response
      if (data?.token) {
        this.client.setUserToken(data.token)
      }

      return data
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /**
   * Verify an email address with the token from the verification email.
   * (The emailed link also works on its own — this method is for apps that
   * capture the token and verify in-app.)
   */
  async verifyEmail(opts: { token: string }): Promise<{ verified: boolean; email: string }> {
    try {
      const response = await this.client.request(`${this.baseUrl}/verify-email`, {
        method: 'POST',
        body: JSON.stringify(opts),
      })
      return response?.data ?? response
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** Re-send the verification email. Always resolves — never reveals whether the email exists. */
  async resendVerification(opts: { email: string }): Promise<{ message: string }> {
    try {
      const response = await this.client.request(`${this.baseUrl}/resend-verification`, {
        method: 'POST',
        body: JSON.stringify(opts),
      })
      return response?.data ?? response
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /**
   * Passwordless sign-in: emails the user a single-use, 15-minute sign-in
   * link. New users are created automatically on their first link. When the
   * user clicks it they land back on your app already signed in — call
   * `handleMagicLinkCallback()` on page load to pick up the session.
   *
   * @example
   * await backend.auth.signInWithMagicLink({ email })
   * // …user clicks the emailed link…
   * // on page load:
   * const user = await backend.auth.handleMagicLinkCallback()
   */
  async signInWithMagicLink(opts: { email: string }): Promise<{ message: string }> {
    try {
      const response = await this.client.request(`${this.baseUrl}/magic-link`, {
        method: 'POST',
        body: JSON.stringify(opts),
      })
      return response?.data ?? response
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** Exchange a magic-link token for a session (for apps that capture the token themselves). */
  async verifyMagicLink(opts: { token: string }): Promise<AuthResponse> {
    try {
      const response = await this.client.request(`${this.baseUrl}/magic-link/verify`, {
        method: 'POST',
        body: JSON.stringify(opts),
      })
      const data = response?.data ?? response
      if (data?.token) {
        this.client.setUserToken(data.token)
      }
      return data
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /**
   * Finish a magic-link sign-in on page load. The emailed link redirects to
   * your app with the session in the URL fragment (#backenly_token=…) — this
   * reads it, stores the session, cleans the URL, and returns the user.
   * Returns null when the URL has no magic-link session.
   */
  async handleMagicLinkCallback(): Promise<User | null> {
    if (typeof window === 'undefined') return null
    const hash = window.location.hash
    const match = hash.match(/[#&]backenly_token=([^&]+)/)
    if (!match) return null
    this.client.setUserToken(decodeURIComponent(match[1]))
    try {
      const cleaned = hash.replace(/[#&]backenly_token=[^&]+/, '')
      window.history.replaceState(
        {}, '',
        window.location.pathname + window.location.search + (cleaned === '#' ? '' : cleaned),
      )
    } catch {
      // non-fatal — token is already stored
    }
    return this.getUser()
  }

  /**
   * Start an OAuth sign-in. The browser is redirected to the provider
   * (Google, GitHub, etc.). After authorization the user is sent back to
   * `redirectTo` (default: the current page) with `?token=...&user_id=...`.
   * Call `handleOAuthCallback()` on the destination page to finish sign-in.
   *
   * @example
   * <button onClick={() => backend.auth.signInWithProvider('github')}>
   *   Sign in with GitHub
   * </button>
   */
  signInWithProvider(
    provider: 'google' | 'github' | 'discord' | 'facebook',
    options?: { redirectTo?: string }
  ): void {
    if (typeof window === 'undefined') {
      throw new Error('signInWithProvider can only be called in a browser context')
    }
    const projectId = this.client.getProjectId()
    const apiUrl = this.client.getApiUrl()
    const redirectTo = options?.redirectTo ?? window.location.href
    window.location.href =
      `${apiUrl}/api/v1/${projectId}/auth/${provider}` +
      `?redirect_to=${encodeURIComponent(redirectTo)}`
  }

  /**
   * Finish an OAuth sign-in on the page the user lands on after
   * authorizing with the provider. Reads `?token=...&user_id=...` from the
   * URL, stores the JWT, cleans the query out of the address bar, and
   * returns the signed-in user. Returns null if no token is in the URL.
   *
   * @example
   * useEffect(() => {
   *   backend.auth.handleOAuthCallback().then((user) => {
   *     if (user) navigate('/dashboard')
   *   })
   * }, [])
   */
  async handleOAuthCallback(): Promise<User | null> {
    if (typeof window === 'undefined') return null
    const url = new URL(window.location.href)
    const token = url.searchParams.get('token')
    if (!token) return null
    this.client.setUserToken(token)
    url.searchParams.delete('token')
    url.searchParams.delete('user_id')
    try {
      window.history.replaceState({}, '', url.toString())
    } catch {
      // non-fatal — token is already stored
    }
    return this.getUser()
  }

  /**
   * Get the current user from a stored JWT.
   * Returns null if no token is set or the token is invalid.
   */
  async getUser(): Promise<User | null> {
    try {
      const token = this.client.getUserToken()
      if (!token) return null

      // Decode from the stored JWT payload without a server round-trip
      const parts = token.split('.')
      if (parts.length !== 3) return null
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
      if (!payload?.userId) return null

      return {
        id: payload.userId,
        email: payload.email,
        name: payload.name,
      } as User
    } catch {
      return null
    }
  }
}
