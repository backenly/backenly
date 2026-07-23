/**
 * Backenly Client SDK (generated from packages/sdk — DO NOT EDIT BY HAND)
 * Hosted at: https://backenly.com/backenly-sdk.js (UMD)
 *            https://backenly.com/backenly-sdk.esm.js (ESM)
 *
 * Usage (plain HTML / Replit):
 *   <script src="https://backenly.com/backenly-sdk.js"></script>
 *   <script>
 *     const backend = createClient({ projectId: "your-id", apiKey: "your-key" })
 *     const posts = await backend.posts.list()
 *   </script>
 *
 * Usage (React / Next.js / Vue / bundlers — Base44, Lovable, Cursor, v0):
 *   import { createClient } from "https://backenly.com/backenly-sdk.esm.js"
 *   const backend = createClient({ projectId: "your-id", apiKey: "your-key" })
 */
"use strict";
var Backenly = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // packages/sdk/src/index.ts
  var index_exports = {};
  __export(index_exports, {
    AuthModule: () => AuthModule,
    BackenlyClient: () => BackenlyClient,
    BackenlyError: () => BackenlyError,
    BackenlySupabaseCompat: () => BackenlySupabaseCompat,
    CompatQueryBuilder: () => CompatQueryBuilder,
    PresenceModule: () => PresenceModule,
    QueryBuilder: () => QueryBuilder,
    RealtimeModule: () => RealtimeModule,
    StorageModule: () => StorageModule,
    TableClient: () => TableClient,
    createClient: () => createClient2,
    createSupabaseCompatClient: () => createClient,
    createTypedClient: () => createTypedClient
  });

  // packages/sdk/src/errors.ts
  var BackenlyError = class extends Error {
    constructor(message, code, status, details) {
      var _a;
      super(message);
      this.code = code;
      this.status = status;
      this.name = "BackenlyError";
      this.details = details;
      this.hint = details == null ? void 0 : details.hint;
      this.fixUrl = details == null ? void 0 : details.fixUrl;
      if (typeof console !== "undefined" && this.hint) {
        const banner = `[Backenly] ${(_a = this.code) != null ? _a : "Error"}: ${this.message}`;
        const lines = [
          banner,
          "",
          this.hint,
          this.fixUrl ? `
Fix it: ${this.fixUrl}` : ""
        ].filter(Boolean).join("\n");
        console.warn(lines);
      }
    }
  };
  function normalizeError(error) {
    var _a;
    if (error instanceof BackenlyError) return error;
    if ((error == null ? void 0 : error.error) && typeof error.error === "object") {
      const e = error.error;
      return new BackenlyError(
        (_a = e.message) != null ? _a : "Request failed",
        e.code,
        error.status,
        e.details
      );
    }
    if (typeof (error == null ? void 0 : error.error) === "string") {
      return new BackenlyError(error.error, error.code, error.status);
    }
    if (error == null ? void 0 : error.message) return new BackenlyError(error.message);
    return new BackenlyError("An unexpected error occurred");
  }

  // packages/sdk/src/auth.ts
  var AuthModule = class {
    constructor(client) {
      this.client = client;
    }
    get baseUrl() {
      return `/api/v1/${this.client.getProjectId()}/auth`;
    }
    async signUp(emailOrOpts, password) {
      var _a, _b;
      try {
        const body = typeof emailOrOpts === "string" ? { email: emailOrOpts, password } : emailOrOpts;
        const response = await this.client.request(`${this.baseUrl}/signup`, {
          method: "POST",
          body: JSON.stringify(body),
          skipAuth: true
        });
        if ((_a = response == null ? void 0 : response.data) == null ? void 0 : _a.token) {
          this.client.setUserToken(response.data.token);
        } else if (response == null ? void 0 : response.token) {
          this.client.setUserToken(response.token);
        }
        return (_b = response == null ? void 0 : response.data) != null ? _b : response;
      } catch (error) {
        throw normalizeError(error);
      }
    }
    async signIn(emailOrOpts, password) {
      var _a, _b;
      try {
        const body = typeof emailOrOpts === "string" ? { email: emailOrOpts, password } : emailOrOpts;
        const response = await this.client.request(`${this.baseUrl}/signin`, {
          method: "POST",
          body: JSON.stringify(body),
          skipAuth: true
        });
        if ((_a = response == null ? void 0 : response.data) == null ? void 0 : _a.token) {
          this.client.setUserToken(response.data.token);
        } else if (response == null ? void 0 : response.token) {
          this.client.setUserToken(response.token);
        }
        return (_b = response == null ? void 0 : response.data) != null ? _b : response;
      } catch (error) {
        throw normalizeError(error);
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
    async refreshToken(opts) {
      var _a, _b;
      try {
        const currentToken = (_a = opts == null ? void 0 : opts.token) != null ? _a : this.client.getUserToken();
        const response = await this.client.request(`${this.baseUrl}/refresh-token`, {
          method: "POST",
          body: JSON.stringify(currentToken ? { token: currentToken } : {})
        });
        const data = (_b = response == null ? void 0 : response.data) != null ? _b : response;
        if (data == null ? void 0 : data.token) {
          this.client.setUserToken(data.token);
        }
        return data;
      } catch (error) {
        throw normalizeError(error);
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
    async logout(opts) {
      var _a;
      try {
        const currentToken = (_a = opts == null ? void 0 : opts.token) != null ? _a : this.client.getUserToken();
        await this.client.request(`${this.baseUrl}/logout`, {
          method: "POST",
          body: JSON.stringify(currentToken ? { token: currentToken } : {})
        });
      } catch {
      } finally {
        this.client.setUserToken(null);
      }
    }
    /**
     * @deprecated Use logout() instead (server-side revocation).
     * This alias remains for backwards compatibility — it calls logout() now.
     */
    signOut() {
      this.logout().catch(() => {
      });
    }
    /**
     * Initiate the forgot-password flow.  An email is sent if SMTP is
     * configured on the server; otherwise the reset token is returned in the
     * response so you can deliver it through your own email provider.
     *
     * @example
     * await backend.auth.forgotPassword({ email: 'user@example.com' })
     */
    async forgotPassword(opts) {
      var _a;
      try {
        const response = await this.client.request(`${this.baseUrl}/forgot-password`, {
          method: "POST",
          body: JSON.stringify(opts)
        });
        return (_a = response == null ? void 0 : response.data) != null ? _a : response;
      } catch (error) {
        throw normalizeError(error);
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
    async resetPassword(opts) {
      var _a;
      try {
        const response = await this.client.request(`${this.baseUrl}/reset-password`, {
          method: "POST",
          body: JSON.stringify(opts)
        });
        const data = (_a = response == null ? void 0 : response.data) != null ? _a : response;
        if (data == null ? void 0 : data.token) {
          this.client.setUserToken(data.token);
        }
        return data;
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /**
     * Verify an email address with the token from the verification email.
     * (The emailed link also works on its own — this method is for apps that
     * capture the token and verify in-app.)
     */
    async verifyEmail(opts) {
      var _a;
      try {
        const response = await this.client.request(`${this.baseUrl}/verify-email`, {
          method: "POST",
          body: JSON.stringify(opts)
        });
        return (_a = response == null ? void 0 : response.data) != null ? _a : response;
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /** Re-send the verification email. Always resolves — never reveals whether the email exists. */
    async resendVerification(opts) {
      var _a;
      try {
        const response = await this.client.request(`${this.baseUrl}/resend-verification`, {
          method: "POST",
          body: JSON.stringify(opts)
        });
        return (_a = response == null ? void 0 : response.data) != null ? _a : response;
      } catch (error) {
        throw normalizeError(error);
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
    async signInWithMagicLink(opts) {
      var _a;
      try {
        const response = await this.client.request(`${this.baseUrl}/magic-link`, {
          method: "POST",
          body: JSON.stringify(opts)
        });
        return (_a = response == null ? void 0 : response.data) != null ? _a : response;
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /** Exchange a magic-link token for a session (for apps that capture the token themselves). */
    async verifyMagicLink(opts) {
      var _a;
      try {
        const response = await this.client.request(`${this.baseUrl}/magic-link/verify`, {
          method: "POST",
          body: JSON.stringify(opts)
        });
        const data = (_a = response == null ? void 0 : response.data) != null ? _a : response;
        if (data == null ? void 0 : data.token) {
          this.client.setUserToken(data.token);
        }
        return data;
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /**
     * Finish a magic-link sign-in on page load. The emailed link redirects to
     * your app with the session in the URL fragment (#backenly_token=…) — this
     * reads it, stores the session, cleans the URL, and returns the user.
     * Returns null when the URL has no magic-link session.
     */
    async handleMagicLinkCallback() {
      if (typeof window === "undefined") return null;
      const hash = window.location.hash;
      const match = hash.match(/[#&]backenly_token=([^&]+)/);
      if (!match) return null;
      this.client.setUserToken(decodeURIComponent(match[1]));
      try {
        const cleaned = hash.replace(/[#&]backenly_token=[^&]+/, "");
        window.history.replaceState(
          {},
          "",
          window.location.pathname + window.location.search + (cleaned === "#" ? "" : cleaned)
        );
      } catch {
      }
      return this.getUser();
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
    signInWithProvider(provider, options) {
      var _a;
      if (typeof window === "undefined") {
        throw new Error("signInWithProvider can only be called in a browser context");
      }
      const projectId = this.client.getProjectId();
      const apiUrl = this.client.getApiUrl();
      const redirectTo = (_a = options == null ? void 0 : options.redirectTo) != null ? _a : window.location.href;
      window.location.href = `${apiUrl}/api/v1/${projectId}/auth/${provider}?redirect_to=${encodeURIComponent(redirectTo)}`;
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
    async handleOAuthCallback() {
      if (typeof window === "undefined") return null;
      const url = new URL(window.location.href);
      const token = url.searchParams.get("token");
      if (!token) return null;
      this.client.setUserToken(token);
      url.searchParams.delete("token");
      url.searchParams.delete("user_id");
      try {
        window.history.replaceState({}, "", url.toString());
      } catch {
      }
      return this.getUser();
    }
    /**
     * Get the current user from a stored JWT.
     * Returns null if no token is set or the token is invalid.
     */
    async getUser() {
      try {
        const token = this.client.getUserToken();
        if (!token) return null;
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (!(payload == null ? void 0 : payload.userId)) return null;
        return {
          id: payload.userId,
          email: payload.email,
          name: payload.name
        };
      } catch {
        return null;
      }
    }
  };

  // packages/sdk/src/database.ts
  function normalizeInclude(include) {
    if (!include) return void 0;
    if (typeof include === "string") return { [include]: true };
    if (Array.isArray(include)) {
      const spec = {};
      for (const name of include) if (typeof name === "string" && name) spec[name] = true;
      return Object.keys(spec).length > 0 ? spec : void 0;
    }
    return Object.keys(include).length > 0 ? include : void 0;
  }
  var TableClient = class {
    constructor(client, tableName) {
      this.client = client;
      this.tableName = tableName;
    }
    /**
     * Returns all records. Optionally filter: { where: { status: 'active' }, limit: 20 }.
     * Fetch related rows in the same request with include:
     *   backend.posts.list({ include: ['comments', 'author'] })
     * Relations follow the table's foreign keys — has-many relations attach as
     * arrays, belongs-to relations (e.g. author_id) attach as a single object.
     */
    async list(options) {
      try {
        const projectId = this.client.getProjectId();
        const response = await this.client.request(`/api/v1/${projectId}/database/query`, {
          method: "POST",
          body: JSON.stringify({
            table: this.tableName,
            where: options == null ? void 0 : options.where,
            orderBy: (options == null ? void 0 : options.orderBy) ? { [options.orderBy]: options.order || "asc" } : void 0,
            limit: options == null ? void 0 : options.limit,
            offset: options == null ? void 0 : options.offset,
            include: normalizeInclude(options == null ? void 0 : options.include)
          })
        });
        return unwrapRows(response);
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /** Creates a new record and returns it */
    async create(data) {
      var _a;
      try {
        const projectId = this.client.getProjectId();
        const response = await this.client.request(`/api/v1/${projectId}/database/insert`, {
          method: "POST",
          body: JSON.stringify({ table: this.tableName, data })
        });
        return (_a = response.data) != null ? _a : response;
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /** Returns a single record by id. Pass { include } to attach related rows. */
    async get(id, options) {
      try {
        const projectId = this.client.getProjectId();
        const response = await this.client.request(`/api/v1/${projectId}/database/query`, {
          method: "POST",
          body: JSON.stringify({
            table: this.tableName,
            where: { id },
            limit: 1,
            include: normalizeInclude(options == null ? void 0 : options.include)
          })
        });
        const rows = unwrapRows(response);
        return rows.length > 0 ? rows[0] : null;
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /** Updates a record by id and returns the updated record */
    async update(id, data) {
      var _a;
      try {
        const projectId = this.client.getProjectId();
        const response = await this.client.request(`/api/v1/${projectId}/database/update`, {
          method: "POST",
          body: JSON.stringify({ table: this.tableName, data, where: { id } })
        });
        return (_a = response.data) != null ? _a : response;
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /** Deletes a record by id */
    async delete(id) {
      try {
        const projectId = this.client.getProjectId();
        const response = await this.client.request(`/api/v1/${projectId}/database/delete`, {
          method: "POST",
          body: JSON.stringify({ table: this.tableName, where: { id } })
        });
        return response;
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /** Count records, optionally filtered */
    async count(where) {
      var _a, _b, _c;
      try {
        const projectId = this.client.getProjectId();
        const response = await this.client.request(`/api/v1/${projectId}/database/query`, {
          method: "POST",
          body: JSON.stringify({
            table: this.tableName,
            where,
            limit: 1
          })
        });
        if (typeof response.count === "number") return response.count;
        if (typeof ((_a = response.data) == null ? void 0 : _a.count) === "number") return response.data.count;
        const rows = (_b = response.data) != null ? _b : response;
        if (Array.isArray(rows) && ((_c = rows[0]) == null ? void 0 : _c.count) !== void 0) return Number(rows[0].count);
        return 0;
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /** Advanced: returns a QueryBuilder for complex queries */
    query() {
      return new QueryBuilder(this.client, this.tableName);
    }
    /**
     * Subscribe to live changes on this table.
     *
     * Returns an unsubscribe function — call it to stop receiving events.
     *
     * @example
     * const unsub = backend.messages.subscribe((event) => {
     *   if (event.type === 'insert') addMessage(event.data)
     * })
     * // React useEffect cleanup:
     * return () => unsub()
     */
    subscribe(callback) {
      return this.client.realtime.subscribe(this.tableName, callback);
    }
  };
  function unwrapRows(response) {
    var _a;
    if (Array.isArray(response)) return response;
    if (Array.isArray(response == null ? void 0 : response.data)) return response.data;
    if (Array.isArray((_a = response == null ? void 0 : response.data) == null ? void 0 : _a.data)) return response.data.data;
    return [];
  }
  var QueryBuilder = class {
    constructor(client, table) {
      this.client = client;
      this.selectColumns = void 0;
      this.filters = [];
      this.offsetCount = 0;
      this.orderDirection = "asc";
      this.operation = "select";
      this.tableName = table;
    }
    // SELECT
    select(columns = "*") {
      this.selectColumns = columns === "*" ? void 0 : columns.split(",").map((column) => column.trim()).filter(Boolean);
      this.operation = "select";
      return this;
    }
    // INSERT
    insert(data) {
      this.operation = "insert";
      this.insertData = data;
      return this;
    }
    // UPDATE
    update(data) {
      this.operation = "update";
      this.updateData = data;
      return this;
    }
    // DELETE
    delete() {
      this.operation = "delete";
      return this;
    }
    // FILTERS
    eq(column, value) {
      this.filters.push({ column, operator: "eq", value });
      return this;
    }
    neq(column, value) {
      this.filters.push({ column, operator: "neq", value });
      return this;
    }
    gt(column, value) {
      this.filters.push({ column, operator: "gt", value });
      return this;
    }
    gte(column, value) {
      this.filters.push({ column, operator: "gte", value });
      return this;
    }
    lt(column, value) {
      this.filters.push({ column, operator: "lt", value });
      return this;
    }
    lte(column, value) {
      this.filters.push({ column, operator: "lte", value });
      return this;
    }
    like(column, pattern) {
      this.filters.push({ column, operator: "like", value: pattern });
      return this;
    }
    in(column, values) {
      this.filters.push({ column, operator: "in", value: values });
      return this;
    }
    isNull(column) {
      this.filters.push({ column, operator: "isNull", value: null });
      return this;
    }
    isNotNull(column) {
      this.filters.push({ column, operator: "isNotNull", value: null });
      return this;
    }
    ilike(column, pattern) {
      this.filters.push({ column, operator: "ilike", value: pattern });
      return this;
    }
    search(column, term) {
      this.filters.push({ column, operator: "ilike", value: `%${term}%` });
      return this;
    }
    /**
     * Attach related rows to each result, following the table's foreign keys:
     *   backend.posts.query().include('comments', 'author')
     */
    include(...relations) {
      var _a;
      for (const rel of relations) {
        const spec = normalizeInclude(rel);
        if (spec) this.includeSpec = { ...(_a = this.includeSpec) != null ? _a : {}, ...spec };
      }
      return this;
    }
    // MODIFIERS
    limit(count) {
      this.limitCount = count;
      return this;
    }
    offset(count) {
      this.offsetCount = count;
      return this;
    }
    order(column, options = {}) {
      this.orderByColumn = column;
      this.orderDirection = options.ascending === false ? "desc" : "asc";
      return this;
    }
    // EXECUTION
    buildWhereClause() {
      if (this.filters.length === 0) return void 0;
      const where = {};
      for (const filter of this.filters) {
        if (filter.operator === "eq") {
          where[filter.column] = filter.value;
        } else if (filter.operator === "in") {
          where[filter.column] = { in: filter.value };
        } else if (filter.operator === "gt") {
          where[filter.column] = { gt: filter.value };
        } else if (filter.operator === "gte") {
          where[filter.column] = { gte: filter.value };
        } else if (filter.operator === "lt") {
          where[filter.column] = { lt: filter.value };
        } else if (filter.operator === "lte") {
          where[filter.column] = { lte: filter.value };
        } else if (filter.operator === "neq") {
          where[filter.column] = { not: filter.value };
        } else if (filter.operator === "like") {
          where[filter.column] = { contains: filter.value };
        } else if (filter.operator === "ilike") {
          where[filter.column] = { contains: filter.value, mode: "insensitive" };
        } else if (filter.operator === "isNull") {
          where[filter.column] = null;
        } else if (filter.operator === "isNotNull") {
          where[filter.column] = { not: null };
        }
      }
      return where;
    }
    buildOrderByClause() {
      if (!this.orderByColumn) return void 0;
      return { [this.orderByColumn]: this.orderDirection };
    }
    async execute() {
      try {
        const projectId = this.client.getProjectId();
        if (this.operation === "select") {
          const response = await this.client.request(`/api/v1/${projectId}/database/query`, {
            method: "POST",
            body: JSON.stringify({
              table: this.tableName,
              select: this.selectColumns,
              where: this.buildWhereClause(),
              orderBy: this.buildOrderByClause(),
              limit: this.limitCount,
              offset: this.offsetCount,
              include: this.includeSpec
            })
          });
          return response;
        }
        if (this.operation === "insert") {
          const response = await this.client.request(`/api/v1/${projectId}/database/insert`, {
            method: "POST",
            body: JSON.stringify({
              table: this.tableName,
              data: this.insertData
            })
          });
          return response;
        }
        if (this.operation === "update") {
          const response = await this.client.request(`/api/v1/${projectId}/database/update`, {
            method: "POST",
            body: JSON.stringify({
              table: this.tableName,
              data: this.updateData,
              where: this.buildWhereClause()
            })
          });
          return response;
        }
        if (this.operation === "delete") {
          const response = await this.client.request(`/api/v1/${projectId}/database/delete`, {
            method: "POST",
            body: JSON.stringify({
              table: this.tableName,
              where: this.buildWhereClause()
            })
          });
          return response;
        }
        throw new Error("Invalid operation");
      } catch (error) {
        throw normalizeError(error);
      }
    }
    // Make the query builder thenable so it auto-executes on await
    then(onfulfilled, onrejected) {
      return this.execute().then(onfulfilled, onrejected);
    }
  };

  // packages/sdk/src/storage.ts
  var StorageModule = class {
    constructor(client) {
      this.client = client;
    }
    /**
     * Upload a file to storage.
     *
     * @example
     * // Basic upload
     * const result = await backend.storage.upload(file, 'avatars/user123.jpg')
     *
     * // Upload to specific bucket, auto-convert to WebP
     * const result = await backend.storage.upload(file, 'photos/hero.jpg', {
     *   bucket: 'images',
     *   format: 'webp',
     *   width: 1200,
     *   quality: 85,
     * })
     */
    async upload(file, path, options) {
      var _a;
      try {
        const projectId = this.client.getProjectId();
        const formData = new FormData();
        formData.append("file", file);
        formData.append("bucket", (options == null ? void 0 : options.bucket) || "default");
        formData.append("path", path || file.name);
        if ((options == null ? void 0 : options.isPublic) !== void 0) {
          formData.append("isPublic", String(options.isPublic));
        }
        const apiKey = await this.client.ensureApiKey();
        const userToken = this.client.getUserToken();
        const headers = {};
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }
        if (userToken) {
          headers["X-User-Token"] = userToken;
        }
        const qs = new URLSearchParams();
        if (options == null ? void 0 : options.width) qs.set("width", String(options.width));
        if (options == null ? void 0 : options.height) qs.set("height", String(options.height));
        if (options == null ? void 0 : options.format) qs.set("format", options.format);
        if (options == null ? void 0 : options.quality) qs.set("quality", String(options.quality));
        const query = qs.toString() ? `?${qs.toString()}` : "";
        const response = await fetch(
          `${this.client.getApiUrl()}/api/v1/${projectId}/storage/upload${query}`,
          { method: "POST", headers, body: formData }
        );
        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: "Upload failed" }));
          throw new Error(error.error || error.message || "Upload failed");
        }
        const json = await response.json();
        const data = (_a = json.data) != null ? _a : json;
        return {
          url: data.url,
          path: data.path,
          size: data.size,
          id: data.id,
          contentType: data.contentType
        };
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /**
     * Delete a file by its ID (returned from upload).
     */
    async delete(fileId) {
      var _a, _b;
      try {
        const projectId = this.client.getProjectId();
        const response = await this.client.request(
          `/api/v1/${projectId}/storage/files/${fileId}`,
          { method: "DELETE" }
        );
        const data = (_a = response == null ? void 0 : response.data) != null ? _a : response;
        return { success: (_b = data == null ? void 0 : data.deleted) != null ? _b : true };
      } catch (error) {
        throw normalizeError(error);
      }
    }
    /**
     * Get the URL for a file by its ID.
     * Note: for private files this returns a metadata endpoint —
     * use the `url` returned by `upload()` for direct access.
     */
    getUrl(fileId) {
      const projectId = this.client.getProjectId();
      return `${this.client.getApiUrl()}/api/v1/${projectId}/storage/files/${fileId}`;
    }
  };

  // packages/sdk/src/realtime.ts
  var RealtimeModule = class {
    constructor(client) {
      this.client = client;
      this.es = null;
      this.currentFilter = void 0;
      // Three independent subscriber lists — each gets its own slice of events
      this.dbSubs = [];
      this.presenceSubs = [];
      this.broadcastSubs = [];
      this.reconnectTimer = null;
      this.reconnectAttempt = 0;
      // Fatal = the server refused the stream for a reason retrying can't fix
      // (plan connection cap, revoked API key). Reconnecting would burn a
      // connection slot every few seconds forever.
      this.fatal = false;
    }
    /** Exponential backoff with jitter, 1s → 30s cap. Resets on 'connected'. */
    _backoffMs() {
      const base = Math.min(3e4, 1e3 * Math.pow(2, this.reconnectAttempt));
      return Math.floor(base * (0.75 + Math.random() * 0.5));
    }
    _isFatalError(event) {
      if (event.code === "PLAN_LIMIT_EXCEEDED" || event.code === "INVALID_PROJECT") return true;
      const msg = event.message || "";
      return /reached its limit|api key|unauthor/i.test(msg);
    }
    // ── DB change subscriptions ────────────────────────────────────────────────
    /**
     * Subscribe to INSERT / UPDATE / DELETE events on a table.
     * Pass '*' to receive events from all tables.
     * Returns an unsubscribe function.
     *
     * @example
     * const unsub = backend.realtime.subscribe('messages', (event) => {
     *   if (event.type === 'insert') addMessage(event.data)
     * })
     * return () => unsub()
     */
    subscribe(table, callback) {
      if (typeof window === "undefined") return () => {
      };
      const entry = { table, callback };
      this.dbSubs.push(entry);
      this._connect();
      return () => {
        this.dbSubs = this.dbSubs.filter((s) => s !== entry);
        this._maybeDisconnect();
      };
    }
    // ── Presence subscriptions ─────────────────────────────────────────────────
    /**
     * Subscribe to presence events (join / leave / update).
     * Prefer backend.presence.subscribe() — this is the internal hook.
     */
    onPresence(callback) {
      if (typeof window === "undefined") return () => {
      };
      this.presenceSubs.push(callback);
      this._connect();
      return () => {
        this.presenceSubs = this.presenceSubs.filter((c) => c !== callback);
        this._maybeDisconnect();
      };
    }
    // ── Broadcast subscriptions ────────────────────────────────────────────────
    /**
     * Subscribe to ephemeral broadcast events on a named channel.
     * Prefer backend.onBroadcast() — this is the internal hook.
     *
     * @example
     * const unsub = backend.realtime.onBroadcast('typing', (payload) => {
     *   showTyping(payload.userId as string)
     * })
     */
    onBroadcast(channel, callback) {
      if (typeof window === "undefined") return () => {
      };
      const entry = { channel, callback };
      this.broadcastSubs.push(entry);
      this._connect();
      return () => {
        this.broadcastSubs = this.broadcastSubs.filter((s) => s !== entry);
        this._maybeDisconnect();
      };
    }
    // ── Private: connection management ────────────────────────────────────────
    /** Optimal ?table= filter for the current subscriber set */
    _computeFilter() {
      if (this.presenceSubs.length > 0 || this.broadcastSubs.length > 0) {
        return void 0;
      }
      const tables = Array.from(new Set(this.dbSubs.map((s) => s.table)));
      if (tables.length === 1 && tables[0] !== "*") {
        return tables[0];
      }
      return void 0;
    }
    _sseUrl(filter) {
      const projectId = this.client.getProjectId();
      const base = this.client.getApiUrl();
      const url = new URL(`/api/v1/${projectId}/realtime`, base);
      if (filter) url.searchParams.set("table", filter);
      const apiKey = this.client.getApiKey();
      if (apiKey) url.searchParams.set("apiKey", apiKey);
      return url.toString();
    }
    _connect() {
      if (this.fatal) return;
      if (!this.client.getApiKey()) {
        this.client.ensureApiKey().then(
          () => {
            if (this._hasSubscribers) this._connect();
          },
          () => {
            if (this.fatal || !this._hasSubscribers || this.reconnectTimer) return;
            const delay = this._backoffMs();
            this.reconnectAttempt += 1;
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              this._connect();
            }, delay);
          }
        );
        return;
      }
      const neededFilter = this._computeFilter();
      if (this.es && this.es.readyState !== EventSource.CLOSED && this.currentFilter === neededFilter) {
        return;
      }
      if (this.es && this.es.readyState !== EventSource.CLOSED) {
        this.es.close();
      }
      this.currentFilter = neededFilter;
      this.es = new EventSource(this._sseUrl(neededFilter));
      this.es.onmessage = (msg) => {
        try {
          this._dispatch(JSON.parse(msg.data));
        } catch {
        }
      };
      this.es.onerror = () => {
        var _a;
        (_a = this.es) == null ? void 0 : _a.close();
        this.es = null;
        if (this.fatal) return;
        if (this._hasSubscribers && !this.reconnectTimer) {
          const delay = this._backoffMs();
          this.reconnectAttempt += 1;
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._connect();
          }, delay);
        }
      };
    }
    _disconnect() {
      var _a;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      (_a = this.es) == null ? void 0 : _a.close();
      this.es = null;
      this.currentFilter = void 0;
    }
    _maybeDisconnect() {
      if (!this._hasSubscribers) {
        this._disconnect();
        return;
      }
      const neededFilter = this._computeFilter();
      if (neededFilter !== this.currentFilter) {
        this._connect();
      }
    }
    get _hasSubscribers() {
      return this.dbSubs.length > 0 || this.presenceSubs.length > 0 || this.broadcastSubs.length > 0;
    }
    // ── Private: event dispatch ───────────────────────────────────────────────
    _dispatch(event) {
      const { type } = event;
      if (type === "connected") {
        this.reconnectAttempt = 0;
      }
      if (type === "error" && this._isFatalError(event)) {
        this.fatal = true;
        if (typeof console !== "undefined") {
          console.warn(`[Backenly Realtime] Stream closed permanently: ${event.message}`);
        }
        this._disconnect();
      }
      if (type === "presence") {
        for (const cb of this.presenceSubs) {
          try {
            cb(event);
          } catch {
          }
        }
        return;
      }
      if (type === "broadcast") {
        const be = event;
        for (const sub of this.broadcastSubs) {
          if (sub.channel === be.channel) {
            try {
              sub.callback(be.payload, be);
            } catch {
            }
          }
        }
        return;
      }
      for (const sub of this.dbSubs) {
        const isSystem = type === "connected" || type === "error";
        const isTableMatch = sub.table === "*" || (type === "insert" || type === "update" || type === "delete") && event.table === sub.table;
        if (isSystem || isTableMatch) {
          try {
            sub.callback(event);
          } catch {
          }
        }
      }
    }
  };

  // packages/sdk/src/presence.ts
  var HEARTBEAT_MS = 25e3;
  var PresenceModule = class {
    constructor(client) {
      this.client = client;
      this.userId = null;
      this.metadata = {};
      this.heartbeatTimer = null;
      this.unloadHandler = null;
    }
    // ── Public API ───────────────────────────────────────────────────────────
    /**
     * Announce that this user is online. Starts a heartbeat loop automatically.
     * Attach metadata (name, avatar, role…) for other clients to display.
     * Call leave() when the user logs out or you want to go offline.
     */
    async join(userId, metadata = {}) {
      if (typeof window === "undefined") return;
      if (this.userId && this.userId !== userId) {
        await this.leave();
      }
      this.userId = userId;
      this.metadata = metadata;
      await this._send();
      if (!this.heartbeatTimer) {
        this.heartbeatTimer = setInterval(() => {
          this._send().catch(() => {
          });
        }, HEARTBEAT_MS);
      }
      if (!this.unloadHandler) {
        this.unloadHandler = () => {
          this.leave();
        };
        window.addEventListener("beforeunload", this.unloadHandler, { once: true });
      }
    }
    /**
     * Update presence metadata without changing userId.
     * Useful for updating status, current page, etc.
     */
    async update(metadata) {
      if (!this.userId) return;
      this.metadata = { ...this.metadata, ...metadata };
      await this._send();
    }
    /**
     * Mark this user as offline. Stops heartbeats and notifies all subscribers.
     */
    async leave() {
      const userId = this.userId;
      if (!userId) return;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.unloadHandler) {
        window.removeEventListener("beforeunload", this.unloadHandler);
        this.unloadHandler = null;
      }
      this.userId = null;
      this.metadata = {};
      try {
        const projectId = this.client.getProjectId();
        const apiUrl = this.client.getApiUrl();
        const apiKey = this.client.getApiKey();
        const userToken = this.client.getUserToken();
        const headers = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        if (userToken) headers["X-User-Token"] = userToken;
        await fetch(
          `${apiUrl}/api/v1/${projectId}/presence?userId=${encodeURIComponent(userId)}`,
          {
            method: "DELETE",
            keepalive: true,
            headers
          }
        );
      } catch {
      }
    }
    /**
     * Get the current list of online users (lastSeen within TTL).
     */
    async list() {
      var _a;
      const projectId = this.client.getProjectId();
      const res = await this.client.request(`/api/v1/${projectId}/presence`);
      return (_a = res.users) != null ? _a : [];
    }
    /**
     * Subscribe to live presence events (join / leave / update).
     * Returns an unsubscribe function.
     *
     * @example
     * const unsub = backend.presence.subscribe((event) => {
     *   if (event.event === 'join') showAvatar(event.userId)
     * })
     * // React cleanup:
     * return () => unsub()
     */
    subscribe(callback) {
      return this.client.realtime.onPresence(callback);
    }
    // ── Private ──────────────────────────────────────────────────────────────
    async _send() {
      if (!this.userId) return;
      const projectId = this.client.getProjectId();
      const apiUrl = this.client.getApiUrl();
      const apiKey = await this.client.ensureApiKey().catch(() => this.client.getApiKey());
      const userToken = this.client.getUserToken();
      await fetch(`${apiUrl}/api/v1/${projectId}/presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          ...userToken ? { "X-User-Token": userToken } : {}
        },
        body: JSON.stringify({ userId: this.userId, metadata: this.metadata })
      });
    }
  };

  // packages/sdk/src/client.ts
  var BackenlyClient = class {
    constructor(config) {
      this.apiKey = null;
      this.userToken = null;
      this.bootstrapPromise = null;
      // Cached module instances (lazy)
      this.tableClientCache = {};
      this._realtime = null;
      this._presence = null;
      var _a;
      if (!config.projectId) {
        throw new Error("projectId is required");
      }
      this.projectId = config.projectId;
      this.apiUrl = config.apiUrl || typeof process !== "undefined" && ((_a = process.env) == null ? void 0 : _a.NEXT_PUBLIC_BACKENLY_URL) || "https://backenly.com";
      if (config.apiKey) {
        this.apiKey = config.apiKey;
      }
      if (typeof window !== "undefined") {
        const savedToken = localStorage.getItem("backenly_token");
        if (savedToken) {
          this.userToken = savedToken;
        }
      }
      if (!this.apiKey && typeof window !== "undefined") {
        this.ensureApiKey().catch(() => {
        });
      }
      return new Proxy(this, {
        get(target, prop) {
          if (prop in target) {
            const val = target[prop];
            return typeof val === "function" ? val.bind(target) : val;
          }
          if (typeof prop === "string") {
            if (!target.tableClientCache[prop]) {
              target.tableClientCache[prop] = new TableClient(target, prop);
            }
            return target.tableClientCache[prop];
          }
          return void 0;
        }
      });
    }
    // ── Standard modules ──────────────────────────────────────────────────────
    get auth() {
      return new AuthModule(this);
    }
    get storage() {
      return new StorageModule(this);
    }
    // ── Realtime modules (singletons) ─────────────────────────────────────────
    /** Low-level realtime access. Prefer backend.messages.subscribe() for DB events. */
    get realtime() {
      if (!this._realtime) {
        this._realtime = new RealtimeModule(this);
      }
      return this._realtime;
    }
    /**
     * Presence — who is online right now.
     *
     * @example
     * await backend.presence.join('user-123', { name: 'Ajay' })
     * const unsub = backend.presence.subscribe((event) => {
     *   if (event.event === 'join')  addAvatar(event.userId)
     *   if (event.event === 'leave') removeAvatar(event.userId)
     * })
     * const users = await backend.presence.list()
     * await backend.presence.leave()
     */
    get presence() {
      if (!this._presence) {
        this._presence = new PresenceModule(this);
      }
      return this._presence;
    }
    // ── Broadcast ─────────────────────────────────────────────────────────────
    /**
     * Fire an ephemeral broadcast event to all connected clients.
     * Nothing is written to the database — purely in-memory fan-out via pg_notify.
     *
     * @example
     * // Typing indicator
     * backend.broadcast('typing', { userId: 'u1', room: 'general' })
     *
     * // Custom cursor position
     * backend.broadcast('cursor', { userId: 'u1', x: 120, y: 340 })
     */
    async broadcast(channel, payload = {}) {
      await this.request(`/api/v1/${this.projectId}/broadcast`, {
        method: "POST",
        body: JSON.stringify({ channel, payload })
      });
    }
    /**
     * Subscribe to broadcast events on a named channel.
     * Returns an unsubscribe function.
     *
     * @example
     * const unsub = backend.onBroadcast('typing', (payload) => {
     *   showTypingIndicator(payload.userId as string)
     * })
     * // React cleanup:
     * return () => unsub()
     */
    onBroadcast(channel, callback) {
      return this.realtime.onBroadcast(channel, callback);
    }
    // ── Advanced query builder ────────────────────────────────────────────────
    from(table) {
      return new QueryBuilder(this, table);
    }
    // ── Token management ──────────────────────────────────────────────────────
    setAuthToken(token) {
      this.setUserToken(token);
    }
    setUserToken(token) {
      this.userToken = token;
      if (typeof window !== "undefined") {
        if (token) {
          localStorage.setItem("backenly_token", token);
        } else {
          localStorage.removeItem("backenly_token");
        }
      }
    }
    getAuthToken() {
      return this.getUserToken();
    }
    getUserToken() {
      return this.userToken;
    }
    getApiKey() {
      return this.apiKey;
    }
    /**
     * Resolve the API key, auto-fetching the project's public anon key via the
     * bootstrap handshake when createClient() was called without one.
     *
     * The handshake runs once per client — concurrent callers share the same
     * in-flight promise — and a failed attempt resets it so the next call
     * retries instead of poisoning the client forever.
     */
    async ensureApiKey() {
      if (this.apiKey) return this.apiKey;
      if (!this.bootstrapPromise) {
        this.bootstrapPromise = this.fetchAnonKey();
      }
      try {
        const key = await this.bootstrapPromise;
        this.apiKey = key;
        return key;
      } catch (error) {
        this.bootstrapPromise = null;
        throw error;
      }
    }
    async fetchAnonKey() {
      var _a, _b, _c, _d, _e, _f;
      let response;
      try {
        response = await fetch(`${this.apiUrl}/api/v1/${this.projectId}/bootstrap`, {
          method: "GET",
          headers: { Accept: "application/json" }
        });
      } catch {
        throw new BackenlyError(
          `Could not reach ${this.apiUrl} to auto-fetch the project's anon key. Check your network, or pass apiKey to createClient() explicitly.`,
          "BOOTSTRAP_UNREACHABLE"
        );
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new BackenlyError(
          (_b = (_a = body == null ? void 0 : body.error) == null ? void 0 : _a.message) != null ? _b : `Bootstrap handshake failed with HTTP ${response.status}`,
          (_d = (_c = body == null ? void 0 : body.error) == null ? void 0 : _c.code) != null ? _d : "BOOTSTRAP_FAILED",
          response.status
        );
      }
      const anonKey = (_f = (_e = body == null ? void 0 : body.data) == null ? void 0 : _e.anonKey) != null ? _f : body == null ? void 0 : body.anonKey;
      if (typeof anonKey !== "string" || anonKey.length === 0) {
        throw new BackenlyError(
          "Bootstrap handshake returned no anon key. Generate one from the Connect Frontend page, or pass apiKey to createClient() explicitly.",
          "BOOTSTRAP_FAILED"
        );
      }
      return anonKey;
    }
    getProjectId() {
      return this.projectId;
    }
    getApiUrl() {
      return this.apiUrl;
    }
    // ── Internal HTTP ─────────────────────────────────────────────────────────
    async request(endpoint, options) {
      if (!this.apiKey && !(options == null ? void 0 : options.skipAuth)) {
        await this.ensureApiKey();
      }
      const headers = {
        "Content-Type": "application/json"
      };
      if (this.apiKey && !(options == null ? void 0 : options.skipAuth)) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }
      if (this.userToken && !(options == null ? void 0 : options.skipAuth)) {
        headers["X-User-Token"] = this.userToken;
      }
      if (options == null ? void 0 : options.headers) {
        Object.entries(options.headers).forEach(
          ([key, value]) => {
            headers[key] = value;
          }
        );
      }
      try {
        const { skipAuth: _skipAuth, ...fetchOptions } = options != null ? options : {};
        const response = await fetch(`${this.apiUrl}${endpoint}`, {
          ...fetchOptions,
          headers
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({
            error: `Request failed with status ${response.status}`
          }));
          body.status = response.status;
          throw normalizeError(body);
        }
        return response.json();
      } catch (error) {
        throw normalizeError(error);
      }
    }
  };

  // packages/sdk/src/typed.ts
  function createTypedClient(config) {
    return new BackenlyClient(config);
  }

  // packages/sdk/src/supabase-compat.ts
  function err(message, code = "BACKENLY_COMPAT", hint = null) {
    return { message, code, details: null, hint };
  }
  function fromException(e) {
    var _a;
    const m = e instanceof Error ? e.message : String(e);
    return { message: m, code: (_a = e == null ? void 0 : e.code) != null ? _a : "BACKENLY_ERROR", details: null, hint: null };
  }
  var CompatQueryBuilder = class {
    constructor(backend, tableName) {
      this.backend = backend;
      this.tableName = tableName;
      this.mode = "select";
      this.where = {};
      this.payload = null;
      this.orderBy = null;
      this.limitN = null;
      this.offsetN = null;
      this.wantSingle = null;
      this.wantCount = false;
      this.returnRows = true;
      this.unsupported = null;
    }
    // ── verbs ────────────────────────────────────────────────────────────────────
    select(columns, opts) {
      if (columns && columns.trim() !== "*" && columns.trim() !== "") {
        if (/[(,]/.test(columns) && columns.includes("(")) {
          this.unsupported = `Foreign-table embeds in select("${columns}") are not supported by the compat shim. Use the Backenly SDK's include option instead: backend.${this.tableName}.list({ include: [...] }).`;
        }
      }
      if (opts == null ? void 0 : opts.count) this.wantCount = true;
      if (opts == null ? void 0 : opts.head) this.returnRows = false;
      return this;
    }
    insert(values) {
      this.mode = "insert";
      this.payload = values;
      return this;
    }
    upsert(values, _opts) {
      this.mode = "insert";
      this.payload = values;
      return this;
    }
    update(values) {
      this.mode = "update";
      this.payload = values;
      return this;
    }
    delete() {
      this.mode = "delete";
      return this;
    }
    // ── filters (map to Backenly where-operators) ───────────────────────────────
    eq(column, value) {
      this.where[column] = value;
      return this;
    }
    neq(column, value) {
      this.mergeOp(column, { not: value });
      return this;
    }
    gt(column, value) {
      this.mergeOp(column, { gt: value });
      return this;
    }
    gte(column, value) {
      this.mergeOp(column, { gte: value });
      return this;
    }
    lt(column, value) {
      this.mergeOp(column, { lt: value });
      return this;
    }
    lte(column, value) {
      this.mergeOp(column, { lte: value });
      return this;
    }
    in(column, values) {
      this.mergeOp(column, { in: values });
      return this;
    }
    /** like/ilike → Backenly `contains` (ILIKE %…%). Leading/trailing % stripped. */
    like(column, pattern) {
      return this.ilike(column, pattern);
    }
    ilike(column, pattern) {
      this.mergeOp(column, { contains: pattern.replace(/^%|%$/g, "") });
      return this;
    }
    is(column, value) {
      if (value === null) this.where[column] = null;
      else this.where[column] = value;
      return this;
    }
    or(_filters) {
      this.unsupported = "The .or() filter string is not supported by the compat shim (Backenly composes AND filters). Split the query, or use the Backenly SDK directly.";
      return this;
    }
    // ── modifiers ────────────────────────────────────────────────────────────────
    order(column, opts) {
      this.orderBy = { column, ascending: (opts == null ? void 0 : opts.ascending) !== false };
      return this;
    }
    limit(n) {
      this.limitN = n;
      return this;
    }
    range(from, to) {
      this.offsetN = from;
      this.limitN = to - from + 1;
      return this;
    }
    single() {
      this.wantSingle = "strict";
      return this;
    }
    maybeSingle() {
      this.wantSingle = "maybe";
      return this;
    }
    // ── execution ────────────────────────────────────────────────────────────────
    then(onfulfilled, onrejected) {
      return this.execute().then(onfulfilled != null ? onfulfilled : void 0, onrejected != null ? onrejected : void 0);
    }
    mergeOp(column, op) {
      const existing = this.where[column];
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        this.where[column] = { ...existing, ...op };
      } else {
        this.where[column] = op;
      }
    }
    async execute() {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
      if (this.unsupported) {
        return { data: null, error: err(this.unsupported, "UNSUPPORTED"), count: null, status: 400, statusText: "Bad Request" };
      }
      const projectId = this.backend.getProjectId();
      try {
        if (this.mode === "select") {
          const body = {
            table: this.tableName,
            where: Object.keys(this.where).length ? this.where : void 0,
            orderBy: this.orderBy ? { [this.orderBy.column]: this.orderBy.ascending ? "asc" : "desc" } : void 0,
            limit: this.wantSingle ? 2 : (_a = this.limitN) != null ? _a : void 0,
            offset: (_b = this.offsetN) != null ? _b : void 0
          };
          const res2 = await this.backend.request(`/api/v1/${projectId}/database/query`, {
            method: "POST",
            body: JSON.stringify(body)
          });
          const rows = Array.isArray(res2) ? res2 : Array.isArray(res2 == null ? void 0 : res2.data) ? res2.data : Array.isArray((_c = res2 == null ? void 0 : res2.data) == null ? void 0 : _c.data) ? res2.data.data : [];
          const count = (_g = (_f = (_d = res2 == null ? void 0 : res2.data) == null ? void 0 : _d.count) != null ? _f : (_e = res2 == null ? void 0 : res2.meta) == null ? void 0 : _e.total) != null ? _g : null;
          if (this.wantSingle) {
            if (rows.length === 0) {
              return this.wantSingle === "strict" ? { data: null, error: err("JSON object requested, multiple (or no) rows returned", "PGRST116", "single() found 0 rows"), count, status: 406, statusText: "Not Acceptable" } : { data: null, error: null, count, status: 200, statusText: "OK" };
            }
            return { data: rows[0], error: null, count, status: 200, statusText: "OK" };
          }
          return { data: this.returnRows ? rows : null, error: null, count: this.wantCount ? count : null, status: 200, statusText: "OK" };
        }
        if (this.mode === "insert") {
          const res2 = await this.backend.request(`/api/v1/${projectId}/database/insert`, {
            method: "POST",
            body: JSON.stringify({ table: this.tableName, data: this.payload })
          });
          const data2 = (_h = res2 == null ? void 0 : res2.data) != null ? _h : res2;
          return { data: data2, error: null, count: null, status: 201, statusText: "Created" };
        }
        if (this.mode === "update") {
          if (Object.keys(this.where).length === 0) {
            return { data: null, error: err('update() requires at least one filter (e.g. .eq("id", \u2026)) \u2014 unfiltered updates are refused', "NO_FILTER"), count: null, status: 400, statusText: "Bad Request" };
          }
          const res2 = await this.backend.request(`/api/v1/${projectId}/database/update`, {
            method: "POST",
            body: JSON.stringify({ table: this.tableName, data: this.payload, where: this.where })
          });
          const data2 = (_i = res2 == null ? void 0 : res2.data) != null ? _i : res2;
          return { data: data2, error: null, count: null, status: 200, statusText: "OK" };
        }
        if (Object.keys(this.where).length === 0) {
          return { data: null, error: err('delete() requires at least one filter (e.g. .eq("id", \u2026)) \u2014 unfiltered deletes are refused', "NO_FILTER"), count: null, status: 400, statusText: "Bad Request" };
        }
        const res = await this.backend.request(`/api/v1/${projectId}/database/delete`, {
          method: "POST",
          body: JSON.stringify({ table: this.tableName, where: this.where })
        });
        const data = (_j = res == null ? void 0 : res.data) != null ? _j : null;
        return { data, error: null, count: null, status: 200, statusText: "OK" };
      } catch (e) {
        return { data: null, error: fromException(e), count: null, status: 400, statusText: "Bad Request" };
      }
    }
  };
  var CompatAuth = class {
    constructor(backend) {
      this.backend = backend;
    }
    async signUp(opts) {
      try {
        const res = await this.backend.auth.signUp({ email: opts.email, password: opts.password });
        return this.sessionResult(res);
      } catch (e) {
        return { data: { user: null, session: null }, error: fromException(e) };
      }
    }
    async signInWithPassword(opts) {
      try {
        const res = await this.backend.auth.signIn({ email: opts.email, password: opts.password });
        return this.sessionResult(res);
      } catch (e) {
        return { data: { user: null, session: null }, error: fromException(e) };
      }
    }
    async signOut() {
      try {
        await this.backend.auth.logout();
        return { error: null };
      } catch (e) {
        return { error: fromException(e) };
      }
    }
    async getUser() {
      try {
        const user = await this.backend.auth.getUser();
        return { data: { user: user != null ? user : null }, error: null };
      } catch (e) {
        return { data: { user: null }, error: fromException(e) };
      }
    }
    async getSession() {
      var _a, _b, _c;
      try {
        const token = (_c = (_b = (_a = this.backend).getUserToken) == null ? void 0 : _b.call(_a)) != null ? _c : null;
        if (!token) return { data: { session: null }, error: null };
        const user = await this.backend.auth.getUser();
        const session = user ? { access_token: token, token_type: "bearer", user } : null;
        return { data: { session }, error: null };
      } catch (e) {
        return { data: { session: null }, error: fromException(e) };
      }
    }
    sessionResult(res) {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i;
      const user = (_c = (_b = res == null ? void 0 : res.user) != null ? _b : (_a = res == null ? void 0 : res.data) == null ? void 0 : _a.user) != null ? _c : null;
      const token = (_i = (_h = (_e = res == null ? void 0 : res.token) != null ? _e : (_d = res == null ? void 0 : res.data) == null ? void 0 : _d.token) != null ? _h : (_g = (_f = this.backend).getUserToken) == null ? void 0 : _g.call(_f)) != null ? _i : null;
      const session = token ? { access_token: token, token_type: "bearer", user } : null;
      return { data: { user, session }, error: null };
    }
  };
  var CompatChannel = class {
    constructor(backend, name) {
      this.backend = backend;
      this.name = name;
      this.unsubs = [];
      this.pending = [];
    }
    on(type, filter, callback) {
      var _a;
      if (type !== "postgres_changes" || !(filter == null ? void 0 : filter.table)) return this;
      this.pending.push({ table: filter.table, event: ((_a = filter.event) != null ? _a : "*").toUpperCase(), cb: callback });
      return this;
    }
    subscribe(statusCallback) {
      for (const p of this.pending) {
        const tableClient = this.backend[p.table];
        const unsub = tableClient.subscribe((evt) => {
          var _a, _b, _c, _d, _e, _f;
          const eventType = String((_b = (_a = evt.event) != null ? _a : evt.type) != null ? _b : "").toUpperCase();
          if (p.event !== "*" && p.event !== eventType) return;
          p.cb({
            eventType,
            new: (_d = (_c = evt.row) != null ? _c : evt.new) != null ? _d : null,
            old: (_f = (_e = evt.oldRow) != null ? _e : evt.old) != null ? _f : null,
            table: p.table,
            schema: "public"
          });
        });
        this.unsubs.push(unsub);
      }
      statusCallback == null ? void 0 : statusCallback("SUBSCRIBED");
      return this;
    }
    unsubscribe() {
      for (const u of this.unsubs.splice(0)) {
        try {
          u();
        } catch {
        }
      }
    }
  };
  var CompatStorage = class {
    constructor(backend) {
      this.backend = backend;
    }
    from(_bucket) {
      const backend = this.backend;
      return {
        async upload(_path, file) {
          var _a, _b, _c;
          try {
            const res = await backend.storage.upload(file);
            const id = (_c = (_b = res == null ? void 0 : res.id) != null ? _b : (_a = res == null ? void 0 : res.data) == null ? void 0 : _a.id) != null ? _c : null;
            return { data: { path: id, id, fullPath: id }, error: null };
          } catch (e) {
            return { data: null, error: fromException(e) };
          }
        },
        getPublicUrl(path) {
          var _a, _b, _c;
          const url = (_c = (_b = (_a = backend.storage).getFileUrl) == null ? void 0 : _b.call(_a, path)) != null ? _c : null;
          return { data: { publicUrl: url } };
        },
        async remove(paths) {
          var _a, _b;
          try {
            for (const p of paths) await ((_b = (_a = backend.storage).delete) == null ? void 0 : _b.call(_a, p));
            return { data: paths.map((p) => ({ name: p })), error: null };
          } catch (e) {
            return { data: null, error: fromException(e) };
          }
        }
      };
    }
  };
  var BackenlySupabaseCompat = class {
    constructor(backend) {
      this.backend = backend;
      this.channels = [];
      this.auth = new CompatAuth(backend);
      this.storage = new CompatStorage(backend);
    }
    from(table) {
      return new CompatQueryBuilder(this.backend, table);
    }
    channel(name) {
      const ch = new CompatChannel(this.backend, name);
      this.channels.push(ch);
      return ch;
    }
    removeChannel(ch) {
      ch.unsubscribe();
      this.channels = this.channels.filter((c) => c !== ch);
    }
    async rpc(fn) {
      return {
        data: null,
        error: err(
          `rpc("${fn}") is not supported \u2014 Backenly has no exposed SQL functions by design. Create an HTTP AI function in the Backenly dashboard and call it via fetch instead.`,
          "UNSUPPORTED"
        ),
        count: null,
        status: 400,
        statusText: "Bad Request"
      };
    }
    /** Escape hatch to the full Backenly SDK for anything the shim doesn't cover. */
    get backenly() {
      return this.backend;
    }
  };
  function createClient(url, anonKey) {
    const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!m) {
      throw new Error(
        "createClient: could not find a Backenly project id in the URL. Use the shape createClient('https://backenly.com/api/v1/<PROJECT_ID>', '<BACKENLY_ANON_KEY>') \u2014 copy it from your project \u2192 Connect \u2192 Frontend SDK."
      );
    }
    const origin = new URL(url).origin;
    const backend = new BackenlyClient({ projectId: m[0], apiKey: anonKey, apiUrl: origin });
    return new BackenlySupabaseCompat(backend);
  }

  // packages/sdk/src/index.ts
  function createClient2(config) {
    return new BackenlyClient(config);
  }
  return __toCommonJS(index_exports);
})();

;(function (g) {
  if (!g) return
  g.Backenly = Backenly
  g.createClient = Backenly.createClient
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : undefined)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Backenly
  module.exports.default = Backenly
}

