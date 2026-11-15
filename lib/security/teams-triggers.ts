/**
 * THE TEAMS RULES' TRIGGERS
 * =========================
 *
 * The SQL of the two triggers the teams rules put on a project's teams tables
 * (organizations: ids are the server's; organization_invitations: tokens kept
 * as hashes), and their names. Pure: it depends on the service-role clause
 * alone, so lib/security/planted-objects.ts can compare a function found in a
 * workspace with the one Backenly installs there without importing the RLS
 * service (lib/services/workspace-rls.ts installs them and re-exports these).
 */

import { serviceRoleClause } from '@/lib/postgrest/rls-translation'
import type { TeamsTable } from '@/lib/services/rls-ownership'

/**
 * The mark an invitation accepted before its table hashed tokens carries in
 * place of its token (withdrawPreRuleInvitations): `pre-rule:<id>`. Only the
 * service role writes it, so a row bearing it was there before the teams rules,
 * and a row without it, in a schema that holds them, was written under them.
 */
export const PRE_RULE_MARK = 'pre-rule:'

/**
 * The trigger the teams rules put on organizations (ids are the server's) or on
 * organization_invitations (tokens kept as hashes); organization_members has
 * none. Separate from the policies so the invitations written before the token
 * trigger can be withdrawn between the two (installTeamsPolicy).
 *
 * A token must be random: the trigger checks its length and its characters,
 * never whether someone could guess it, so `aaaa…` passes. Generate it with a
 * cryptographic random generator (crypto.randomBytes(16).toString('hex') in
 * Node, crypto.getRandomValues in a browser), as enable_teams' flow says. A
 * guessed token still admits only the address it was sent to.
 */
export function teamsTriggerSql(schemaName: string, tableName: TeamsTable): string {
  const svc = serviceRoleClause(schemaName)
  const t = `"${schemaName}"."${tableName}"`
  const fn = (name: string) => `"${schemaName}"."${name}"`

  switch (tableName) {
    case 'organizations':
      return `
        CREATE OR REPLACE FUNCTION ${fn(TEAMS_TRIGGERS.organizations)}() RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog
        AS $teams$
        BEGIN
          IF ${svc} THEN
            RETURN NEW;
          END IF;
          IF TG_OP = 'INSERT' THEN
            NEW."id" := gen_random_uuid();
          ELSIF NEW."id" IS DISTINCT FROM OLD."id" THEN
            RAISE EXCEPTION 'an organization''s id is chosen by the server and cannot be changed' USING ERRCODE = '42501';
          END IF;
          RETURN NEW;
        END
        $teams$;

        DROP TRIGGER IF EXISTS ${TEAMS_TRIGGERS.organizations} ON ${t};

        CREATE TRIGGER ${TEAMS_TRIGGERS.organizations}
          BEFORE INSERT OR UPDATE OF "id" ON ${t}
          FOR EACH ROW EXECUTE FUNCTION ${fn(TEAMS_TRIGGERS.organizations)}();
      `
    case 'organization_members':
      return ''
    case 'organization_invitations':
      // A hash, or the mark an invitation accepted before these rules carries,
      // is the service role's alone to write.
      return `
        CREATE OR REPLACE FUNCTION ${fn(TEAMS_TRIGGERS.organization_invitations)}() RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog
        AS $teams$
        BEGIN
          IF NEW."token" IS NULL THEN
            RETURN NEW;
          END IF;
          IF NEW."token" ~ '^sha256:[0-9a-f]{64}$' OR starts_with(NEW."token", '${PRE_RULE_MARK}') THEN
            IF ${svc} THEN
              RETURN NEW;
            END IF;
            RAISE EXCEPTION 'send the invitation token itself: only its hash is kept' USING ERRCODE = '22023';
          END IF;
          -- PostgreSQL's regular expressions refuse a repetition count above 255, so the length is checked apart.
          IF length(NEW."token") NOT BETWEEN 32 AND 512 OR NEW."token" !~ '^[A-Za-z0-9_-]+$' THEN
            RAISE EXCEPTION 'an invitation token is 32 to 512 characters of A-Z, a-z, 0-9, - and _ (16 random bytes in hex, or 24 in base64url)' USING ERRCODE = '22023';
          END IF;
          NEW."token" := 'sha256:' || encode(sha256(convert_to(NEW."token", 'UTF8')), 'hex');
          RETURN NEW;
        END
        $teams$;

        DROP TRIGGER IF EXISTS ${TEAMS_TRIGGERS.organization_invitations} ON ${t};

        CREATE TRIGGER ${TEAMS_TRIGGERS.organization_invitations}
          BEFORE INSERT OR UPDATE OF "token" ON ${t}
          FOR EACH ROW EXECUTE FUNCTION ${fn(TEAMS_TRIGGERS.organization_invitations)}();
      `
  }
}

/**
 * The triggers the teams rules put on two of the tables (teamsTriggerSql), by
 * table: the organization's id, and the invitation's token.
 */
export const TEAMS_TRIGGERS = {
  organizations: 'backenly_teams_organization_id',
  organization_invitations: 'backenly_teams_invitation_token',
} as const

/** The function names of TEAMS_TRIGGERS (each trigger runs the function of its own name). */
const TEAMS_FUNCTION_TABLE: Record<string, TeamsTable> = {
  [TEAMS_TRIGGERS.organizations]: 'organizations',
  [TEAMS_TRIGGERS.organization_invitations]: 'organization_invitations',
}

/** The table a teams trigger of this name belongs on, or null when the name is not one of them. */
export function teamsTriggerTable(name: string): TeamsTable | null {
  return TEAMS_FUNCTION_TABLE[name] ?? null
}

/**
 * The exact body (pg_proc.prosrc) of the teams function `name` that
 * teamsTriggerSql installs in `schemaName`, or null when `name` is not one.
 */
export function teamsTriggerBody(schemaName: string, name: string): string | null {
  const table = teamsTriggerTable(name)
  if (!table) return null
  const sql = teamsTriggerSql(schemaName, table)
  const open = sql.indexOf('AS $teams$')
  const close = sql.indexOf('$teams$;', open + 1)
  if (open < 0 || close < 0) return null
  return sql.slice(open + 'AS $teams$'.length, close)
}
