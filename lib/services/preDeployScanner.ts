/**
 * Pre-Deploy Runtime Scanner
 * Layer 3: Pre-Deploy Gate
 * 
 * Scans workspace before deployment to ensure Express-only compliance.
 * This is the final safety net that prevents broken deploys.
 */

import fs from 'fs/promises';
import path from 'path';
import { RuntimeValidator, ValidationResult, Violation } from './runtimeValidator';

export interface DeployCheckResult {
  canDeploy: boolean;
  violations: Violation[];
  summary: {
    filesScanned: number;
    errors: number;
    warnings: number;
  };
  message: string;
}

/**
 * Pre-Deploy Scanner
 * Performs comprehensive workspace validation before allowing deployment
 */
export class PreDeployScanner {
  /**
   * Scan workspace directory for runtime violations
   */
  static async scanWorkspace(workspacePath: string): Promise<DeployCheckResult> {
    const violations: Violation[] = [];
    let filesScanned = 0;

    try {
      // Check if workspace exists
      const workspaceExists = await this.directoryExists(workspacePath);
      if (!workspaceExists) {
        return {
          canDeploy: false,
          violations: [{
            type: 'missing_required',
            severity: 'error',
            message: `Workspace directory not found: ${workspacePath}`,
          }],
          summary: { filesScanned: 0, errors: 1, warnings: 0 },
          message: '❌ Workspace directory not found',
        };
      }

      // 1. Validate package.json
      const packageJsonPath = path.join(workspacePath, 'package.json');
      const packageJsonExists = await this.fileExists(packageJsonPath);
      
      if (!packageJsonExists) {
        violations.push({
          type: 'missing_required',
          severity: 'error',
          message: 'package.json not found',
          suggestion: 'Create a package.json with Express dependencies',
        });
      } else {
        const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageJsonContent);
        const pkgResult = RuntimeValidator.validatePackageJson(packageJson);
        violations.push(...pkgResult.violations);
        filesScanned++;

        // Check for required Express dependencies
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (!deps.express) {
          violations.push({
            type: 'missing_required',
            severity: 'error',
            message: 'Express.js not found in dependencies',
            suggestion: 'Add "express": "^4.18.2" to dependencies',
          });
        }
        if (!deps.typescript && !packageJson.dependencies?.typescript) {
          violations.push({
            type: 'missing_required',
            severity: 'warning',
            message: 'TypeScript not found in dependencies',
            suggestion: 'Add "typescript": "^5.0.0" to devDependencies',
          });
        }
      }

      // 2. Validate server entry point
      const serverFiles = ['src/server.ts', 'src/index.ts', 'server.ts', 'index.ts'];
      let serverFound = false;

      for (const serverFile of serverFiles) {
        const serverPath = path.join(workspacePath, serverFile);
        if (await this.fileExists(serverPath)) {
          const content = await fs.readFile(serverPath, 'utf-8');
          const result = RuntimeValidator.validateCode(content, serverFile);
          violations.push(...result.violations);
          filesScanned++;
          serverFound = true;

          // Check for app.listen()
          if (!content.includes('app.listen') && !content.includes('.listen(')) {
            violations.push({
              type: 'missing_required',
              severity: 'error',
              message: `Server file ${serverFile} must call app.listen()`,
              suggestion: 'Add: app.listen(PORT, () => console.log("Server running on port", PORT))',
            });
          }
          break;
        }
      }

      if (!serverFound) {
        violations.push({
          type: 'missing_required',
          severity: 'error',
          message: 'No server entry point found (server.ts or index.ts)',
          suggestion: 'Create src/server.ts with Express app initialization',
        });
      }

      // 3. Scan all TypeScript/JavaScript files
      const codeFiles = await this.findCodeFiles(workspacePath);
      for (const file of codeFiles) {
        const relativePath = path.relative(workspacePath, file);
        
        // Skip node_modules and dist
        if (relativePath.includes('node_modules') || relativePath.includes('dist')) {
          continue;
        }

        const content = await fs.readFile(file, 'utf-8');
        const result = RuntimeValidator.validateCode(content, relativePath);
        
        if (result.violations.length > 0) {
          violations.push(...result.violations);
        }
        filesScanned++;
      }

      // Generate summary
      const errors = violations.filter(v => v.severity === 'error').length;
      const warnings = violations.filter(v => v.severity === 'warning').length;

      const canDeploy = errors === 0;

      return {
        canDeploy,
        violations,
        summary: {
          filesScanned,
          errors,
          warnings,
        },
        message: this.generateMessage(canDeploy, filesScanned, errors, warnings),
      };

    } catch (error: any) {
      return {
        canDeploy: false,
        violations: [{
          type: 'forbidden_dependency',
          severity: 'error',
          message: `Scan failed: ${error.message}`,
        }],
        summary: { filesScanned, errors: 1, warnings: 0 },
        message: `❌ Pre-deploy scan failed: ${error.message}`,
      };
    }
  }

  /**
   * Quick validation check (for API calls)
   */
  static async quickCheck(workspacePath: string): Promise<boolean> {
    const result = await this.scanWorkspace(workspacePath);
    return result.canDeploy;
  }

  /**
   * Find all code files in workspace
   */
  private static async findCodeFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip node_modules, dist, .git
        if (['node_modules', 'dist', '.git', '.next'].includes(entry.name)) {
          continue;
        }

        if (entry.isDirectory()) {
          const subFiles = await this.findCodeFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Directory doesn't exist or can't be read
    }

    return files;
  }

  /**
   * Check if file exists
   */
  private static async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if directory exists
   */
  private static async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Generate human-readable message
   */
  private static generateMessage(
    canDeploy: boolean,
    filesScanned: number,
    errors: number,
    warnings: number
  ): string {
    if (canDeploy) {
      return `✅ Pre-deploy scan passed! Scanned ${filesScanned} files. ${warnings > 0 ? `${warnings} warnings found.` : 'No issues found.'}`;
    }

    return `❌ Pre-deploy scan failed! Found ${errors} error${errors > 1 ? 's' : ''} and ${warnings} warning${warnings > 1 ? 's' : ''} in ${filesScanned} files.\n\nThis workspace violates Express.js-only runtime rules. Deploy blocked.`;
  }

  /**
   * Generate detailed report for user
   */
  static generateReport(result: DeployCheckResult): string {
    let report = `\n${'='.repeat(60)}\n`;
    report += `  PRE-DEPLOY RUNTIME SCAN REPORT\n`;
    report += `${'='.repeat(60)}\n\n`;

    report += `📊 Summary:\n`;
    report += `   Files Scanned: ${result.summary.filesScanned}\n`;
    report += `   Errors: ${result.summary.errors}\n`;
    report += `   Warnings: ${result.summary.warnings}\n`;
    report += `   Status: ${result.canDeploy ? '✅ PASSED' : '❌ FAILED'}\n\n`;

    if (result.violations.length > 0) {
      report += `🔍 Violations:\n\n`;
      
      const errors = result.violations.filter(v => v.severity === 'error');
      const warnings = result.violations.filter(v => v.severity === 'warning');

      if (errors.length > 0) {
        report += `❌ ERRORS:\n`;
        errors.forEach((v, i) => {
          report += `   ${i + 1}. ${v.message}`;
          if (v.line) report += ` (line ${v.line})`;
          report += '\n';
          if (v.suggestion) report += `      💡 ${v.suggestion}\n`;
        });
        report += '\n';
      }

      if (warnings.length > 0) {
        report += `⚠️  WARNINGS:\n`;
        warnings.forEach((v, i) => {
          report += `   ${i + 1}. ${v.message}`;
          if (v.line) report += ` (line ${v.line})`;
          report += '\n';
          if (v.suggestion) report += `      💡 ${v.suggestion}\n`;
        });
      }
    }

    if (result.canDeploy) {
      report += `\n✅ Deployment allowed. Runtime integrity verified.\n`;
    } else {
      report += `\n❌ Deployment BLOCKED.\n`;
      report += `   Fix the errors above before deploying.\n`;
      report += `   This workspace must be Express.js-only.\n`;
    }

    report += `\n${'='.repeat(60)}\n`;

    return report;
  }
}
