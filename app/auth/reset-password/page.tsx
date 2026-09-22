import { redirect } from 'next/navigation'

/**
 * Password reset is a code entered on /auth/forgot-password now. This address
 * only exists because older reset emails linked here, and those links expired
 * an hour after they were sent, so there is nothing to carry across: send the
 * visitor to the page that works.
 */
export default function ResetPasswordPage() {
  redirect('/auth/forgot-password')
}
