/**
 * Runtime Validator Service
 * Layer 2: AI + Template Enforcement
 * 
 * Scans generated code for runtime violations before saving to workspace.
 * This is the critical gate that prevents Next.js/React from entering Express workspaces.
 */

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
  autoFixed?: boolean;
  fixedCode?: string;
}

export interface Violation {
  type: 'forbidden_import' | 'forbidden_export' | 'forbidden_dependency' | 'missing_required';
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  suggestion?: string;
}

/**
 * Forbidden patterns for Express-only workspaces
 */
const FORBIDDEN_PATTERNS = {
  imports: [
    /from\s+['"]next['"]/,
    /from\s+['"]next\/[^'"]+['"]/,
    /from\s+['"]react['"]/,
    /from\s+['"]react-dom['"]/,
    /import\s+.*\s+from\s+['"]next['"]/,
    /import\s+.*\s+from\s+['"]react['"]/,
    /import\s+{\s*NextRequest/,
    /import\s+{\s*NextResponse/,
  ],
  exports: [
    /export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(/,
    /export\s+function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(/,
  ],
  types: [
    /:\s*NextRequest/,
    /:\s*NextResponse/,
    /<NextRequest>/,
    /<NextResponse>/,
  ]
};

/**
 * Required patterns for Express workspaces
 */
const REQUIRED_PATTERNS = {
  serverFile: [
    /import\s+express\s+from\s+['"]express['"]/,
    /app\.listen\(/,
  ],
  routeFile: [
    /import\s+express\s+from\s+['"]express['"]/,
    /express\.Router\(\)/,
  ]
};

/**
 * Forbidden dependencies in package.json
 */
const FORBIDDEN_DEPENDENCIES = [
  'next',
  'react',
  'react-dom',
  '@types/react',
  '@types/react-dom',
];

/**
 * Validates generated code against Express-only runtime rules
 */
export class RuntimeValidator {
  /**
   * Validates a code file
   */
  static validateCode(code: string, filename: string): ValidationResult {
    const violations: Violation[] = [];

    // Check for forbidden imports
    FORBIDDEN_PATTERNS.imports.forEach((pattern) => {
      const matches = code.match(new RegExp(pattern, 'g'));
      if (matches) {
        matches.forEach((match) => {
          const lineNumber = this.getLineNumber(code, match);
          violations.push({
            type: 'forbidden_import',
            severity: 'error',
            message: `Forbidden import detected: "${match.trim()}". Express workspaces cannot use Next.js or React.`,
            line: lineNumber,
            suggestion: 'Use Express.js imports instead: import express from "express"',
          });
        });
      }
    });

    // Check for forbidden exports (serverless handlers)
    FORBIDDEN_PATTERNS.exports.forEach((pattern) => {
      const matches = code.match(new RegExp(pattern, 'g'));
      if (matches) {
        matches.forEach((match) => {
          const lineNumber = this.getLineNumber(code, match);
          violations.push({
            type: 'forbidden_export',
            severity: 'error',
            message: `Forbidden export detected: "${match.trim()}". Use Express router pattern instead.`,
            line: lineNumber,
            suggestion: 'Use: router.get("/path", async (req, res) => { ... })',
          });
        });
      }
    });

    // Check for forbidden types
    FORBIDDEN_PATTERNS.types.forEach((pattern) => {
      const matches = code.match(new RegExp(pattern, 'g'));
      if (matches) {
        matches.forEach((match) => {
          const lineNumber = this.getLineNumber(code, match);
          violations.push({
            type: 'forbidden_import',
            severity: 'error',
            message: `Forbidden type detected: "${match.trim()}". Use Express types: Request, Response`,
            line: lineNumber,
            suggestion: 'Use: import { Request, Response } from "express"',
          });
        });
      }
    });

    // Validate server files have required patterns
    if (filename.includes('server.ts') || filename.includes('index.ts')) {
      const hasExpressImport = REQUIRED_PATTERNS.serverFile[0].test(code);
      const hasListen = REQUIRED_PATTERNS.serverFile[1].test(code);

      if (!hasExpressImport) {
        violations.push({
          type: 'missing_required',
          severity: 'error',
          message: 'Server file must import Express.js',
          suggestion: 'Add: import express from "express"',
        });
      }

      if (!hasListen && !filename.includes('route')) {
        violations.push({
          type: 'missing_required',
          severity: 'warning',
          message: 'Server file should call app.listen()',
          suggestion: 'Add: app.listen(PORT, () => console.log("Server running"))',
        });
      }
    }

    // Validate route files
    if (filename.includes('route') || filename.includes('/api/')) {
      const hasExpressImport = /import\s+express/.test(code);
      const hasRouter = /Router\(\)/.test(code) || /router\s*=/.test(code);

      if (!hasExpressImport) {
        violations.push({
          type: 'missing_required',
          severity: 'error',
          message: 'Route file must import Express',
          suggestion: 'Add: import express, { Request, Response } from "express"',
        });
      }

      if (!hasRouter && !filename.includes('type')) {
        violations.push({
          type: 'missing_required',
          severity: 'warning',
          message: 'Route file should create Express router',
          suggestion: 'Add: const router = express.Router()',
        });
      }
    }

    return {
      valid: violations.filter(v => v.severity === 'error').length === 0,
      violations,
    };
  }

  /**
   * Validates package.json dependencies
   */
  static validatePackageJson(packageJson: any): ValidationResult {
    const violations: Violation[] = [];

    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    FORBIDDEN_DEPENDENCIES.forEach((dep) => {
      if (allDeps[dep]) {
        violations.push({
          type: 'forbidden_dependency',
          severity: 'error',
          message: `Forbidden dependency: "${dep}". Express workspaces cannot include Next.js or React.`,
          suggestion: `Remove "${dep}" from package.json`,
        });
      }
    });

    return {
      valid: violations.length === 0,
      violations,
    };
  }

  /**
   * Validates entire workspace structure
   */
  static async validateWorkspace(workspaceId: string, files: Array<{ path: string; content: string }>): Promise<ValidationResult> {
    const allViolations: Violation[] = [];

    for (const file of files) {
      if (file.path.endsWith('.ts') || file.path.endsWith('.js')) {
        const result = this.validateCode(file.content, file.path);
        allViolations.push(...result.violations);
      }

      if (file.path === 'package.json') {
        try {
          const packageJson = JSON.parse(file.content);
          const result = this.validatePackageJson(packageJson);
          allViolations.push(...result.violations);
        } catch (error) {
          allViolations.push({
            type: 'forbidden_dependency',
            severity: 'error',
            message: 'Invalid package.json format',
          });
        }
      }
    }

    return {
      valid: allViolations.filter(v => v.severity === 'error').length === 0,
      violations: allViolations,
    };
  }

  /**
   * Helper: Get line number of a match in code
   */
  private static getLineNumber(code: string, match: string): number {
    const index = code.indexOf(match);
    if (index === -1) return 0;
    return code.substring(0, index).split('\n').length;
  }

  /**
   * Generate human-readable error message
   */
  static formatViolations(violations: Violation[]): string {
    if (violations.length === 0) return '✅ No violations found';

    const errors = violations.filter(v => v.severity === 'error');
    const warnings = violations.filter(v => v.severity === 'warning');

    let message = '❌ Runtime violations detected:\n\n';

    if (errors.length > 0) {
      message += `**Errors (${errors.length}):**\n`;
      errors.forEach((v, i) => {
        message += `${i + 1}. ${v.message}`;
        if (v.line) message += ` (line ${v.line})`;
        if (v.suggestion) message += `\n   💡 ${v.suggestion}`;
        message += '\n';
      });
    }

    if (warnings.length > 0) {
      message += `\n**Warnings (${warnings.length}):**\n`;
      warnings.forEach((v, i) => {
        message += `${i + 1}. ${v.message}`;
        if (v.line) message += ` (line ${v.line})`;
        if (v.suggestion) message += `\n   💡 ${v.suggestion}`;
        message += '\n';
      });
    }

    message += '\n🔒 This workspace is Express.js-only. Next.js and React are forbidden.';

    return message;
  }
}
