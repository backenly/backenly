import { NextResponse } from 'next/server'

// Live GitHub star count for the flagship repo, surfaced in the site navbar.
// Cached server-side so visitor traffic never hits GitHub's unauthenticated
// rate limit (60/hr/IP): GitHub is polled at most once per REVALIDATE window
// regardless of how many people load the site.
const REPO = 'backenly/backenly'
const REVALIDATE = 300 // seconds

export const revalidate = REVALIDATE

export async function GET() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'backenly.com',
      },
      next: { revalidate: REVALIDATE },
    })
    if (!res.ok) {
      // Private repo (404) or rate limited: report null, the navbar hides the count.
      return NextResponse.json({ stars: null }, { headers: cacheHeaders() })
    }
    const data = (await res.json()) as { stargazers_count?: number }
    const stars = typeof data.stargazers_count === 'number' ? data.stargazers_count : null
    return NextResponse.json({ stars }, { headers: cacheHeaders() })
  } catch {
    return NextResponse.json({ stars: null }, { headers: cacheHeaders() })
  }
}

function cacheHeaders() {
  return {
    'Cache-Control': `public, s-maxage=${REVALIDATE}, stale-while-revalidate=${REVALIDATE}`,
  }
}
