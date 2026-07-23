export const dynamic = 'force-dynamic'

/**
 * Manifests API
 * 
 * GET /api/manifests - Generate deployment manifests
 */

import { NextRequest, NextResponse } from 'next/server'
import { generateAllManifests, detectProjectConfig } from '@/lib/services/manifests'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { prisma } from '@/lib/db'

// GET /api/manifests - Generate manifests
export async function GET(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const { searchParams } = new URL(request.url)
      const provider = searchParams.get('provider') // Optional: specific provider
      const format = searchParams.get('format') || 'json' // 'json' or 'download'

      // Get project info
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true, description: true },
      })

      if (!project) {
        return NextResponse.json(
          { error: 'Project not found' },
          { status: 404 }
        )
      }

      // Detect project config (could be enhanced with workspace file analysis)
      const config = detectProjectConfig(project.name)

      // Generate manifests
      const manifests = generateAllManifests(config)

      // Return specific provider or all
      if (provider && format === 'download') {
        let content = ''
        let filename = ''
        let contentType = 'text/plain'

        switch (provider) {
          case 'render':
            content = manifests.render
            filename = 'render.yaml'
            contentType = 'application/x-yaml'
            break
          case 'vercel':
            content = manifests.vercel
            filename = 'vercel.json'
            contentType = 'application/json'
            break
          case 'docker':
            content = manifests.dockerfile
            filename = 'Dockerfile'
            contentType = 'text/plain'
            break
          case 'github':
            content = manifests.githubActions
            filename = 'deploy.yml'
            contentType = 'application/x-yaml'
            break
          default:
            return NextResponse.json(
              { error: 'Invalid provider' },
              { status: 400 }
            )
        }

        return new NextResponse(content, {
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        })
      }

      return NextResponse.json({
        success: true,
        manifests: provider
          ? { [provider]: manifests[provider as keyof typeof manifests] }
          : manifests,
      })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      )
    }
    console.error('Failed to generate manifests:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to generate manifests' },
      { status: 500 }
    )
  }
}

