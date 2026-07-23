/**
 * SCREENSHOT DIAGNOSIS
 * ====================
 * The "paste a screenshot of a problem → the agent fixes it" path, the same
 * loop a developer uses in Claude Code — but for their own backend.
 *
 * This is STRICTLY ADDITIVE and never touches the wireframe→build path in
 * lib/ai/file-processor.ts. The execute route only reaches this module under
 * hard gates (project already has tables AND the user is clearly asking to fix
 * something OR the image is, with high confidence, an error/dashboard
 * screenshot). Anything ambiguous falls through to the existing build path.
 *
 * Two responsibilities:
 *   1. classifyAndDiagnoseScreenshot — vision call that decides wireframe vs
 *      diagnostic and, for diagnostics, extracts the error/symptoms.
 *   2. buildDiagnosticContext — correlate the diagnosis with the project's open
 *      health findings and produce a context block that steers the brain to
 *      resolve_finding / fix_backend (NOT create_table).
 */

import { getOpenAIClient } from './openai-service'
import { prisma } from '@/lib/db/prisma'

export interface ScreenshotDiagnosis {
  /** 'wireframe' = a design/mockup to BUILD from. 'diagnostic' = a PROBLEM to FIX. */
  kind: 'wireframe' | 'diagnostic'
  /** 0–1 confidence in the `kind` classification. */
  confidence: number
  /** One-line description of what the screenshot shows. */
  summary: string
  /** Verbatim error/message text read out of the image, if any. */
  errorText: string
  /** Observable symptoms (red banners, 500s, "unreachable", failed badges, …). */
  symptoms: string[]
  /** Best guess at the affected subsystem. */
  affectedArea:
    | 'auth' | 'api' | 'table' | 'storage' | 'realtime'
    | 'integration' | 'deploy' | 'billing' | 'unknown'
}

const CLASSIFY_PROMPT = `You are triaging a screenshot a developer pasted into a backend platform's AI chat.

Decide which it is:
 - "wireframe": a UI mockup / app design (screens, forms, lists, navigation) of an app they want BUILT. No error or diagnostic content.
 - "diagnostic": a screenshot of a PROBLEM to fix — an error message, a red/failed/critical banner, a stack trace, a health/issues panel, a failing API request, console errors, a 4xx/5xx, "unreachable"/"failed"/"not working", or a broken screen.

Read the image carefully and respond with ONLY valid JSON (no markdown fences):
{
  "kind": "wireframe" | "diagnostic",
  "confidence": 0.0-1.0,
  "summary": "one line: what the screenshot shows",
  "errorText": "verbatim error/alert text visible in the image, or empty string",
  "symptoms": ["short observable symptom", "..."],
  "affectedArea": "auth" | "api" | "table" | "storage" | "realtime" | "integration" | "deploy" | "billing" | "unknown"
}`

/**
 * Single vision call: classify the screenshot and, when it's a problem, extract
 * the diagnostic detail. Returns null on any failure so the caller can safely
 * fall back to the existing build path.
 */
export async function classifyAndDiagnoseScreenshot(
  base64: string,
  mimeType: string,
): Promise<ScreenshotDiagnosis | null> {
  try {
    const openai = getOpenAIClient()
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
            { type: 'text', text: CLASSIFY_PROMPT },
          ],
        },
      ],
    })

    const raw = response.choices[0]?.message?.content?.trim() ?? ''
    const json = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const parsed = JSON.parse(json)

    const kind = parsed.kind === 'diagnostic' ? 'diagnostic' : 'wireframe'
    const conf = Number(parsed.confidence)
    return {
      kind,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      errorText: typeof parsed.errorText === 'string' ? parsed.errorText : '',
      symptoms: Array.isArray(parsed.symptoms) ? parsed.symptoms.map(String).slice(0, 8) : [],
      affectedArea: typeof parsed.affectedArea === 'string' ? parsed.affectedArea : 'unknown',
    }
  } catch {
    return null
  }
}

/**
 * Build the diagnostic context block handed to the brain. Correlates the vision
 * diagnosis with the project's OPEN / pending health findings so the agent can
 * resolve the exact issue, and steers it firmly away from building new tables.
 */
export async function buildDiagnosticContext(
  projectId: string,
  d: ScreenshotDiagnosis,
): Promise<string> {
  const findings = await prisma.healthFinding
    .findMany({
      where: { projectId, status: { in: ['open', 'pending_approval'] } },
      orderBy: { detectedAt: 'desc' },
      take: 25,
    })
    .catch(() => [])

  const lines: string[] = [
    '## DIAGNOSTIC SCREENSHOT',
    'The user pasted a screenshot of a PROBLEM with their backend — NOT a design to build.',
    '',
    `What it shows: ${d.summary || '(unclear — read the error text)'}`,
  ]
  if (d.errorText) lines.push(`Error text in image: "${d.errorText}"`)
  if (d.symptoms.length) lines.push(`Symptoms: ${d.symptoms.join('; ')}`)
  lines.push(`Likely affected area: ${d.affectedArea}`)

  if (findings.length > 0) {
    lines.push('', 'OPEN HEALTH FINDINGS for this project — resolve the one that matches the screenshot:')
    for (const f of findings) {
      const det = (f.details ?? {}) as Record<string, unknown>
      const target = [det.tableName, det.columnName].filter(Boolean).join('.')
      const reason = typeof det.reason === 'string' ? det.reason : ''
      lines.push(`  - id=${f.id} | ${f.type} | ${f.severity}${target ? ` | ${target}` : ''}${reason ? ` | ${reason}` : ''}`)
    }
  } else {
    lines.push('', 'No open health findings are recorded — diagnose from live state with read_backend_state plus the error above.')
  }

  lines.push(
    '',
    'INSTRUCTION: This is a FIX request, not a build request. Do NOT create new tables from this image.',
    'Resolve it: prefer resolve_finding(findingId=…) for a matching finding above; otherwise call',
    'read_backend_state and then fix_backend(target=…). Apply safe/additive fixes immediately. For',
    'auth, destructive, or irreversible changes, explain the fix and ask the user to confirm first.',
    'Verify with run_test where it makes sense, then finish with a plain-language summary of what you fixed.',
  )

  return lines.join('\n')
}
