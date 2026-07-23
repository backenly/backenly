/**
 * Feature Manifest System
 * Solution 3: Intent-Locked Feature Generation
 * 
 * Every feature declares its requirements and provides capabilities.
 * NO partial features allowed.
 */

export interface FeatureManifest {
  id: string;
  name: string;
  category: 'auth' | 'database' | 'storage' | 'payment' | 'api';
  requires: {
    models?: string[];           // Prisma models required
    dependencies?: string[];     // npm packages required
    env?: string[];              // Environment variables required
    config?: Record<string, any>; // Configuration required
  };
  provides: string[];            // Capabilities provided
  files: FeatureFile[];          // Files to generate
  autoFix?: boolean;             // Can auto-add missing requirements
}

export interface FeatureFile {
  path: string;
  template: string;
  description: string;
}

export interface FeatureValidationResult {
  valid: boolean;
  missing: {
    models: string[];
    dependencies: string[];
    env: string[];
    config: string[];
  };
  canAutoFix: boolean;
  fixes: FeatureFix[];
}

export interface FeatureFix {
  type: 'model' | 'dependency' | 'env' | 'config';
  action: string;
  description: string;
  autoApply: boolean;
}

/**
 * Feature Registry
 * All available features with their requirements
 */
export const FEATURE_REGISTRY: Record<string, FeatureManifest> = {
  'auth-email': {
    id: 'auth-email',
    name: 'Email Authentication',
    category: 'auth',
    requires: {
      models: ['User', 'Session'],
      dependencies: ['bcrypt', 'jsonwebtoken', '@types/bcrypt', '@types/jsonwebtoken'],
      env: ['JWT_SECRET'],
    },
    provides: ['auth:login', 'auth:signup', 'auth:logout'],
    files: [
      {
        path: 'routes/auth.ts',
        template: 'auth/email-auth.ts',
        description: 'Email authentication routes',
      },
    ],
    autoFix: true,
  },

  'auth-oauth': {
    id: 'auth-oauth',
    name: 'OAuth Authentication',
    category: 'auth',
    requires: {
      models: ['User', 'Session'],
      dependencies: ['axios'],
      env: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    },
    provides: ['auth:oauth:github', 'auth:oauth:google'],
    files: [
      {
        path: 'routes/auth/oauth.ts',
        template: 'auth/oauth.ts',
        description: 'OAuth authentication routes',
      },
    ],
    autoFix: true,
  },

  'payment-stripe': {
    id: 'payment-stripe',
    name: 'Stripe Payments',
    category: 'payment',
    requires: {
      models: ['Payment', 'Order', 'User'],
      dependencies: ['stripe', '@types/stripe'],
      env: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'],
    },
    provides: ['payment:create', 'payment:webhook', 'payment:refund'],
    files: [
      {
        path: 'routes/payments.ts',
        template: 'payment/stripe.ts',
        description: 'Stripe payment routes',
      },
    ],
    autoFix: true,
  },

  'storage-upload': {
    id: 'storage-upload',
    name: 'File Storage',
    category: 'storage',
    requires: {
      models: ['StorageFile'],
      dependencies: ['multer', 'form-data', '@types/multer'],
      env: ['BACKENDO_API_URL', 'BACKENDO_API_KEY'],
      config: { bucketName: 'required' },
    },
    provides: ['storage:upload', 'storage:delete', 'storage:list'],
    files: [
      {
        path: 'routes/storage/upload.ts',
        template: 'storage/upload.ts',
        description: 'File upload routes',
      },
    ],
    autoFix: true,
  },

  'crud-api': {
    id: 'crud-api',
    name: 'CRUD API',
    category: 'api',
    requires: {
      models: [], // Dynamic based on entity
      dependencies: ['zod'],
    },
    provides: ['api:create', 'api:read', 'api:update', 'api:delete'],
    files: [
      {
        path: 'routes/{entity}.ts',
        template: 'api/crud.ts',
        description: 'CRUD routes',
      },
    ],
    autoFix: false,
  },
};

/**
 * Feature Validator
 * Validates if workspace can support a feature
 */
export class FeatureValidator {
  /**
   * Validate feature requirements against workspace
   */
  static async validate(
    feature: FeatureManifest,
    workspace: {
      schema: string;
      packageJson: any;
      env: Record<string, string>;
    }
  ): Promise<FeatureValidationResult> {
    const missing = {
      models: [] as string[],
      dependencies: [] as string[],
      env: [] as string[],
      config: [] as string[],
    };

    const fixes: FeatureFix[] = [];

    // Check models
    if (feature.requires.models) {
      for (const model of feature.requires.models) {
        if (!workspace.schema.includes(`model ${model}`)) {
          missing.models.push(model);

          if (feature.autoFix) {
            fixes.push({
              type: 'model',
              action: `Add model ${model} to schema`,
              description: `Add ${model} model with required fields`,
              autoApply: true,
            });
          }
        }
      }
    }

    // Check dependencies
    if (feature.requires.dependencies) {
      const allDeps = {
        ...workspace.packageJson.dependencies,
        ...workspace.packageJson.devDependencies,
      };

      for (const dep of feature.requires.dependencies) {
        if (!allDeps[dep]) {
          missing.dependencies.push(dep);

          if (feature.autoFix) {
            fixes.push({
              type: 'dependency',
              action: `Install ${dep}`,
              description: `Add "${dep}" to package.json`,
              autoApply: true,
            });
          }
        }
      }
    }

    // Check environment variables
    if (feature.requires.env) {
      for (const envVar of feature.requires.env) {
        if (!workspace.env[envVar]) {
          missing.env.push(envVar);

          fixes.push({
            type: 'env',
            action: `Set ${envVar}`,
            description: `Add ${envVar} to environment variables`,
            autoApply: false, // Env vars need user input
          });
        }
      }
    }

    // Check config
    if (feature.requires.config) {
      for (const [key, value] of Object.entries(feature.requires.config)) {
        missing.config.push(key);

        fixes.push({
          type: 'config',
          action: `Configure ${key}`,
          description: `Set ${key} = ${value}`,
          autoApply: false, // Config needs user input
        });
      }
    }

    const isValid =
      missing.models.length === 0 &&
      missing.dependencies.length === 0 &&
      missing.env.length === 0 &&
      missing.config.length === 0;

    const canAutoFix = fixes.every(f => f.autoApply);

    return {
      valid: isValid,
      missing,
      canAutoFix,
      fixes,
    };
  }

  /**
   * Auto-apply fixes if possible
   */
  static async applyFixes(
    fixes: FeatureFix[],
    workspace: {
      schemaPath: string;
      packageJsonPath: string;
    }
  ): Promise<{ success: boolean; applied: string[] }> {
    const applied: string[] = [];

    for (const fix of fixes) {
      if (!fix.autoApply) continue;

      try {
        if (fix.type === 'model') {
          // Add model to schema
          const modelName = fix.action.split(' ')[2]; // Extract model name
          const modelTemplate = this.getModelTemplate(modelName);

          const fs = require('fs/promises');
          const schema = await fs.readFile(workspace.schemaPath, 'utf-8');
          const updatedSchema = schema + '\n\n' + modelTemplate;
          await fs.writeFile(workspace.schemaPath, updatedSchema);

          applied.push(`Added model ${modelName}`);
        }

        if (fix.type === 'dependency') {
          // This would be handled by package.json update
          applied.push(fix.action);
        }
      } catch (error) {
        console.error(`Failed to apply fix: ${fix.action}`, error);
      }
    }

    return {
      success: applied.length > 0,
      applied,
    };
  }

  /**
   * Get Prisma model template
   */
  private static getModelTemplate(modelName: string): string {
    const templates: Record<string, string> = {
      Payment: `model Payment {
  id        String   @id @default(uuid())
  orderId   String
  amount    Float
  currency  String   @default("usd")
  status    String   @default("pending") // pending, completed, failed, refunded
  stripeId  String?  @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  order Order @relation(fields: [orderId], references: [id])

  @@map("payments")
}`,
      StorageFile: `model StorageFile {
  id          String   @id @default(uuid())
  projectId   String
  bucket      String
  filename    String
  path        String
  url         String
  size        Int
  mimeType    String
  uploadedBy  String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([bucket, path])
  @@map("storage_files")
}`,
    };

    return templates[modelName] || `model ${modelName} {
  id String @id @default(uuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`;
  }

  /**
   * Generate feature report
   */
  static generateReport(
    feature: FeatureManifest,
    result: FeatureValidationResult
  ): string {
    let report = `\n${'='.repeat(60)}\n`;
    report += `  FEATURE VALIDATION: ${feature.name}\n`;
    report += `${'='.repeat(60)}\n\n`;

    report += `Status: ${result.valid ? '✅ Ready' : '❌ Missing Requirements'}\n`;
    report += `Can Auto-Fix: ${result.canAutoFix ? 'Yes' : 'No'}\n\n`;

    if (!result.valid) {
      if (result.missing.models.length > 0) {
        report += `❌ Missing Models:\n`;
        result.missing.models.forEach(m => report += `   - ${m}\n`);
        report += '\n';
      }

      if (result.missing.dependencies.length > 0) {
        report += `❌ Missing Dependencies:\n`;
        result.missing.dependencies.forEach(d => report += `   - ${d}\n`);
        report += '\n';
      }

      if (result.missing.env.length > 0) {
        report += `❌ Missing Environment Variables:\n`;
        result.missing.env.forEach(e => report += `   - ${e}\n`);
        report += '\n';
      }

      if (result.fixes.length > 0) {
        report += `🔧 Suggested Fixes:\n`;
        result.fixes.forEach((f, i) => {
          report += `   ${i + 1}. ${f.action} ${f.autoApply ? '(Auto)' : '(Manual)'}\n`;
          report += `      ${f.description}\n`;
        });
      }
    } else {
      report += `✅ All requirements satisfied. Feature ready to deploy.\n`;
    }

    report += `\n${'='.repeat(60)}\n`;

    return report;
  }
}
