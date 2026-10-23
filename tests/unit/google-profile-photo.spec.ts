/**
 * The console avatar shows a Google account's photo only when the person chose
 * it (lib/auth/oauth/google-photo.ts). Google hands every account a picture,
 * the letter it generates included, so the People API's `default` flag is the
 * whole decision, and nothing but Google's own photo host reaches an <img>.
 *
 * Both halves are asserted throughout: what is accepted, and what is refused.
 */
import { fetchGoogleProfilePhoto, googleProfilePhoto } from '@/lib/auth/oauth/google-photo'

const OWN = 'https://lh3.googleusercontent.com/a/ACg8ocOwnPhoto=s100'
const LETTER = 'https://lh3.googleusercontent.com/a/ACg8ocGeneratedLetter=s100'

const primary = (photo: Record<string, unknown>) => ({ photos: [{ metadata: { primary: true }, ...photo }] })

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe('googleProfilePhoto', () => {
  it('takes the photo the person chose', () => {
    // The People API omits `default` when it is false.
    expect(googleProfilePhoto(primary({ url: OWN }))).toBe(OWN)
    expect(googleProfilePhoto(primary({ url: OWN, default: false }))).toBe(OWN)
  })

  it('refuses the letter Google draws for an account with no photo', () => {
    expect(googleProfilePhoto(primary({ url: LETTER, default: true }))).toBeNull()
    expect(googleProfilePhoto(primary({ url: LETTER, default: 'true' }))).toBeNull()
  })

  it('reads the primary photo, which is the one Google shows', () => {
    expect(
      googleProfilePhoto({ photos: [{ metadata: {}, url: LETTER, default: true }, { metadata: { primary: true }, url: OWN }] }),
    ).toBe(OWN)
    expect(
      googleProfilePhoto({ photos: [{ metadata: {}, url: OWN }, { metadata: { primary: true }, url: LETTER, default: true }] }),
    ).toBeNull()
  })

  it('refuses any address that is not Google’s photo host over https', () => {
    for (const url of [
      'http://lh3.googleusercontent.com/a/ACg8ocOwnPhoto=s100',
      'https://example.com/photo.png',
      'https://lh3.googleusercontent.com.example.com/a/x',
      'javascript:alert(1)',
      'not a url',
      `https://lh3.googleusercontent.com/a/${'x'.repeat(2048)}`,
      42,
      undefined,
    ]) {
      expect(googleProfilePhoto(primary({ url }))).toBeNull()
    }
  })

  it('answers no photo for a response without one, rather than inventing one', () => {
    expect(googleProfilePhoto({})).toBeNull()
    expect(googleProfilePhoto({ photos: [] })).toBeNull()
    expect(googleProfilePhoto({ photos: [null] })).toBeNull()
    expect(googleProfilePhoto(null)).toBeNull()
  })
})

describe('fetchGoogleProfilePhoto', () => {
  const realFetch = global.fetch
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    global.fetch = realFetch
    jest.restoreAllMocks()
  })

  it('asks the People API for the signed-in account’s photos with its token', async () => {
    global.fetch = jest.fn().mockResolvedValue(json(200, primary({ url: OWN })))
    expect(await fetchGoogleProfilePhoto('access-token')).toBe(OWN)
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toBe('https://people.googleapis.com/v1/people/me?personFields=photos')
    expect(init.headers).toEqual({ Authorization: 'Bearer access-token' })
  })

  it('answers null for Google’s letter, so a removed photo is forgotten', async () => {
    global.fetch = jest.fn().mockResolvedValue(json(200, primary({ url: LETTER, default: true })))
    expect(await fetchGoogleProfilePhoto('access-token')).toBeNull()
  })

  it('cannot say when the API refuses or does not answer, so nothing recorded changes', async () => {
    // A 403 is what a project without the People API enabled gets.
    global.fetch = jest.fn().mockResolvedValue(json(403, { error: { status: 'PERMISSION_DENIED' } }))
    expect(await fetchGoogleProfilePhoto('access-token')).toBeUndefined()
    global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
    expect(await fetchGoogleProfilePhoto('access-token')).toBeUndefined()
  })
})
