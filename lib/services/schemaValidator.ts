/**
 * Schema Validator Service
 * 
 * Detects mismatches between:
 * - Zod validation schemas (route input)
 * - Prisma database models
 * 
 * This prevents runtime failures caused by schema drift.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';

export interface SchemaIssue {
  type: 'missing_in_db' | 'type_mismatch' | 'required_mismatch' | 'unknown_field';
  field: string;
  zodType?: string;
  prismaType?: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface RouteSchemaValidation {
  route: string;
  method: string;
  modelName?: string;
  isValid: boolean;
  issues: SchemaIssue[];
}

export interface PrismaField {
  name: string;
  type: string;
  isOptional: boolean;
  isArray: boolean;
  isRelation: boolean;
}

export interface PrismaModel {
  name: string;
  fields: PrismaField[];
}

/**
 * Parse Prisma schema file and extract model definitions
 */
export function parsePrismaSchema(schemaPath: string): Map<string, PrismaModel> {
  const models = new Map<string, PrismaModel>();
  
  if (!fs.existsSync(schemaPath)) {
    return models;
  }

  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
  const modelRegex = /model\s+(\w+)\s*\{([^}]+)\}/g;
  
  let match;
  while ((match = modelRegex.exec(schemaContent)) !== null) {
    const modelName = match[1];
    const modelBody = match[2];
    
    const fields: PrismaField[] = [];
    const fieldLines = modelBody.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('@@'));
    
    for (const line of fieldLines) {
      // Parse field: fieldName Type modifiers
      const fieldMatch = line.match(/^(\w+)\s+(\w+)(\[\])?\??/);
      if (fieldMatch) {
        const fieldName = fieldMatch[1];
        const fieldType = fieldMatch[2];
        const isArray = !!fieldMatch[3];
        const isOptional = line.includes('?');
        
        // Detect relations (capitalized types that aren't base Prisma types)
        const baseTypes = ['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Decimal', 'BigInt'];
        const isRelation = !baseTypes.includes(fieldType) && fieldType[0] === fieldType[0].toUpperCase();
        
        fields.push({
          name: fieldName,
          type: fieldType,
          isOptional,
          isArray,
          isRelation,
        });
      }
    }
    
    models.set(modelName, { name: modelName, fields });
  }
  
  return models;
}

/**
 * Extract Zod schema from route file
 * This is a simple heuristic - looks for z.object() definitions
 */
export function extractZodSchema(routeFilePath: string): Map<string, any> {
  const schemas = new Map<string, any>();
  
  if (!fs.existsSync(routeFilePath)) {
    return schemas;
  }

  const content = fs.readFileSync(routeFilePath, 'utf-8');
  
  // Look for schema definitions like: const bookSchema = z.object({...})
  const schemaRegex = /const\s+(\w+Schema)\s*=\s*z\.object\(\{([^}]+)\}\)/g;
  
  let match;
  while ((match = schemaRegex.exec(content)) !== null) {
    const schemaName = match[1];
    const schemaBody = match[2];
    
    // Parse fields from Zod schema
    const fields: Record<string, { type: string; optional: boolean }> = {};
    const fieldLines = schemaBody.split(',').map(l => l.trim()).filter(l => l);
    
    for (const line of fieldLines) {
      // Parse: fieldName: z.type().optional()
      const fieldMatch = line.match(/(\w+)\s*:\s*z\.(\w+)\([^)]*\)(\.optional\(\))?/);
      if (fieldMatch) {
        const fieldName = fieldMatch[1];
        const zodType = fieldMatch[2];
        const isOptional = !!fieldMatch[3];
        
        fields[fieldName] = { type: zodType, optional: isOptional };
      }
    }
    
    schemas.set(schemaName, fields);
  }
  
  return schemas;
}

/**
 * Map Zod types to Prisma types
 */
function mapZodTypeToPrisma(zodType: string): string {
  const mapping: Record<string, string> = {
    'string': 'String',
    'number': 'Int',
    'boolean': 'Boolean',
    'date': 'DateTime',
    'array': 'Array',
    'object': 'Json',
  };
  
  return mapping[zodType.toLowerCase()] || zodType;
}

/**
 * Validate Zod schema against Prisma model
 */
export function validateSchemaMatch(
  zodFields: Record<string, { type: string; optional: boolean }>,
  prismaModel: PrismaModel
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  
  // Filter out relation fields and auto-generated fields
  const dataFields = prismaModel.fields.filter(f => 
    !f.isRelation && 
    f.name !== 'id' && 
    f.name !== 'createdAt' && 
    f.name !== 'updatedAt'
  );
  
  // Check each Zod field
  for (const [fieldName, zodField] of Object.entries(zodFields)) {
    const prismaField = dataFields.find(f => f.name === fieldName);
    
    if (!prismaField) {
      issues.push({
        type: 'missing_in_db',
        field: fieldName,
        zodType: zodField.type,
        severity: 'error',
        message: `Field "${fieldName}" exists in validation schema but not in database model`,
      });
      continue;
    }
    
    // Type check
    const mappedZodType = mapZodTypeToPrisma(zodField.type);
    if (mappedZodType !== prismaField.type) {
      issues.push({
        type: 'type_mismatch',
        field: fieldName,
        zodType: zodField.type,
        prismaType: prismaField.type,
        severity: 'error',
        message: `Field "${fieldName}" type mismatch: Zod expects ${zodField.type} but DB has ${prismaField.type}`,
      });
    }
    
    // Optional/required mismatch
    if (!zodField.optional && prismaField.isOptional) {
      issues.push({
        type: 'required_mismatch',
        field: fieldName,
        severity: 'warning',
        message: `Field "${fieldName}" is required in Zod but optional in DB (may cause validation issues)`,
      });
    }
  }
  
  // Check for required DB fields not in Zod schema
  for (const prismaField of dataFields) {
    if (!prismaField.isOptional && !zodFields[prismaField.name]) {
      issues.push({
        type: 'missing_in_db',
        field: prismaField.name,
        prismaType: prismaField.type,
        severity: 'error',
        message: `Required DB field "${prismaField.name}" is missing from validation schema`,
      });
    }
  }
  
  return issues;
}

/**
 * Validate all routes in a workspace
 */
export async function validateWorkspaceSchemas(projectId: string): Promise<RouteSchemaValidation[]> {
  const workspaceRoot = path.join(process.cwd(), 'workspace', projectId);
  const schemaPath = path.join(workspaceRoot, 'prisma', 'schema.prisma');
  const routesPath = path.join(workspaceRoot, 'routes');
  
  const results: RouteSchemaValidation[] = [];
  
  // Parse Prisma schema
  const prismaModels = parsePrismaSchema(schemaPath);
  
  if (prismaModels.size === 0) {
    return results; // No schema to validate against
  }
  
  // Check each route file
  if (!fs.existsSync(routesPath)) {
    return results;
  }
  
  const routeFiles = fs.readdirSync(routesPath).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
  
  for (const file of routeFiles) {
    const routePath = path.join(routesPath, file);
    const routeName = `/${file.replace(/\.(ts|js)$/, '')}`;
    
    // Extract Zod schemas from route
    const zodSchemas = extractZodSchema(routePath);
    
    for (const [schemaName, zodFields] of Array.from(zodSchemas.entries())) {
      // Try to match schema to Prisma model
      // Convention: bookSchema -> Book model
      const modelName = schemaName
        .replace(/Schema$/i, '')
        .charAt(0).toUpperCase() + schemaName.replace(/Schema$/i, '').slice(1);
      
      const prismaModel = prismaModels.get(modelName);
      
      if (!prismaModel) {
        results.push({
          route: routeName,
          method: 'POST', // Assume POST for input schemas
          modelName,
          isValid: false,
          issues: [{
            type: 'missing_in_db',
            field: modelName,
            severity: 'warning',
            message: `Could not find Prisma model "${modelName}" for schema "${schemaName}"`,
          }],
        });
        continue;
      }
      
      // Validate schema match
      const issues = validateSchemaMatch(zodFields, prismaModel);
      
      results.push({
        route: routeName,
        method: 'POST',
        modelName,
        isValid: issues.filter(i => i.severity === 'error').length === 0,
        issues,
      });
    }
  }
  
  return results;
}

/**
 * Get human-readable validation report
 */
export function formatValidationReport(validations: RouteSchemaValidation[]): string {
  let report = '=== Schema Validation Report ===\n\n';
  
  const errors = validations.filter(v => !v.isValid);
  const warnings = validations.filter(v => v.isValid && v.issues.some(i => i.severity === 'warning'));
  
  if (errors.length === 0 && warnings.length === 0) {
    report += '✅ All schemas are valid!\n';
    return report;
  }
  
  if (errors.length > 0) {
    report += `❌ ${errors.length} route(s) with errors:\n\n`;
    
    for (const validation of errors) {
      report += `Route: ${validation.method} ${validation.route}\n`;
      report += `Model: ${validation.modelName}\n`;
      
      for (const issue of validation.issues.filter(i => i.severity === 'error')) {
        report += `  ❌ ${issue.message}\n`;
      }
      report += '\n';
    }
  }
  
  if (warnings.length > 0) {
    report += `⚠️  ${warnings.length} route(s) with warnings:\n\n`;
    
    for (const validation of warnings) {
      report += `Route: ${validation.method} ${validation.route}\n`;
      
      for (const issue of validation.issues.filter(i => i.severity === 'warning')) {
        report += `  ⚠️  ${issue.message}\n`;
      }
      report += '\n';
    }
  }
  
  return report;
}
