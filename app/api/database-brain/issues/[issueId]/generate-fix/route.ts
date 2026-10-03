export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { chatCompletion, isAIEnabled } from '@/lib/openai/client'
import { requireAuth } from '@/lib/auth/middleware'
import { getCurrentProjectId } from '@/lib/tenant/isolation'

/**
 * Generate a fix for a database issue.
 *
 * ── This route had NO authentication ────────────────────────────────────────
 *
 * It looked the issue up by id alone and answered. Three separate consequences,
 * none of which needed a session:
 *
 *   - it DISCLOSED another tenant's issue: title, description, affected tables
 *     and analysis, which together describe the shape of their database and
 *     what is wrong with it
 *   - it WROTE `sqlFix` and `migrationSteps` onto that issue, and the sibling
 *     apply-fix route executes `issue.sqlFix` through $executeRawUnsafe. So an
 *     unauthenticated caller could change what a legitimate operator's "apply
 *     fix" button would later run
 *   - it spent the operator's OpenAI credit on every call
 *
 * The prompt is built from the stored record and never from the request body,
 * so a caller could not CHOOSE the SQL - this was not direct injection. It was
 * an unauthenticated mutation of a field that feeds a privileged execution
 * path, which is bad enough and is worth stating precisely rather than
 * inflating.
 *
 * Now matches its siblings: authenticate, resolve the project the caller may
 * actually reach, and scope BOTH the read and the write by { id, projectId }.
 * Scoping the predicate rather than loading-then-comparing means a mismatch
 * cannot be forgotten at one of the two call sites.
 */

// POST /api/database-brain/issues/[id]/generate-fix - Generate SQL fix using OpenAI
export async function POST(request: NextRequest, props: { params: Promise<{ issueId: string }> }) {
  const params = await props.params;
  try {
    // Before anything is read, generated, or spent.
    await requireAuth(request)
    const projectId = await getCurrentProjectId(request)

    if (!isAIEnabled()) {
      return NextResponse.json(
        {
          success: false,
          error: 'OpenAI is not enabled. Please set OPENAI_API_KEY in your environment.',
        },
        { status: 400 }
      )
    }

    // Tenant-scoped in the predicate: an issue id alone is not authorization.
    const issue = await prisma.databaseIssue.findFirst({
      where: { id: params.issueId, projectId },
    })

    if (!issue) {
      return NextResponse.json(
        {
          success: false,
          error: 'Issue not found',
        },
        { status: 404 }
      )
    }

    // Generate SQL fix using OpenAI
    const prompt = `You are a database optimization expert. Generate SQL statements and migration steps to fix the following database issue:

Title: ${issue.title}
Description: ${issue.description}
Database: ${issue.database}
Category: ${issue.category}
Suggested Fix: ${issue.suggestedFix}
${issue.rawQuery ? `Query: ${issue.rawQuery}` : ''}
${issue.affectedTables ? `Affected Tables: ${issue.affectedTables.join(', ')}` : ''}
${issue.detailedAnalysis ? `Analysis: ${issue.detailedAnalysis}` : ''}

Please provide:
1. SQL statements to fix the issue (if applicable)
2. Step-by-step migration instructions
3. Any warnings or considerations

Format your response as JSON with the following structure:
{
  "sqlFix": "SQL statements here (can be multiple statements separated by semicolons)",
  "migrationSteps": "Step-by-step instructions here",
  "warnings": "Any warnings or considerations"
}`

    const response = await chatCompletion([
      {
        role: 'system',
        content: 'You are a database optimization expert. Provide clear, safe SQL statements and migration steps. Always include safety considerations.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ])

    if (!response || !response.choices || !response.choices[0]) {
      throw new Error('No response from OpenAI')
    }

    const content = response.choices[0].message?.content || ''
    
    let generatedFix
    try {
      generatedFix = JSON.parse(content)
    } catch {
      // If not JSON, try to extract SQL from the response
      generatedFix = {
        sqlFix: content,
        migrationSteps: 'Review the generated SQL and apply it carefully.',
        warnings: 'Please review the generated SQL before executing.',
      }
    }

    // Update issue with generated fix
    // updateMany, so the projectId stays in the predicate. `update` takes a
    // unique where clause and would drop the scope.
    await prisma.databaseIssue.updateMany({
      where: { id: params.issueId, projectId },
      data: {
        sqlFix: generatedFix.sqlFix || null,
        migrationSteps: generatedFix.migrationSteps || null,
      },
    })

    // Re-read, still scoped. updateMany returns a count rather than the row.
    const updatedIssue = await prisma.databaseIssue.findFirst({
      where: { id: params.issueId, projectId },
    })

    return NextResponse.json({
      success: true,
      data: {
        issue: updatedIssue,
        generated: generatedFix,
      },
    })
  } catch (error: any) {
    console.error('Error generating fix:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to generate fix',
        message: error.message,
      },
      { status: 500 }
    )
  }
}

