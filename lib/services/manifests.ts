/**
 * CI/CD Manifest Generation Service
 * 
 * Generates deployment manifests for various providers
 */

export interface ProjectConfig {
  name: string
  description?: string
  runtime?: 'node' | 'python' | 'go' | 'rust'
  nodeVersion?: string
  buildCommand?: string
  startCommand?: string
  installCommand?: string
  env?: Record<string, string>
  port?: number
}

/**
 * Generate Render.com manifest (render.yaml)
 */
export function generateRenderManifest(config: ProjectConfig): string {
  const serviceName = config.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const buildCommand = config.buildCommand || (config.runtime === 'node' ? 'npm install && npm run build' : '')
  const startCommand = config.startCommand || (config.runtime === 'node' ? 'npm start' : '')

  return `services:
  - type: web
    name: ${serviceName}
    env: node
    ${config.nodeVersion ? `nodeVersion: ${config.nodeVersion}` : ''}
    ${buildCommand ? `buildCommand: ${buildCommand}` : ''}
    ${startCommand ? `startCommand: ${startCommand}` : ''}
    envVars:
${Object.entries(config.env || {}).map(([key, value]) => `      - key: ${key}\n        value: ${value}`).join('\n')}
    healthCheckPath: /health
    autoDeploy: false
`
}

/**
 * Generate Vercel manifest (vercel.json)
 */
export function generateVercelManifest(config: ProjectConfig): string {
  const buildCommand = config.buildCommand || (config.runtime === 'node' ? 'npm run build' : '')
  const installCommand = config.installCommand || (config.runtime === 'node' ? 'npm install' : '')

  return JSON.stringify({
    version: 2,
    name: config.name,
    builds: [
      {
        src: 'package.json',
        use: '@vercel/node',
      },
    ],
    routes: [
      {
        src: '/api/(.*)',
        dest: '/api/$1',
      },
      {
        src: '/(.*)',
        dest: '/$1',
      },
    ],
    env: config.env || {},
    ...(buildCommand && { buildCommand }),
    ...(installCommand && { installCommand }),
  }, null, 2)
}

/**
 * Generate Dockerfile
 */
export function generateDockerfile(config: ProjectConfig): string {
  const nodeVersion = config.nodeVersion || '20'
  const port = config.port || 3000

  return `# Dockerfile for ${config.name}
FROM node:${nodeVersion}-alpine AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
${config.buildCommand ? `RUN ${config.buildCommand}` : ''}

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

USER nextjs

EXPOSE ${port}

ENV PORT=${port}
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
`
}

/**
 * Generate GitHub Actions workflow
 */
export function generateGitHubActionsWorkflow(config: ProjectConfig): string {
  return `name: Deploy to Production

on:
  push:
    branches:
      - main
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy to'
        required: true
        default: 'production'
        type: choice
        options:
          - production
          - staging

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '${config.nodeVersion || '20'}'
          cache: 'npm'
      
      - name: Install dependencies
        run: ${config.installCommand || 'npm ci'}
      
      - name: Build
        run: ${config.buildCommand || 'npm run build'}
        env:
          NODE_ENV: production
      
      - name: Run tests
        run: npm test
        continue-on-error: true
      
      - name: Deploy
        run: |
          echo "Deployment would happen here"
          echo "Environment: \${{ github.event.inputs.environment || 'production' }}"
`
}

/**
 * Generate all manifests for a project
 */
export function generateAllManifests(config: ProjectConfig): {
  render: string
  vercel: string
  dockerfile: string
  githubActions: string
} {
  return {
    render: generateRenderManifest(config),
    vercel: generateVercelManifest(config),
    dockerfile: generateDockerfile(config),
    githubActions: generateGitHubActionsWorkflow(config),
  }
}

/**
 * Detect project configuration from workspace files
 */
export function detectProjectConfig(projectName: string, files?: string[]): ProjectConfig {
  // Default Node.js configuration
  const config: ProjectConfig = {
    name: projectName,
    runtime: 'node', // Default to Node.js
    nodeVersion: '20',
    port: 3000,
  }

  // Check for package.json to detect Node.js
  if (files?.some(f => f.includes('package.json'))) {
    config.runtime = 'node'
  }

  // Check for Python files
  if (files?.some(f => f.endsWith('.py') || f.includes('requirements.txt'))) {
    config.runtime = 'python'
  }

  // Check for Go files
  if (files?.some(f => f.endsWith('.go') || f.includes('go.mod'))) {
    config.runtime = 'go'
  }

  // Check for Rust files
  if (files?.some(f => f.endsWith('.rs') || f.includes('Cargo.toml'))) {
    config.runtime = 'rust'
  }

  // Default commands based on runtime
  if (config.runtime === 'node') {
    config.buildCommand = 'npm run build'
    config.startCommand = 'npm start'
    config.installCommand = 'npm install'
  }

  return config
}

