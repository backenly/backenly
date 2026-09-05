import { checkSignupEmailEligibility } from '@/lib/auth/signup-email-eligibility'

describe('checkSignupEmailEligibility', () => {
  it('allows genuine consumer and work emails', () => {
    const allowed = [
      'founder@gmail.com',
      'builder@yahoo.com',
      'pm@naver.com',
      'dev@outlook.com',
      'cto@realstartup.ai',
    ]

    for (const email of allowed) {
      expect(checkSignupEmailEligibility(email)).toEqual({ ok: true })
    }
  })

  it('rejects disposable domains and obvious burner local-parts', () => {
    const blocked = [
      'tempemailburner@gmail.com',
      'founder@mailinator.com',
      'person@yopmail.com',
      'user@sub.10minutemail.com',
      'hello@temp-mail.org',
      'person@example.com',
      'test@gmail.com',
    ]

    for (const email of blocked) {
      expect(checkSignupEmailEligibility(email).ok).toBe(false)
    }
  })
})
