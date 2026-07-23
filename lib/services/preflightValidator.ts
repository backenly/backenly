/**
 * Preflight Validator
 * Solution 2: Validate Before Deploy
 * 
 * Three-stage validation:
 * 1. Schema-Code Alignment
 * 2. TypeScript Strict Build
 * 3. Capability Completeness
 */

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface PreflightResult {
  passed: boolean;
  stage: 'schema' | 'typescript' | 'capabilities' | 'complete';
  errors: ValidationError[];
  warnings: string[];
  canDeploy: boolean;
}

export interface ValidationError {
  stage: string;
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

/**
 * Preflight Validator
 * Runs comprehensive pre-deploy validation
 */
export class PreflightValidator {
  private workspacePath: string;

  constructor(workspaceId: string) {
    this.workspacePath = path.join(process.cwd(), 'workspace', workspaceId);
  }

  /**
   * Run full preflight validation
   */
  async validate(): Promise<PreflightResult> {
    const errors: ValidationError[] = [];
    const warnings: string[] = [];

    // Stage 1: Schema-Code Validation
    console.log('[Preflight] Stage 1: Schema-Code Alignment...');
    const schemaResult = await this.validateSchemaCodeAlignment();
    errors.push(...schemaResult.errors);
    warnings.push(...schemaResult.warnings);

    if (!schemaResult.passed) {
      return {
        passed: false,
        stage: 'schema',
        errors,
        warnings,
        canDeploy: false,
      };
    }

    // Stage 2: TypeScript Strict Build
    console.log('[Preflight] Stage 2: TypeScript Validation...');
    const tsResult = await this.validateTypeScript();
    errors.push(...tsResult.errors);
    warnings.push(...tsResult.warnings);

    if (!tsResult.passed) {
      return {
        passed: false,
        stage: 'typescript',
        errors,
        warnings,
        canDeploy: false,
      };
    }

    // Stage 3: Capability Completeness
    console.log('[Preflight] Stage 3: Capability Check...');
    const capabilityResult = await this.validateCapabilities();
    errors.push(...capabilityResult.errors);
    warnings.push(...capabilityResult.warnings);

    if (!capabilityResult.passed) {
      return {
        passed: false,
        stage: 'capabilities',
        errors,
        warnings,
        canDeploy: false,
      };
    }

    console.log('[Preflight] ✅ All checks passed');

    return {
      passed: true,
      stage: 'complete',
      errors,
      warnings,
      canDeploy: true,
    };
  }

  /**
   * Stage 1: Schema-Code Alignment
   * Ensures Prisma models match code usage
   */
  private async validateSchemaCodeAlignment(): Promise<{
    passed: boolean;
    errors: ValidationError[];
    warnings: string[];
  }> {
    const errors: ValidationError[] = [];
    const warnings: string[] = [];

    try {
      // Parse Prisma schema
      const schemaPath = path.join(this.workspacePath, 'prisma', 'schema.prisma');
      const schemaContent = await fs.readFile(schemaPath, 'utf-8');
      const models = this.extractPrismaModels(schemaContent);

      // Scan all TypeScript files for Prisma usage
      const tsFiles = await this.findTypeScriptFiles(this.workspacePath);

      for (const file of tsFiles) {
        const content = await fs.readFile(file, 'utf-8');
        const relativePath = path.relative(this.workspacePath, file);

        // Check for prisma.modelName usage
        const prismaUsageRegex = /prisma\.(\w+)\./g;
        let match;

        while ((match = prismaUsageRegex.exec(content)) !== null) {
          const modelName = match[1];

          // Check if model exists in schema
          if (!models.includes(modelName)) {
            errors.push({
              stage: 'schema',
              severity: 'error',
              message: `Model "${modelName}" used in code but not defined in Prisma schema`,
              file: relativePath,
              line: this.getLineNumber(content, match.index),
              suggestion: `Add "model ${modelName}" to prisma/schema.prisma`,
            });
          }
        }

        // Check for optional field handling
        const optionalAccessRegex = /(\w+)\?\.(\w+)/g;
        while ((match = optionalAccessRegex.exec(content)) !== null) {
          warnings.push(`Optional chaining found at ${relativePath}:${this.getLineNumber(content, match.index)}`);
        }
      }

      // Validate schema syntax
      try {
        await execAsync('npx prisma validate', {
          cwd: this.workspacePath,
        });
      } catch (error: any) {
        errors.push({
          stage: 'schema',
          severity: 'error',
          message: 'Prisma schema validation failed',
          file: 'prisma/schema.prisma',
          suggestion: 'Run "npx prisma validate" locally to see details',
        });
      }

      return {
        passed: errors.length === 0,
        errors,
        warnings,
      };

    } catch (error: any) {
      errors.push({
        stage: 'schema',
        severity: 'error',
        message: `Schema validation failed: ${error.message}`,
      });

      return { passed: false, errors, warnings };
    }
  }

  /**
   * Stage 2: TypeScript Strict Build
   * Ensures code compiles without errors
   */
  private async validateTypeScript(): Promise<{
    passed: boolean;
    errors: ValidationError[];
    warnings: string[];
  }> {
    const errors: ValidationError[] = [];
    const warnings: string[] = [];

    try {
      // Run tsc --noEmit for type checking only
      const { stdout, stderr } = await execAsync('npx tsc --noEmit', {
        cwd: this.workspacePath,
      });

      // Parse TypeScript errors
      if (stderr) {
        const errorLines = stderr.split('\n');

        for (const line of errorLines) {
          if (line.includes('error TS')) {
            // Parse: path/file.ts(line,col): error TS#### message
            const match = line.match(/(.+?)\((\d+),\d+\): error TS\d+: (.+)/);

            if (match) {
              errors.push({
                stage: 'typescript',
                severity: 'error',
                message: match[3],
                file: match[1],
                line: parseInt(match[2]),
              });
            } else {
              errors.push({
                stage: 'typescript',
                severity: 'error',
                message: line.trim(),
              });
            }
          }
        }
      }

      return {
        passed: errors.length === 0,
        errors,
        warnings,
      };

    } catch (error: any) {
      // tsc exits with non-zero on errors
      const stderr = error.stderr || error.message;
      const errorLines = stderr.split('\n');

      for (const line of errorLines) {
        if (line.includes('error TS')) {
          const match = line.match(/(.+?)\((\d+),\d+\): error TS\d+: (.+)/);

          if (match) {
            errors.push({
              stage: 'typescript',
              severity: 'error',
              message: match[3],
              file: match[1],
              line: parseInt(match[2]),
            });
          }
        }
      }

      return { passed: false, errors, warnings };
    }
  }

  /**
   * Stage 3: Capability Completeness
   * Ensures features have required dependencies
   */
  private async validateCapabilities(): Promise<{
    passed: boolean;
    errors: ValidationError[];
    warnings: string[];
  }> {
    const errors: ValidationError[] = [];
    const warnings: string[] = [];

    try {
      // Check package.json
      const packageJsonPath = path.join(this.workspacePath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Required base dependencies
      const requiredDeps = ['express', '@prisma/client', 'prisma'];

      for (const dep of requiredDeps) {
        if (!allDeps[dep]) {
          errors.push({
            stage: 'capabilities',
            severity: 'error',
            message: `Missing required dependency: "${dep}"`,
            file: 'package.json',
            suggestion: `Add "${dep}" to dependencies`,
          });
        }
      }

      // Feature-specific checks
      const schemaPath = path.join(this.workspacePath, 'prisma', 'schema.prisma');
      const schemaContent = await fs.readFile(schemaPath, 'utf-8');

      // Check: If auth routes exist, check for required models
      const hasAuthRoutes = await this.fileExists(path.join(this.workspacePath, 'routes', 'auth.ts'));
      if (hasAuthRoutes) {
        if (!schemaContent.includes('model User')) {
          errors.push({
            stage: 'capabilities',
            severity: 'error',
            message: 'Auth routes exist but User model not found in schema',
            file: 'prisma/schema.prisma',
            suggestion: 'Add User model or remove auth routes',
          });
        }
      }

      // Check: If payment routes exist, check for Payment model
      const hasPaymentRoutes = await this.fileExists(path.join(this.workspacePath, 'routes', 'payments.ts'));
      if (hasPaymentRoutes) {
        if (!schemaContent.includes('model Payment')) {
          errors.push({
            stage: 'capabilities',
            severity: 'error',
            message: 'Payment routes exist but Payment model not found in schema',
            file: 'prisma/schema.prisma',
            suggestion: 'Add Payment model or remove payment routes',
          });
        }
      }

      // Check: If file uploads exist, check for multer
      const hasFileUploads = await this.searchInFiles('multer', this.workspacePath);
      if (hasFileUploads && !allDeps['multer']) {
        errors.push({
          stage: 'capabilities',
          severity: 'error',
          message: 'File upload code found but multer not installed',
          file: 'package.json',
          suggestion: 'Add "multer" to dependencies',
        });
      }

      return {
        passed: errors.length === 0,
        errors,
        warnings,
      };

    } catch (error: any) {
      errors.push({
        stage: 'capabilities',
        severity: 'error',
        message: `Capability check failed: ${error.message}`,
      });

      return { passed: false, errors, warnings };
    }
  }

  /**
   * Helper: Extract Prisma model names
   */
  private extractPrismaModels(schema: string): string[] {
    const modelRegex = /model\s+(\w+)\s*{/g;
    const models: string[] = [];
    let match;

    while ((match = modelRegex.exec(schema)) !== null) {
      models.push(match[1]);
    }

    return models;
  }

  /**
   * Helper: Find all TypeScript files
   */
  private async findTypeScriptFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (['node_modules', 'dist', '.git'].includes(entry.name)) {
          continue;
        }

        if (entry.isDirectory()) {
          const subFiles = await this.findTypeScriptFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.name.endsWith('.ts')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Directory doesn't exist
    }

    return files;
  }

  /**
   * Helper: Get line number from index
   */
  private getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split('\n').length;
  }

  /**
   * Helper: Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Helper: Search for text in files
   */
  private async searchInFiles(searchTerm: string, dir: string): Promise<boolean> {
    const files = await this.findTypeScriptFiles(dir);

    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      if (content.includes(searchTerm)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate human-readable report
   */
  static generateReport(result: PreflightResult): string {
    let report = '\n' + '='.repeat(60) + '\n';
    report += '  PREFLIGHT VALIDATION REPORT\n';
    report += '='.repeat(60) + '\n\n';

    report += `Status: ${result.passed ? '✅ PASSED' : '❌ FAILED'}\n`;
    report += `Stage: ${result.stage}\n`;
    report += `Can Deploy: ${result.canDeploy ? 'YES' : 'NO'}\n\n`;

    if (result.errors.length > 0) {
      report += `❌ ERRORS (${result.errors.length}):\n\n`;

      result.errors.forEach((error, i) => {
        report += `${i + 1}. [${error.stage.toUpperCase()}] ${error.message}\n`;
        if (error.file) report += `   File: ${error.file}`;
        if (error.line) report += `:${error.line}`;
        if (error.file || error.line) report += '\n';
        if (error.suggestion) report += `   💡 ${error.suggestion}\n`;
        report += '\n';
      });
    }

    if (result.warnings.length > 0) {
      report += `⚠️  WARNINGS (${result.warnings.length}):\n`;
      result.warnings.forEach((warning, i) => {
        report += `${i + 1}. ${warning}\n`;
      });
      report += '\n';
    }

    if (result.passed) {
      report += '✅ All validation stages passed. Ready for deployment.\n';
    } else {
      report += '❌ Validation failed. Fix errors before deploying.\n';
    }

    report += '\n' + '='.repeat(60) + '\n';

    return report;
  }
}
