import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { deleteAccountCompletely, TooManyProjectsError } from '@/lib/projects/delete'
import { clearSessionCookies } from '@/lib/auth/session'

export const DELETE = withAuth(async (request: NextRequest, { user }) => {
  try {
    // Deletes every owned project's schemas and rows, then the user, in one
    // transaction — then removes each project's backups and storage objects.
    //
    // This used to be `project.deleteMany` followed by `user.delete`, which
    // removed the Prisma rows and left every workspace_<projectId> schema
    // resident in PostgreSQL, holding the account's tables and its end-users'
    // records, with nothing left pointing at them.
    await deleteAccountCompletely(user.userId)

    // Sign this browser out. The account's sessions went with the user row
    // (Session cascades), but the browser still held both cookies: this used
    // to clear one named `token`, which nothing ever sets.
    return clearSessionCookies(NextResponse.json({ success: true }))
  } catch (error) {
    if (error instanceof TooManyProjectsError) {
      // Refused rather than attempted: an account this size would hold locks on
      // dozens of schemas for the length of an HTTP request.
      console.error('Delete account refused:', error.message)
      return NextResponse.json(
        { error: 'Account has too many projects to delete automatically. Contact support.' },
        { status: 409 },
      )
    }
    // Category only — the message can name a schema or a path.
    console.error('Delete account error:', (error as any)?.name || 'Error')
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 })
  }
})
