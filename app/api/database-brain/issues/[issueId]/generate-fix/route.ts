export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { chatCompletion, isAIEnabled } from '@/lib/openai/client'

// POST /api/database-brain/issues/[id]/generate-fix - Generate SQL fix using OpenAI
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!isAIEnabled()) {
      return NextResponse.json(
        {
          success: false,
          error: 'OpenAI is not enabled. Please set OPENAI_API_KEY in your environment.',
        },
        { status: 400 }
      )
    }

    const issue = await prisma.databaseIssue.findUnique({
      where: { id: params.id },
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
    const updatedIssue = await prisma.databaseIssue.update({
      where: { id: params.id },
      data: {
        sqlFix: generatedFix.sqlFix || null,
        migrationSteps: generatedFix.migrationSteps || null,
      },
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

