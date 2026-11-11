/**
 * TWILIO'S CREDENTIAL, AS FUNCTIONS USE IT
 * ========================================
 * A function sends SMS through ctx.integrations.twilio.sendSms, which needs
 * three things: the Account SID and auth token that authenticate the call, and
 * the number the message is sent from. They are stored as one vault value,
 * `accountSid:authToken:fromNumber` (lib/services/ai-functions/integration-context.ts
 * reads it), and the console asks for exactly that.
 *
 * The agent's connect asked for "AC... (Account SID) + auth token", with no
 * sending number and no format, and nothing checked what was stored. Whatever
 * arrived was filed as connected, the generator told new functions to call
 * twilio.sendSms, and the runtime, which skipped any value without three
 * parts, left ctx.integrations.twilio undefined: every SMS function threw a
 * TypeError. Every way of storing the key now checks the value against this
 * shape first (lib/services/integrationKeyStore.ts).
 */

export const TWILIO_CREDENTIAL_SHAPE = 'accountSid:authToken:fromNumber'

export interface TwilioCredential {
  accountSid: string
  authToken: string
  fromNumber: string
}

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i
const AUTH_TOKEN = /^[0-9a-f]{32}$/i
/** A phone number in E.164 form, a short code, or an alphanumeric sender ID: what Twilio takes as From. */
const SENDER = /^(\+[1-9]\d{6,14}|\d{5,6}|(?=[A-Za-z0-9 ]*[A-Za-z])[A-Za-z0-9 ]{1,11})$/

/**
 * The three parts as the runtime reads them, or null when one is missing. It
 * does not judge them: a stored value Twilio refuses is Twilio's to refuse.
 */
export function twilioCredentialParts(raw: string | null | undefined): TwilioCredential | null {
  const parts = String(raw ?? '').split(':').map((part) => part.trim())
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !part)) return null
  return { accountSid: parts[0], authToken: parts[1], fromNumber: parts[2] }
}

/**
 * What is wrong with a value offered as Twilio's credential, in a sentence
 * that says what to give instead, or null when it is what Twilio takes.
 */
export function twilioCredentialProblem(raw: string): string | null {
  const parts = String(raw ?? '').split(':').map((part) => part.trim())
  if (parts.length !== 3) {
    return (
      `Twilio's credential is three values, stored as ${TWILIO_CREDENTIAL_SHAPE}: the Account SID, the auth token ` +
      'and the number SMS is sent from, all in the Twilio Console (e.g. AC…:your-auth-token:+15550001111). ' +
      `This value has ${parts.length === 1 ? 'one part' : `${parts.length} parts`}.`
    )
  }
  const [accountSid, authToken, fromNumber] = parts
  if (!ACCOUNT_SID.test(accountSid)) {
    return 'The Twilio Account SID is AC followed by 32 hexadecimal characters, as the Twilio Console shows it under Account Info.'
  }
  if (!AUTH_TOKEN.test(authToken)) {
    return 'The Twilio auth token is 32 hexadecimal characters, as the Twilio Console shows it under Account Info.'
  }
  if (!SENDER.test(fromNumber)) {
    return (
      'The number SMS is sent from must be a Twilio number in E.164 form (e.g. +15550001111), a short code, ' +
      'or an alphanumeric sender ID of up to 11 letters and digits.'
    )
  }
  return null
}

/**
 * The stored value for a credential given as its three parts, or null when
 * none of them was given. A part left out stays empty, so the check names it.
 */
export function joinTwilioCredential(parts: { accountSid?: unknown; authToken?: unknown; fromNumber?: unknown }): string | null {
  const values = [parts.accountSid, parts.authToken, parts.fromNumber].map((v) => (v === undefined || v === null ? '' : String(v).trim()))
  if (values.every((v) => !v)) return null
  return values.join(':')
}
