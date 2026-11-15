import { SITE_URL } from '@/lib/seo/metadata'
import { CHANGELOG, CHANGELOG_UPDATED, entrySlug, plainText } from '../entries'

/**
 * GET /changelog/rss.xml: the changelog as RSS 2.0, newest first, one item per
 * change, each linking to its anchor on /changelog. Built from the same
 * entries as the page, so the two cannot disagree.
 */
export const dynamic = 'force-static'

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** Noon UTC on the entry's day, so the date reads the same in every time zone. */
const rfc822 = (date: string) => new Date(`${date}T12:00:00Z`).toUTCString()

export function GET() {
  const page = `${SITE_URL}/changelog`
  const items = CHANGELOG.flatMap((month) => month.entries)
    .map((entry) => {
      const link = `${page}#${entrySlug(entry)}`
      return [
        '    <item>',
        `      <title>${escape(entry.title)}</title>`,
        `      <link>${escape(link)}</link>`,
        `      <guid isPermaLink="true">${escape(link)}</guid>`,
        `      <pubDate>${rfc822(entry.date)}</pubDate>`,
        `      <category>${escape(entry.area)}</category>`,
        `      <description>${escape(`${entry.kind}. ${plainText(entry.body)}`)}</description>`,
        '    </item>',
      ].join('\n')
    })
    .join('\n')

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>Backenly changelog</title>',
    `    <link>${page}</link>`,
    '    <description>What changed in Backenly, newest first.</description>',
    '    <language>en</language>',
    `    <lastBuildDate>${rfc822(CHANGELOG_UPDATED)}</lastBuildDate>`,
    `    <atom:link href="${page}/rss.xml" rel="self" type="application/rss+xml" />`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n')

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  })
}
