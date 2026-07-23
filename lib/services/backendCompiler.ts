/**
 * Backend Compiler Service
 * Solution 1: Ship Prebuilt Backends
 * 
 * Compiles workspace from TypeScript to production-ready JavaScript.
 * NO TypeScript or Prisma generation happens in production.
 */

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface CompilationResult {
  success: boolean;
  outputPath: string;
  errors: string[];
  warnings: string[];
  manifest: DeployManifest;
}

export interface DeployManifest {
  version: string;
  runtime: 'node';
  startCommand: string;
  buildTime: string;
  files: {
    javascript: number;
    prisma: number;
    dependencies: string[];
  };
  env: string[];
  healthcheck: string;
}

/**
 * Backend Compiler
 * Transforms source workspace into production-ready deployment
 */
export class BackendCompiler {
  private workspacePath: string;
  private outputPath: string;

  constructor(workspaceId: string) {
    this.workspacePath = path.join(process.cwd(), 'workspace', workspaceId);
    this.outputPath = path.join(process.cwd(), 'tmp', 'builds', workspaceId);
  }

  /**
   * Full compilation pipeline
   */
  async compile(): Promise<CompilationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Step 1: Clean output directory
      await this.cleanOutput();

      // Step 2: Install dependencies (locally for build)
      console.log('[Compiler] Installing dependencies...');
      await this.installDependencies();

      // Step 3: Generate Prisma Client (BEFORE compilation)
      console.log('[Compiler] Generating Prisma Client...');
      const prismaResult = await this.generatePrismaClient();
      if (!prismaResult.success) {
        errors.push(...prismaResult.errors);
        return {
          success: false,
          outputPath: this.outputPath,
          errors,
          warnings,
          manifest: this.createEmptyManifest(),
        };
      }

      // Step 4: Compile TypeScript
      console.log('[Compiler] Compiling TypeScript...');
      const compileResult = await this.compileTypeScript();
      if (!compileResult.success) {
        errors.push(...compileResult.errors);
        return {
          success: false,
          outputPath: this.outputPath,
          errors,
          warnings,
          manifest: this.createEmptyManifest(),
        };
      }

      // Step 5: Copy runtime files
      console.log('[Compiler] Copying runtime files...');
      await this.copyRuntimeFiles();

      // Step 6: Lock dependencies (production only)
      console.log('[Compiler] Locking production dependencies...');
      await this.lockDependencies();

      // Step 7: Generate deployment manifest
      console.log('[Compiler] Generating manifest...');
      const manifest = await this.generateManifest();

      // Step 8: Create start script
      await this.createStartScript();

      console.log('[Compiler] ✅ Compilation complete');

      return {
        success: true,
        outputPath: this.outputPath,
        errors,
        warnings,
        manifest,
      };

    } catch (error: any) {
      errors.push(`Compilation failed: ${error.message}`);
      return {
        success: false,
        outputPath: this.outputPath,
        errors,
        warnings,
        manifest: this.createEmptyManifest(),
      };
    }
  }

  /**
   * Step 1: Clean output directory
   */
  private async cleanOutput(): Promise<void> {
    try {
      await fs.rm(this.outputPath, { recursive: true, force: true });
      await fs.mkdir(this.outputPath, { recursive: true });
    } catch (error) {
      // Directory doesn't exist, create it
      await fs.mkdir(this.outputPath, { recursive: true });
    }
  }

  /**
   * Step 2: Install dependencies for build
   */
  private async installDependencies(): Promise<void> {
    await execAsync('npm install --include=dev', {
      cwd: this.workspacePath,
    });
  }

  /**
   * Step 3: Generate Prisma Client (build-time)
   */
  private async generatePrismaClient(): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      const { stdout, stderr } = await execAsync('npx prisma generate', {
        cwd: this.workspacePath,
      });

      if (stderr && stderr.includes('error')) {
        errors.push(`Prisma generation failed: ${stderr}`);
        return { success: false, errors };
      }

      return { success: true, errors };
    } catch (error: any) {
      errors.push(`Prisma generation failed: ${error.message}`);
      return { success: false, errors };
    }
  }

  /**
   * Step 4: Compile TypeScript to JavaScript
   */
  private async compileTypeScript(): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      // Use project's tsconfig to compile
      const { stdout, stderr } = await execAsync('npx tsc', {
        cwd: this.workspacePath,
      });

      if (stderr && stderr.includes('error')) {
        errors.push(`TypeScript compilation failed: ${stderr}`);
        return { success: false, errors };
      }

      return { success: true, errors };
    } catch (error: any) {
      errors.push(`TypeScript compilation failed: ${error.message}`);
      return { success: false, errors };
    }
  }

  /**
   * Step 5: Copy runtime files to output
   */
  private async copyRuntimeFiles(): Promise<void> {
    // Copy compiled JavaScript
    const distPath = path.join(this.workspacePath, 'dist');
    const targetDistPath = path.join(this.outputPath, 'dist');
    await this.copyDirectory(distPath, targetDistPath);

    // Copy Prisma schema
    const prismaPath = path.join(this.workspacePath, 'prisma');
    const targetPrismaPath = path.join(this.outputPath, 'prisma');
    await this.copyDirectory(prismaPath, targetPrismaPath);

    // Copy generated Prisma Client
    const prismaClientPath = path.join(this.workspacePath, 'node_modules', '@prisma', 'client');
    const targetClientPath = path.join(this.outputPath, 'node_modules', '@prisma', 'client');
    await fs.mkdir(path.dirname(targetClientPath), { recursive: true });
    await this.copyDirectory(prismaClientPath, targetClientPath);

    // Copy .prisma directory (generated files)
    const dotPrismaPath = path.join(this.workspacePath, 'node_modules', '.prisma');
    const targetDotPrismaPath = path.join(this.outputPath, 'node_modules', '.prisma');
    await this.copyDirectory(dotPrismaPath, targetDotPrismaPath);
  }

  /**
   * Step 6: Lock production dependencies
   */
  private async lockDependencies(): Promise<void> {
    // Copy package.json (production deps only)
    const packageJsonPath = path.join(this.workspacePath, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

    // Remove devDependencies - not needed in production
    const prodPackageJson = {
      name: packageJson.name,
      version: packageJson.version,
      scripts: {
        start: 'node dist/src/server.js',
      },
      dependencies: packageJson.dependencies,
      engines: packageJson.engines,
    };

    await fs.writeFile(
      path.join(this.outputPath, 'package.json'),
      JSON.stringify(prodPackageJson, null, 2)
    );

    // Install ONLY production dependencies
    await execAsync('npm install --production', {
      cwd: this.outputPath,
    });
  }

  /**
   * Step 7: Generate deployment manifest
   */
  private async generateManifest(): Promise<DeployManifest> {
    const packageJsonPath = path.join(this.workspacePath, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

    // Count files
    const jsFiles = await this.countFiles(path.join(this.outputPath, 'dist'), '.js');
    const prismaFiles = await this.countFiles(path.join(this.outputPath, 'prisma'), '.prisma');

    return {
      version: packageJson.version || '1.0.0',
      runtime: 'node',
      startCommand: 'node dist/src/server.js',
      buildTime: new Date().toISOString(),
      files: {
        javascript: jsFiles,
        prisma: prismaFiles,
        dependencies: Object.keys(packageJson.dependencies || {}),
      },
      env: [
        'DATABASE_URL',
        'PORT',
        'NODE_ENV',
        'PROJECT_ID',
        'BACKENLY_API_URL',
        'BACKENLY_API_KEY',
      ],
      healthcheck: '/api/health',
    };
  }

  /**
   * Step 8: Create start script
   */
  private async createStartScript(): Promise<void> {
    const startScript = `#!/bin/sh
# Backenly Production Start Script
# Generated: ${new Date().toISOString()}

echo "🚀 Starting Backenly application..."

# Set production environment
export NODE_ENV=production

# Start server
exec node dist/src/server.js
`;

    await fs.writeFile(path.join(this.outputPath, 'start.sh'), startScript);
    await fs.chmod(path.join(this.outputPath, 'start.sh'), 0o755);
  }

  /**
   * Helper: Copy directory recursively
   */
  private async copyDirectory(source: string, target: string): Promise<void> {
    await fs.mkdir(target, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(sourcePath, targetPath);
      } else {
        await fs.copyFile(sourcePath, targetPath);
      }
    }
  }

  /**
   * Helper: Count files with extension
   */
  private async countFiles(dir: string, ext: string): Promise<number> {
    let count = 0;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          count += await this.countFiles(fullPath, ext);
        } else if (entry.name.endsWith(ext)) {
          count++;
        }
      }
    } catch (error) {
      // Directory doesn't exist
    }

    return count;
  }

  /**
   * Helper: Create empty manifest
   */
  private createEmptyManifest(): DeployManifest {
    return {
      version: '0.0.0',
      runtime: 'node',
      startCommand: 'node dist/src/server.js',
      buildTime: new Date().toISOString(),
      files: {
        javascript: 0,
        prisma: 0,
        dependencies: [],
      },
      env: [],
      healthcheck: '/api/health',
    };
  }
}
