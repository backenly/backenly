/**
 * Deploy Adapter System
 * Solution 4: Provider-Neutral Deployment
 * 
 * Generates provider-specific configurations from a universal deploy spec.
 * Users never touch npm flags or provider quirks.
 */

export interface DeploySpec {
  runtime: 'node';
  version: string;
  start: string;
  build?: string; // Optional - prebuilt backends don't need this
  env: EnvVar[];
  healthcheck: string;
  ports: number[];
  resources?: {
    memory?: string;
    cpu?: string;
  };
}

export interface EnvVar {
  key: string;
  required: boolean;
  description: string;
  default?: string;
}

export interface ProviderConfig {
  provider: 'render' | 'railway' | 'fly' | 'vercel';
  config: any;
  instructions: string;
}

/**
 * Deploy Adapter
 * Converts universal deploy spec to provider-specific config
 */
export class DeployAdapter {
  private spec: DeploySpec;

  constructor(spec: DeploySpec) {
    this.spec = spec;
  }

  /**
   * Generate Render configuration
   */
  toRender(): ProviderConfig {
    const renderYaml = {
      services: [
        {
          type: 'web',
          name: 'backenly-api',
          env: 'node',
          // NO BUILD COMMAND - Prebuilt!
          startCommand: this.spec.start,
          envVars: this.spec.env.map(e => ({
            key: e.key,
            sync: false,
          })),
          healthCheckPath: this.spec.healthcheck,
        },
      ],
    };

    const instructions = `
# Render Deployment Instructions

1. Create new Web Service on Render
2. Connect your GitHub repository
3. Configure:
   - Build Command: (leave empty - prebuilt)
   - Start Command: ${this.spec.start}
   - Health Check Path: ${this.spec.healthcheck}

4. Set Environment Variables:
${this.spec.env.map(e => `   - ${e.key}${e.required ? ' (required)' : ''}: ${e.description}`).join('\n')}

5. Deploy!
`;

    return {
      provider: 'render',
      config: renderYaml,
      instructions,
    };
  }

  /**
   * Generate Railway configuration
   */
  toRailway(): ProviderConfig {
    const railwayJson = {
      $schema: 'https://railway.app/railway.schema.json',
      build: {
        builder: 'nixpacks',
      },
      deploy: {
        startCommand: this.spec.start,
        healthcheckPath: this.spec.healthcheck,
        restartPolicyType: 'on_failure',
      },
    };

    const instructions = `
# Railway Deployment Instructions

1. Install Railway CLI: npm i -g @railway/cli
2. Login: railway login
3. Create project: railway init
4. Set environment variables:
${this.spec.env.map(e => `   railway variables set ${e.key}=<value>`).join('\n')}

5. Deploy: railway up
`;

    return {
      provider: 'railway',
      config: railwayJson,
      instructions,
    };
  }

  /**
   * Generate Fly.io configuration
   */
  toFly(): ProviderConfig {
    const flyToml = `
app = "backenly-api"
primary_region = "sea"

[build]
  image = "node:18-alpine"

[env]
${this.spec.env.filter(e => e.default).map(e => `  ${e.key} = "${e.default}"`).join('\n')}

[[services]]
  internal_port = ${this.spec.ports[0]}
  protocol = "tcp"

  [[services.ports]]
    port = 80
    handlers = ["http"]

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [[services.http_checks]]
    interval = "10s"
    timeout = "2s"
    path = "${this.spec.healthcheck}"
`;

    const instructions = `
# Fly.io Deployment Instructions

1. Install Fly CLI: curl -L https://fly.io/install.sh | sh
2. Login: fly auth login
3. Launch app: fly launch
4. Set secrets:
${this.spec.env.filter(e => e.required).map(e => `   fly secrets set ${e.key}=<value>`).join('\n')}

5. Deploy: fly deploy
`;

    return {
      provider: 'fly',
      config: flyToml,
      instructions,
    };
  }

  /**
   * Generate Docker Compose (local/self-hosted)
   */
  toDockerCompose(): ProviderConfig {
    const dockerCompose = {
      version: '3.8',
      services: {
        app: {
          build: '.',
          ports: this.spec.ports.map(p => `${p}:${p}`),
          environment: Object.fromEntries(
            this.spec.env.map(e => [e.key, e.default || ''])
          ),
          healthcheck: {
            test: `curl -f http://localhost:${this.spec.ports[0]}${this.spec.healthcheck} || exit 1`,
            interval: '10s',
            timeout: '3s',
            retries: 3,
          },
          restart: 'unless-stopped',
        },
      },
    };

    const dockerfile = `
FROM node:18-alpine

WORKDIR /app

# Copy prebuilt application
COPY dist ./dist
COPY node_modules ./node_modules
COPY prisma ./prisma
COPY package.json ./

# Expose port
EXPOSE ${this.spec.ports[0]}

# Start command
CMD ${this.spec.start}
`.trim();

    const instructions = `
# Docker Deployment Instructions

1. Build image: docker-compose build
2. Set environment variables in .env file
3. Start: docker-compose up -d
4. Check logs: docker-compose logs -f
`;

    return {
      provider: 'fly', // Using fly as placeholder for docker
      config: { 'docker-compose.yml': dockerCompose, Dockerfile: dockerfile },
      instructions,
    };
  }

  /**
   * Generate all provider configs at once
   */
  generateAll(): Record<string, ProviderConfig> {
    return {
      render: this.toRender(),
      railway: this.toRailway(),
      fly: this.toFly(),
      docker: this.toDockerCompose(),
    };
  }

  /**
   * Get recommended provider based on workspace
   */
  static getRecommendedProvider(workspace: {
    hasDatabase: boolean;
    hasStorage: boolean;
    expectedTraffic: 'low' | 'medium' | 'high';
  }): 'render' | 'railway' | 'fly' {
    // Simple heuristics
    if (workspace.expectedTraffic === 'high') return 'fly';
    if (workspace.hasDatabase && workspace.hasStorage) return 'railway';
    return 'render'; // Default, easiest
  }
}

/**
 * Universal Deploy Spec Builder
 * Creates deploy spec from workspace
 */
export class DeploySpecBuilder {
  /**
   * Build deploy spec from workspace
   */
  static fromWorkspace(workspace: {
    id: string;
    runtime: string;
    packageJson: any;
    schema: string;
  }): DeploySpec {
    // Extract required env vars from code
    const envVars = this.extractEnvVars(workspace.schema);

    return {
      runtime: 'node',
      version: workspace.packageJson.engines?.node || '>=18.0.0',
      start: 'node dist/src/server.js', // Prebuilt - no build step!
      env: [
        {
          key: 'DATABASE_URL',
          required: true,
          description: 'PostgreSQL connection string',
        },
        {
          key: 'NODE_ENV',
          required: true,
          description: 'Environment (production)',
          default: 'production',
        },
        {
          key: 'PORT',
          required: false,
          description: 'Server port',
          default: '10000',
        },
        ...envVars,
      ],
      healthcheck: '/api/health',
      ports: [10000],
      resources: {
        memory: '512MB',
        cpu: '1',
      },
    };
  }

  /**
   * Extract environment variables from schema/code
   */
  private static extractEnvVars(schema: string): EnvVar[] {
    const vars: EnvVar[] = [];

    // Check for specific model types
    if (schema.includes('model User')) {
      vars.push({
        key: 'JWT_SECRET',
        required: true,
        description: 'Secret key for JWT tokens',
      });
    }

    if (schema.includes('model Payment')) {
      vars.push({
        key: 'STRIPE_SECRET_KEY',
        required: true,
        description: 'Stripe API secret key',
      });
    }

    if (schema.includes('StorageFile')) {
      vars.push(
        {
          key: 'BACKENLY_API_URL',
          required: true,
          description: 'Backenly API URL for storage',
        },
        {
          key: 'BACKENLY_API_KEY',
          required: true,
          description: 'Backenly API key',
        }
      );
    }

    return vars;
  }
}
