/**
 * Automatic Database Setup Service
 * 
 * This service automatically sets up workspace databases after AI generation:
 * 1. Provisions workspace database (PostgreSQL schema + MongoDB database)
 * 2. Runs Prisma migrations to create tables in workspace schema
 * 3. Creates MongoDB collections if needed
 */

import { provisionWorkspaceDatabase, getWorkspaceDatabaseNames } from './databaseProvisioning'
import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { getWorkspaceMongoDB } from './workspaceDatabase'
import { installRealtimeTriggersForAllTables } from './realtimeTriggers'

const execAsync = promisify(exec)

export interface DatabaseSetupResult {
  success: boolean
  error?: string
  postgresSchema?: string
  mongodbDatabase?: string
  migrationsRun?: boolean
  tablesCreated?: string[]
  collectionsCreated?: string[]
}

/**
 * Automatically set up workspace database from Prisma schema
 * 
 * This function:
 * 1. Provisions the workspace database (creates PostgreSQL schema and MongoDB database)
 * 2. Extracts Prisma models from schema.prisma
 * 3. Creates tables in the workspace PostgreSQL schema
 * 4. Creates MongoDB collections if models use MongoDB
 */
export async function setupWorkspaceDatabaseFromSchema(
  projectId: string,
  workspaceId: string,
  schemaPath?: string
): Promise<DatabaseSetupResult> {
  try {
    console.log(`🚀 Setting up workspace database for project ${projectId}...`)

    // 🔒 SECURITY FIX: Only clean schema if explicitly needed (not for bootstrap-created projects)
    // Check if this is a bootstrap-created project with existing tables
    const checkMetadata = await prisma.projectMetadata.findUnique({
      where: { projectId },
      select: { tablesCreated: true },
    })
    
    const isBootstrapProject = checkMetadata?.tablesCreated === true
    
    if (!isBootstrapProject) {
      console.log('🧹 Step 0: Cleaning existing workspace schema (non-bootstrap project)...')
      const { postgresSchema: schemaName } = getWorkspaceDatabaseNames(projectId)
      
      try {
        // Drop and recreate schema for clean slate (multi-tenant isolation)
        await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
        console.log(`✅ Dropped existing schema: ${schemaName}`)
        
        await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`)
        console.log(`✅ Created clean schema: ${schemaName}`)

        // The DROP above unregistered this schema (the sql_drop event trigger
        // prunes it, correctly — a registered-but-absent schema wedges the
        // schema cache for EVERY tenant). Re-registering is therefore not
        // optional here: without it the project comes back with a live schema
        // and a dead data plane.
        const { ensureSchemaRegistered } = await import('@/lib/postgrest/registration')
        await ensureSchemaRegistered(projectId)
      } catch (error) {
        console.warn(`⚠️  Schema cleanup warning:`, error)
        // Continue even if cleanup fails (schema might not exist yet)
      }
    } else {
      console.log('✅ Step 0: Skipping schema cleanup (bootstrap-created project with existing tables)')
    }

    // 1. Provision workspace database
    console.log('📦 Step 1: Provisioning workspace database...')
    const provisioningResult = await provisionWorkspaceDatabase(workspaceId, projectId)
    
    if (!provisioningResult.success) {
      return {
        success: false,
        error: `Failed to provision database: ${provisioningResult.error}`,
      }
    }

    const { postgresSchema, mongodbDatabase } = provisioningResult

    // 2. Get table plans from ProjectMetadata (AI-extracted from user prompt)
    console.log('🧠 Step 2: Loading AI-extracted table plans from metadata...')
    const workspaceBase = join(process.cwd(), 'workspace', projectId)
    
    const metadata = await prisma.projectMetadata.findUnique({
      where: { projectId },
      select: { tablePlans: true, originalPrompt: true },
    })

    if (!metadata || !metadata.tablePlans || (metadata.tablePlans as any[]).length === 0) {
      console.warn('⚠️  No table plans found in ProjectMetadata')
      console.warn('   This project may not have been bootstrapped correctly')
      console.warn('   Original prompt:', metadata?.originalPrompt || 'N/A')
      
      // FALLBACK: Try reading from Prisma schema file (legacy projects)
      console.warn('⚠️  Falling back to Prisma schema file (legacy mode)...')
      const defaultSchemaPath = join(workspaceBase, 'prisma', 'schema.prisma')
      
      if (!existsSync(defaultSchemaPath)) {
        console.error('❌ No Prisma schema file found either!')
        return {
          success: false,
          error: 'No table plans found and no Prisma schema file exists. Project must be created via bootstrap endpoint.',
        }
      }
      
      console.log(`📖 Reading Prisma schema from ${defaultSchemaPath}...`)
      const schemaContent = readFileSync(defaultSchemaPath, 'utf-8')
      const models = parsePrismaModels(schemaContent)

      if (models.length === 0) {
        // No models yet — this is valid for a freshly created project with no tables
        console.log('ℹ️  No models found in schema file — project has no tables yet (normal for new projects)')
        return {
          success: true,
          postgresSchema: postgresSchema || undefined,
          mongodbDatabase: mongodbDatabase || undefined,
          tablesCreated: [],
          collectionsCreated: [],
        }
      }
      
      console.log(`📋 Parsed ${models.length} models from schema file (legacy mode)`)
      
      // Continue with legacy flow
      const postgresModels = models.filter(m => !m.isMongoDB)
      const tablesCreated: string[] = []

      if (postgresModels.length > 0 && postgresSchema) {
        console.log(`🗄️  Step 3: Creating ${postgresModels.length} PostgreSQL tables in schema ${postgresSchema}...`)
        
        // Check which tables already exist
        const escapedSchemaForQuery = postgresSchema.replace(/'/g, "''")
        const existingTables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
          `SELECT tablename FROM pg_tables WHERE schemaname = '${escapedSchemaForQuery}'`
        )
        const existingTableNames = new Set(existingTables.map(t => t.tablename.toLowerCase()))
        
        // First pass: Create all tables without foreign keys
        for (const model of postgresModels) {
          const tableNameLower = model.name.toLowerCase()
          if (existingTableNames.has(tableNameLower)) {
            console.log(`   ℹ️  Table ${model.name} already exists, skipping creation`)
            tablesCreated.push(model.name)
            continue
          }
          
          try {
            await createPostgresTableFromModel(postgresSchema, model, false)
            tablesCreated.push(model.name)
            console.log(`   ✅ Created table: ${model.name}`)
          } catch (error: any) {
            if (error.message?.includes('already exists') || error.message?.includes('duplicate')) {
              console.log(`   ℹ️  Table ${model.name} already exists`)
              tablesCreated.push(model.name)
            } else {
              console.error(`   ❌ Failed to create table ${model.name}:`, error.message)
            }
          }
        }
        
        // Second pass: Add foreign key constraints
        console.log(`🔗 Step 3b: Adding foreign key constraints...`)
        for (const model of postgresModels) {
          try {
            await addForeignKeysToTable(postgresSchema, model)
          } catch (error: any) {
            console.warn(`   ⚠️  Failed to add foreign keys to ${model.name}:`, error.message)
          }
        }
        
        // Third pass: Skip mock data generation — tables should start empty.
        // End-users populate data via the SDK/API. Auto-seeded rows confuse
        // developers ("where did these UUIDs come from?") and pollute production
        // databases.  If sample data is needed, use the AI chat: "add sample data".
        // (generateMockDataForTable is kept for potential future opt-in use.)
      }
      
      // Install realtime triggers for legacy mode tables too
      if (tablesCreated.length > 0) {
        await installRealtimeTriggersForAllTables(projectId, tablesCreated)
      }

      console.log(`✅ Database setup complete (legacy mode)!`)
      return {
        success: true,
        postgresSchema,
        mongodbDatabase,
        migrationsRun: true,
        tablesCreated,
        collectionsCreated: [],
      }
    }

    const tablePlans = metadata.tablePlans as any[]
    console.log(`📊 Found ${tablePlans.length} table plans from AI extraction`)
    console.log(`   Original prompt: "${metadata.originalPrompt}"`)
    console.log(`   Tables already created: ${(metadata as any).tablesCreated}`)
    console.log(`   APIs already created: ${(metadata as any).apisCreated}`)
    
    tablePlans.forEach((plan, idx) => {
      console.log(`   ${idx + 1}. ${plan.name} (${plan.columns?.length || 0} columns)`)
    })

    // Check if tables were already created by bootstrap
    if ((metadata as any).tablesCreated) {
      console.log(`✅ Tables already created by bootstrap - verifying they exist...`)
      
      const escapedSchemaForQuery = postgresSchema.replace(/'/g, "''")
      const existingTables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
        `SELECT tablename FROM pg_tables WHERE schemaname = '${escapedSchemaForQuery}'`
      )
      
      const existingTableNames = existingTables.map(t => t.tablename)
      console.log(`   Found ${existingTableNames.length} existing tables: ${existingTableNames.join(', ')}`)
      
      if (existingTableNames.length >= tablePlans.length) {
        console.log(`✅ All tables exist! Database setup already complete.`)
        return {
          success: true,
          postgresSchema,
          mongodbDatabase,
          migrationsRun: true,
          tablesCreated: existingTableNames,
          collectionsCreated: [],
        }
      } else {
        console.warn(`⚠️  Some tables missing. Expected ${tablePlans.length}, found ${existingTableNames.length}`)
        console.warn(`   Missing tables: ${tablePlans.map(p => p.name).filter(n => !existingTableNames.includes(n.toLowerCase())).join(', ')}`)
      }
    }

    // 3. Convert table plans to Prisma models
    console.log(`🔄 Converting table plans to database models...`)
    const models = tablePlansToModels(tablePlans)
    console.log(`📋 Converted ${models.length} models`)

    // 4. Create PostgreSQL tables in workspace schema
    const postgresModels = models.filter(m => !m.isMongoDB)
    const tablesCreated: string[] = []

    if (postgresModels.length > 0 && postgresSchema) {
      console.log(`🗄️  Step 3: Creating ${postgresModels.length} PostgreSQL tables in schema ${postgresSchema}...`)
      
      // Check which tables already exist
      const escapedSchemaForQuery = postgresSchema.replace(/'/g, "''")
      const existingTables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
        `SELECT tablename FROM pg_tables WHERE schemaname = '${escapedSchemaForQuery}'`
      )
      const existingTableNames = new Set(existingTables.map(t => t.tablename.toLowerCase()))
      
      // First pass: Create all tables without foreign keys (only if they don't exist)
      for (const model of postgresModels) {
        const tableNameLower = model.name.toLowerCase()
        if (existingTableNames.has(tableNameLower)) {
          console.log(`   ℹ️  Table ${model.name} already exists, skipping creation`)
          tablesCreated.push(model.name) // Still count it as "created" for the result
          continue
        }
        
        try {
          await createPostgresTableFromModel(postgresSchema, model, false) // false = don't create FKs yet
          tablesCreated.push(model.name)
          console.log(`   ✅ Created table: ${model.name}`)
        } catch (error: any) {
          // If error is "already exists", that's okay
          if (error.message?.includes('already exists') || error.message?.includes('duplicate')) {
            console.log(`   ℹ️  Table ${model.name} already exists`)
            tablesCreated.push(model.name)
          } else {
            console.error(`   ❌ Failed to create table ${model.name}:`, error.message)
            // Continue with other tables even if one fails
          }
        }
      }
      
      // Second pass: Add foreign key constraints
      console.log(`🔗 Step 3b: Adding foreign key constraints...`)
      for (const model of postgresModels) {
        try {
          await addForeignKeysToTable(postgresSchema, model)
        } catch (error: any) {
          console.warn(`   ⚠️  Failed to add foreign keys to ${model.name}:`, error.message)
          // Don't fail if FK creation fails - tables are already created
        }
      }
      
      // Third pass: Skip mock data — tables start empty (see comment above)
    }

    // 5. Create MongoDB collections
    const mongoModels = models.filter(m => m.isMongoDB)
    let collectionsCreated: string[] = []

    console.log(`🍃 Step 4: MongoDB setup check - Found ${mongoModels.length} MongoDB models from Prisma schema out of ${models.length} total models`)
    if (mongoModels.length > 0) {
      mongoModels.forEach((model, idx) => {
        console.log(`   ${idx + 1}. ${model.name} (${model.fields.length} fields)`)
      })
    }

    // Also scan for Mongoose models in the workspace
    const mongooseCollections = await detectMongooseModels(workspaceBase)
    console.log(`🍃 Step 4b: Found ${mongooseCollections.length} Mongoose models in workspace`)
    if (mongooseCollections.length > 0) {
      mongooseCollections.forEach((coll: { name: string; filePath: string }, idx: number) => {
        console.log(`   ${idx + 1}. ${coll.name} (from ${coll.filePath})`)
      })
    }

    const totalMongoCollections = mongoModels.length + mongooseCollections.length
    
    // Skip MongoDB fallback logic - only use explicitly defined Mongo models
    let fallbackCollections: Array<{ name: string; source: string }> = []

    const allCollectionsToCreate = [
      ...mongoModels.map(m => ({ name: m.name.toLowerCase(), source: 'prisma', model: m })),
      ...mongooseCollections.map(m => ({ name: m.name.toLowerCase(), source: 'mongoose', mongooseModel: m })),
      ...fallbackCollections.map(f => ({ name: f.name.toLowerCase(), source: f.source })),
    ]
    
    if (allCollectionsToCreate.length > 0 && mongodbDatabase) {
      console.log(`🍃 Step 4: Creating ${allCollectionsToCreate.length} MongoDB collections in database ${mongodbDatabase}...`)
      
      try {
        const mongoDb = await getWorkspaceMongoDB(projectId)
        
        if (!mongoDb) {
          console.error(`   ❌ Failed to get MongoDB database connection for project ${projectId}`)
        } else {
          // Check which collections already exist
          const existingCollections = await mongoDb.listCollections().toArray()
          const existingCollectionNames = new Set(existingCollections.map(c => c.name.toLowerCase()))
          
          // Process Prisma MongoDB models
          for (const model of mongoModels) {
            try {
              const collectionName = model.name.toLowerCase()
              const collection = mongoDb.collection(collectionName)
              
              if (existingCollectionNames.has(collectionName)) {
                console.log(`   ℹ️  Collection ${collectionName} already exists, skipping creation`)
                collectionsCreated.push(model.name)
                await generateMockDataForMongoCollection(collection, model)
                continue
              }
              
              const { ObjectId } = await import('mongodb')
              const tempId = new ObjectId('000000000000000000000000')
              await collection.insertOne({ _id: tempId, _temp: true })
              await collection.deleteOne({ _id: tempId })
              
              collectionsCreated.push(model.name)
              console.log(`   ✅ Created collection: ${collectionName} (from Prisma model ${model.name})`)
              await generateMockDataForMongoCollection(collection, model)
            } catch (error: any) {
              console.error(`   ❌ Failed to create collection ${model.name}:`, error.message)
            }
          }
          
          // Process Mongoose models
          for (const mongooseModel of mongooseCollections) {
            try {
              const collectionName = mongooseModel.name.toLowerCase()
              const collection = mongoDb.collection(collectionName)
              
              if (existingCollectionNames.has(collectionName)) {
                console.log(`   ℹ️  Collection ${collectionName} already exists, skipping creation`)
                collectionsCreated.push(mongooseModel.name)
                // Generate basic mock data for Mongoose collections
                await generateMockDataForMongooseCollection(collection, mongooseModel)
                continue
              }
              
              const { ObjectId } = await import('mongodb')
              const tempId = new ObjectId('000000000000000000000000')
              await collection.insertOne({ _id: tempId, _temp: true })
              await collection.deleteOne({ _id: tempId })
              
              collectionsCreated.push(mongooseModel.name)
              console.log(`   ✅ Created collection: ${collectionName} (from Mongoose model in ${mongooseModel.filePath})`)
              await generateMockDataForMongooseCollection(collection, mongooseModel)
            } catch (error: any) {
              console.error(`   ❌ Failed to create collection ${mongooseModel.name}:`, error.message)
            }
          }
          
          // Process fallback collections
          for (const fallback of fallbackCollections) {
            try {
              const collectionName = fallback.name.toLowerCase()
              const collection = mongoDb.collection(collectionName)
              
              if (existingCollectionNames.has(collectionName)) {
                console.log(`   ℹ️  Collection ${collectionName} already exists, skipping creation`)
                collectionsCreated.push(fallback.name)
                await generateMockDataForFallbackCollection(collection, fallback.name)
                continue
              }
              
              const { ObjectId } = await import('mongodb')
              const tempId = new ObjectId('000000000000000000000000')
              await collection.insertOne({ _id: tempId, _temp: true })
              await collection.deleteOne({ _id: tempId })
              
              collectionsCreated.push(fallback.name)
              console.log(`   ✅ Created collection: ${collectionName} (${fallback.source})`)
              await generateMockDataForFallbackCollection(collection, fallback.name)
            } catch (error: any) {
              console.error(`   ❌ Failed to create collection ${fallback.name}:`, error.message)
            }
          }
        }
      } catch (mongoError: any) {
        console.error(`❌ MongoDB connection error: ${mongoError.message}`)
        console.warn(`⚠️  MongoDB client not available, skipping MongoDB provisioning`)
        // Don't fail the entire setup if MongoDB fails
      }
    } else if (allCollectionsToCreate.length > 0 && !mongodbDatabase) {
      console.warn(`   ⚠️  MongoDB collections to create but MongoDB database not provisioned`)
      console.warn(`   Collections: ${allCollectionsToCreate.map(c => c.name).join(', ')}`)
      console.warn(`   This might happen if database provisioning failed. Collections will be created when database is provisioned.`)
    } else if (mongoModels.length > 0 && !mongodbDatabase) {
      console.warn(`   ⚠️  MongoDB models found but MongoDB database not provisioned`)
      console.warn(`   Models: ${mongoModels.map(m => m.name).join(', ')}`)
    } else if (allCollectionsToCreate.length === 0) {
      console.log(`   ℹ️  No MongoDB collections to create`)
    }

    // Install realtime NOTIFY triggers on every PostgreSQL table
    if (tablesCreated.length > 0) {
      console.log(`⚡ Installing realtime triggers on ${tablesCreated.length} table(s)...`)
      await installRealtimeTriggersForAllTables(projectId, tablesCreated)
    }

    console.log(`✅ Database setup complete!`)
    console.log(`   PostgreSQL schema: ${postgresSchema}`)
    console.log(`   MongoDB database: ${mongodbDatabase}`)
    console.log(`   Tables created: ${tablesCreated.length}`)
    console.log(`   Collections created: ${collectionsCreated.length}`)

    return {
      success: true,
      postgresSchema,
      mongodbDatabase,
      migrationsRun: true,
      tablesCreated,
      collectionsCreated,
    }
  } catch (error: any) {
    console.error('❌ Error setting up workspace database:', error)
    return {
      success: false,
      error: error.message || 'Unknown error during database setup',
    }
  }
}

/**
 * Parse Prisma models from schema content
 */
interface PrismaModel {
  name: string
  isMongoDB: boolean
  fields: Array<{
    name: string
    type: string
    isOptional: boolean
    isId: boolean
    defaultValue?: string
    relation?: {
      references: string // The column name in the referenced table (usually "id")
      referencesTable: string // The table name being referenced
    }
  }>
}

/**
 * Order models by dependencies using topological sort
 * Parent tables (referenced by others) come before child tables (that reference them)
 */
function orderModelsByDependencies(models: PrismaModel[]): PrismaModel[] {
  // Build dependency graph: model -> models it depends on
  const dependencies = new Map<string, Set<string>>()
  const modelsByName = new Map<string, PrismaModel>()
  
  // Initialize
  for (const model of models) {
    modelsByName.set(model.name, model)
    dependencies.set(model.name, new Set())
  }
  
  // Build dependency edges
  for (const model of models) {
    for (const field of model.fields) {
      if (field.relation) {
        // This model depends on the referenced table
        const referencedTable = field.relation.referencesTable
        if (modelsByName.has(referencedTable)) {
          dependencies.get(model.name)?.add(referencedTable)
        }
      }
    }
  }
  
  // Topological sort using Kahn's algorithm
  const sorted: PrismaModel[] = []
  const inDegree = new Map<string, number>()
  
  // Calculate in-degrees
  for (const model of models) {
    inDegree.set(model.name, 0)
  }
  for (const deps of Array.from(dependencies.values())) {
    for (const dep of Array.from(deps)) {
      inDegree.set(dep, (inDegree.get(dep) || 0) + 1)
    }
  }
  
  // Start with models that have no dependents (leaf tables)
  const queue: string[] = []
  for (const [name, degree] of Array.from(inDegree.entries())) {
    if (degree === 0) {
      queue.push(name)
    }
  }
  
  // Process queue
  while (queue.length > 0) {
    const modelName = queue.shift()!
    const model = modelsByName.get(modelName)!
    sorted.push(model)
    
    // Reduce in-degree for models that depend on this one
    for (const [name, deps] of Array.from(dependencies.entries())) {
      if (deps.has(modelName)) {
        deps.delete(modelName)
        if (deps.size === 0) {
          queue.push(name)
        }
      }
    }
  }
  
  // If sorted doesn't contain all models, there's a circular dependency
  if (sorted.length !== models.length) {
    console.warn('   ⚠️  Circular dependency detected in models, using original order')
    return models
  }
  
  // Reverse to get parent tables first
  return sorted.reverse()
}

function parsePrismaModels(schemaContent: string): PrismaModel[] {
  const models: PrismaModel[] = []
  
  // Check for MongoDB datasource - can have multiple datasources
  const mongoDatasourceRegex = new RegExp('datasource\\s+\\w+\\s*\\{[^}]*provider\\s*=\\s*["\']mongodb["\'][^}]*\\}', 'g')
  const hasMongoDBDatasource = mongoDatasourceRegex.test(schemaContent)
  
  // Extract MongoDB datasource name if it exists
  let mongoDatasourceName: string | null = null
  if (hasMongoDBDatasource) {
    const datasourceMatch = schemaContent.match(new RegExp('datasource\\s+(\\w+)\\s*\\{[^}]*provider\\s*=\\s*["\']mongodb["\'][^}]*\\}', 's'))
    if (datasourceMatch) {
      mongoDatasourceName = datasourceMatch[1]
    }
  }
  
  // Match model blocks - improved to handle nested braces and relations
  // This regex matches: model ModelName { ... } and handles nested braces
  const modelRegex = /model\s+(\w+)\s*\{/g
  let match

  while ((match = modelRegex.exec(schemaContent)) !== null) {
    const modelName = match[1]
    const startPos = match.index + match[0].length
    
    // Find matching closing brace by counting braces
    let braceCount = 1
    let pos = startPos
    let endPos = startPos
    
    while (braceCount > 0 && pos < schemaContent.length) {
      if (schemaContent[pos] === '{') braceCount++
      if (schemaContent[pos] === '}') braceCount--
      if (braceCount === 0) {
        endPos = pos
        break
      }
      pos++
    }
    
    const modelBody = schemaContent.substring(startPos, endPos)

    // Check if model uses MongoDB by:
    // 1. Checking if it has MongoDB-specific attributes (@db.ObjectId, @db.String, @db.Binary)
    // 2. Checking if any field uses ObjectId type (MongoDB's default ID type)
    // 3. Checking if model has @@map (common in MongoDB schemas)
    // 4. Checking if model explicitly uses MongoDB datasource via @@schema or provider
    const hasMongoAttributes = modelBody.includes('@db.ObjectId') || 
                               modelBody.includes('@db.String') ||
                               modelBody.includes('@db.Binary') ||
                               modelBody.includes('@db.Map')
    
    // Check if any field uses ObjectId (MongoDB's default ID type)
    const hasObjectId = /ObjectId/i.test(modelBody) || 
                       /@default\([^)]*ObjectId/i.test(modelBody) ||
                       /String\s+@id\s+@default\([^)]*ObjectId/i.test(modelBody)
    
    // Check if model explicitly specifies MongoDB datasource
    const hasMongoSchema = mongoDatasourceName && (
      modelBody.includes(`@@schema("${mongoDatasourceName}")`) ||
      modelBody.includes(`@@schema('${mongoDatasourceName}')`) ||
      modelBody.includes(`provider = "mongodb"`)
    )
    
    // If there's a MongoDB datasource, check for MongoDB indicators
    // OR if model explicitly has MongoDB attributes or schema
    // Also check if model name suggests MongoDB (e.g., analytics, logs, events)
    const mongoKeywords = ['analytics', 'log', 'event', 'session', 'cache', 'notification', 'audit', 'message', 'chat']
    const hasMongoKeyword = mongoKeywords.some(keyword => modelName.toLowerCase().includes(keyword))
    
    // More flexible detection: if MongoDB datasource exists, check for indicators
    // OR if model explicitly uses MongoDB schema/datasource
    const isMongoDB = hasMongoDBDatasource && (
      hasMongoAttributes || 
      hasObjectId || 
      hasMongoSchema ||
      modelBody.includes('@@map') ||
      (hasMongoKeyword && !modelBody.includes('@@schema') && !modelBody.includes('provider = "postgresql"'))
    ) || (
      // Also check if model explicitly uses MongoDB even without datasource
      hasMongoSchema || 
      (hasMongoAttributes && !modelBody.includes('provider = "postgresql"'))
    )
    
    // Log detection result for debugging
    if (hasMongoDBDatasource) {
      console.log(`   🔍 Model ${modelName} MongoDB detection:`, {
        hasMongoDBDatasource,
        hasMongoAttributes,
        hasObjectId,
        hasMongoSchema,
        hasMongoKeyword,
        isMongoDB,
      })
    }

    // First pass: Find all relation fields and extract FK information
    // Relation fields look like: category Category @relation(fields: [categoryId], references: [id])
    // We need to map: categoryId -> { referencesTable: "Category", references: "id" }
    const fkMap = new Map<string, { referencesTable: string; references: string }>()
    
    // Match relation fields: fieldName TableName @relation(fields: [fkField], references: [refColumn])
    // Also handles: fieldName TableName? @relation(...) and multi-line relations
    const relationFieldRegex = /^\s*(\w+)\s+(\w+)\s*(\?)?\s+@relation\s*\([^)]*fields:\s*\[([^\]]+)\][^)]*references:\s*\[([^\]]+)\][^)]*\)/gm
    let relationMatch
    
    while ((relationMatch = relationFieldRegex.exec(modelBody)) !== null) {
      const relationFieldName = relationMatch[1] // e.g., "category"
      const referencedTable = relationMatch[2] // e.g., "Category"
      const fkFieldName = relationMatch[4].trim() // e.g., "categoryId" (index 4 because we added optional ?)
      const referencedColumn = relationMatch[5].trim() // e.g., "id" (index 5 because we added optional ?)
      
      // Map the FK field name to its relation info
      fkMap.set(fkFieldName, {
        referencesTable: referencedTable,
        references: referencedColumn,
      })
      
      console.log(`   🔗 Found relation: ${fkFieldName} -> ${referencedTable}.${referencedColumn}`)
    }

    // Parse fields - improved regex to handle Prisma field syntax
    const fields: PrismaModel['fields'] = []
    // Match: fieldName Type? @attributes
    // Example: id Int @id @default(autoincrement())
    // Example: categoryId Int (FK column)
    const fieldRegex = /^\s*(\w+)\s+(\w+(?:\[\])?)\s*(\?)?([^@\n]*?)(@[^\n]+)?/gm
    let fieldMatch

    while ((fieldMatch = fieldRegex.exec(modelBody)) !== null) {
      const fieldName = fieldMatch[1]
      const fieldType = fieldMatch[2]
      const isOptional = !!fieldMatch[3]
      const attributes = fieldMatch[5] || ''
      const isId = attributes.includes('@id')

      // Skip relation fields that are object types (they don't create columns)
      // Example: category Category @relation(...) - this is the relation field, not the FK column
      if (fieldType.includes('[]')) {
        // Array type means it's a one-to-many relation field, not a column
        continue
      }

      // Skip relation object fields (they don't create columns)
      // Example: category Category @relation(...) - the type is a model name (capitalized)
      // But we need to check if it's actually a relation field or just a type name
      // If it has @relation with fields:, it's a relation field, not a column
      if (attributes.includes('@relation') && attributes.includes('fields:')) {
        // This is a relation field, not a FK column - skip it
        continue
      }

      // Check if this field is a foreign key by looking it up in the FK map
      const relation = fkMap.get(fieldName)

      fields.push({
        name: fieldName,
        type: fieldType,
        isOptional,
        isId,
        relation,
      })
    }

    // Only add models that have fields (skip empty models)
    if (fields.length > 0) {
      models.push({
        name: modelName,
        isMongoDB,
        fields,
      })
    }
  }

  return models
}

/**
 * Create a PostgreSQL table from a Prisma model
 */
async function createPostgresTableFromModel(
  schema: string,
  model: PrismaModel,
  includeForeignKeys: boolean = true
): Promise<void> {
  const escapedSchema = `"${schema.replace(/"/g, '""')}"`
  const escapedTable = `"${model.name.replace(/"/g, '""')}"`

  // Build column definitions
  const columns: string[] = []
  let hasId = false
  
  for (const field of model.fields) {
    let columnDef = `"${field.name.replace(/"/g, '""')}" `
    
    // Map Prisma types to PostgreSQL types
    const baseType = field.type.replace('?', '').replace('[]', '')
    
    if (baseType === 'String') {
      columnDef += 'TEXT'
    } else if (baseType === 'Int') {
      if (field.isId) {
        columnDef += 'SERIAL' // Use SERIAL for auto-increment IDs
      } else {
        columnDef += 'INTEGER'
      }
    } else if (baseType === 'BigInt') {
      columnDef += 'BIGINT'
    } else if (baseType === 'Float' || baseType === 'Decimal') {
      columnDef += 'REAL'
    } else if (baseType === 'Boolean') {
      columnDef += 'BOOLEAN'
    } else if (baseType === 'DateTime') {
      columnDef += 'TIMESTAMP'
    } else if (baseType === 'Json') {
      columnDef += 'JSONB'
    } else {
      // Default to TEXT for unknown types
      columnDef += 'TEXT'
    }

    if (field.isId) {
      columnDef += ' PRIMARY KEY'
      hasId = true
    }

    if (!field.isOptional && !field.isId) {
      columnDef += ' NOT NULL'
    }

    columns.push(columnDef)
  }

  // If no ID field found, add a default id column
  if (!hasId) {
    columns.unshift('"id" SERIAL PRIMARY KEY')
  }

  // Build foreign key constraints (only if includeForeignKeys is true)
  const foreignKeys: string[] = []
  if (includeForeignKeys) {
    for (const field of model.fields) {
      if (field.relation) {
        const fkName = `fk_${model.name}_${field.name}`.toLowerCase().substring(0, 63) // PostgreSQL constraint name limit
        const escapedRefTable = `"${field.relation.referencesTable.replace(/"/g, '""')}"`
        const escapedRefColumn = `"${field.relation.references.replace(/"/g, '""')}"`
        const escapedFkColumn = `"${field.name.replace(/"/g, '""')}"`
        
        foreignKeys.push(
          `CONSTRAINT ${fkName} FOREIGN KEY (${escapedFkColumn}) REFERENCES ${escapedSchema}.${escapedRefTable} (${escapedRefColumn})`
        )
        
        console.log(`   🔗 Adding FK: ${field.name} -> ${field.relation.referencesTable}.${field.relation.references}`)
      }
    }
  }

  // Create table SQL with optional foreign key constraints
  const allConstraints = [...columns]
  if (includeForeignKeys && foreignKeys.length > 0) {
    allConstraints.push(...foreignKeys)
  }
  
  const createTableSQL = `CREATE TABLE IF NOT EXISTS ${escapedSchema}.${escapedTable} (${allConstraints.join(', ')})`
  
  if (includeForeignKeys && foreignKeys.length > 0) {
    console.log(`   🔗 Found ${foreignKeys.length} foreign key relationship(s) for ${model.name}`)
  }

  try {
    console.log(`   🔨 Executing SQL for ${model.name}:`)
    console.log(`   SQL: ${createTableSQL}`)
    await prisma.$executeRawUnsafe(createTableSQL)
    
    // Verify table was created by querying information_schema
    const verifySQL = `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema.replace(/'/g, "''")}' AND table_name = '${model.name.replace(/'/g, "''")}'`
    const verifyResult = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(verifySQL)
    
    if (verifyResult && verifyResult.length > 0) {
      console.log(`   ✅ Successfully created and verified table ${escapedSchema}.${escapedTable}`)
    } else {
      console.warn(`   ⚠️  Table creation reported success but verification failed`)
      console.warn(`   Verification SQL: ${verifySQL}`)
    }
  } catch (error: any) {
    console.error(`   ❌ SQL Error creating table ${model.name}:`, error.message)
    console.error(`   Error code: ${error.code}`)
    console.error(`   SQL: ${createTableSQL}`)
    console.error(`   Full error:`, error)
    throw error
  }
}

/**
 * Add foreign key constraints to an existing table
 */
async function addForeignKeysToTable(
  schema: string,
  model: PrismaModel
): Promise<void> {
  const escapedSchema = `"${schema.replace(/"/g, '""')}"`
  const escapedTable = `"${model.name.replace(/"/g, '""')}"`
  
  // Build foreign key constraints
  for (const field of model.fields) {
    if (field.relation) {
      const fkName = `fk_${model.name}_${field.name}`.toLowerCase().substring(0, 63) // PostgreSQL constraint name limit
      const escapedRefTable = `"${field.relation.referencesTable.replace(/"/g, '""')}"`
      const escapedRefColumn = `"${field.relation.references.replace(/"/g, '""')}"`
      const escapedFkColumn = `"${field.name.replace(/"/g, '""')}"`
      
      // Check if constraint already exists
      const checkConstraintSQL = `
        SELECT constraint_name 
        FROM information_schema.table_constraints 
        WHERE table_schema = '${schema.replace(/'/g, "''")}' 
          AND table_name = '${model.name.replace(/'/g, "''")}' 
          AND constraint_name = '${fkName.replace(/'/g, "''")}'
      `
      
      const existing = await prisma.$queryRawUnsafe<Array<{ constraint_name: string }>>(checkConstraintSQL)
      
      if (existing && existing.length > 0) {
        console.log(`   ℹ️  FK constraint ${fkName} already exists on ${model.name}`)
        continue
      }
      
      // Add foreign key constraint using ALTER TABLE
      const addFkSQL = `
        ALTER TABLE ${escapedSchema}.${escapedTable} 
        ADD CONSTRAINT ${fkName} 
        FOREIGN KEY (${escapedFkColumn}) 
        REFERENCES ${escapedSchema}.${escapedRefTable} (${escapedRefColumn})
      `
      
      try {
        await prisma.$executeRawUnsafe(addFkSQL)
        console.log(`   ✅ Added FK: ${field.name} -> ${field.relation.referencesTable}.${field.relation.references}`)
      } catch (fkError: any) {
        // If FK creation fails (e.g., referenced table doesn't exist), log warning but continue
        console.warn(`   ⚠️  Failed to add FK ${fkName} to ${model.name}:`, fkError.message)
        // Don't throw - continue with other FKs
      }
    }
  }
}

/**
 * Generate mock data for a table based on its schema
 */
async function generateMockDataForTable(
  schema: string,
  model: PrismaModel,
  workspaceSchema: string
): Promise<void> {
  const escapedSchema = `"${schema.replace(/"/g, '""')}"`
  const escapedTable = `"${model.name.replace(/"/g, '""')}"`
  
  // Check if table already has data - if so, skip mock data generation
  try {
    const existingCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) as count FROM ${escapedSchema}.${escapedTable}`
    )
    if (existingCount && existingCount.length > 0 && Number(existingCount[0].count) > 0) {
      console.log(`   ℹ️  Table ${model.name} already has data, skipping mock data generation`)
      return
    }
  } catch {
    // Table might not exist yet, continue with mock data generation
  }
  
  // Generate only 1 mock record
  const recordCount = 1
  
  // Build mock data based on field types
  const mockRecords: any[] = []
  
  for (let i = 0; i < recordCount; i++) {
    const record: any = {}
    
    for (const field of model.fields) {
      const baseType = field.type.replace('?', '').replace('[]', '')
      
      if (field.isId) {
        // For TEXT/String IDs, generate UUIDs (common pattern in modern schemas)
        // For INT IDs with SERIAL, skip (auto-generated)
        if (baseType === 'String') {
          // Generate UUID for TEXT PRIMARY KEY columns
          const { randomUUID } = await import('crypto')
          record[field.name] = randomUUID()
        } else {
          // Skip numeric IDs - will be auto-generated by SERIAL
          continue
        }
      } else if (baseType === 'String') {
        // Check if this is a foreign key field (ends with 'Id' and not the primary key)
        if (field.name.toLowerCase().endsWith('id') && !field.isId) {
          // This is likely a foreign key - try to get existing UUIDs from parent table
          const fkTableName = field.name.replace(/Id$/, '') // Remove 'Id' suffix
          // Capitalize first letter for table name
          const capitalizedTable = fkTableName.charAt(0).toUpperCase() + fkTableName.slice(1)
          
          try {
            // Check if parent table exists and has records
            const parentIds = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
              `SELECT id FROM "${workspaceSchema.replace(/"/g, '""')}"."${capitalizedTable.replace(/"/g, '""')}" LIMIT 10`
            )
            if (parentIds && parentIds.length > 0) {
              // Use actual UUID from parent table
              record[field.name] = parentIds[i % parentIds.length].id
            } else {
              // Parent table exists but has no records - generate UUID
              const { randomUUID } = await import('crypto')
              record[field.name] = randomUUID()
            }
          } catch {
            // Parent table doesn't exist yet - generate UUID
            const { randomUUID } = await import('crypto')
            record[field.name] = randomUUID()
          }
        } else if (field.name.toLowerCase().includes('email')) {
          record[field.name] = `user${i + 1}@example.com`
        } else if (field.name.toLowerCase().includes('username')) {
          record[field.name] = `user${i + 1}`
        } else if (field.name.toLowerCase().includes('password')) {
          record[field.name] = 'password123'
        } else if (field.name.toLowerCase().includes('name')) {
          record[field.name] = `Sample ${field.name} ${i + 1}`
        } else if (field.name.toLowerCase().includes('content')) {
          record[field.name] = `This is sample content for record ${i + 1}.`
        } else if (field.name.toLowerCase().includes('description')) {
          record[field.name] = `Sample description ${i + 1}`
        } else if (field.name.toLowerCase().includes('title')) {
          record[field.name] = `Sample Title ${i + 1}`
        } else {
          record[field.name] = `sample_${field.name}_${i + 1}`
        }
      } else if (baseType === 'Int') {
        // Generate random integers based on field name
        if (field.name.toLowerCase().includes('id') && !field.isId) {
          // Foreign key - try to get existing IDs from parent table
          const fkTableName = field.name.toLowerCase().replace('id', '').replace('user', 'User').replace('author', 'User').replace('post', 'Post').replace('follower', 'User').replace('following', 'User')
          const capitalizedTable = fkTableName.charAt(0).toUpperCase() + fkTableName.slice(1)
          
          try {
            // Check if parent table exists and has records
            const parentIds = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
              `SELECT id FROM "${workspaceSchema.replace(/"/g, '""')}"."${capitalizedTable.replace(/"/g, '""')}" LIMIT 10`
            )
            if (parentIds && parentIds.length > 0) {
              record[field.name] = parentIds[i % parentIds.length].id
            } else {
              record[field.name] = (i % 3) + 1 // Fallback to sequential IDs
            }
          } catch {
            // If parent table doesn't exist yet, use sequential IDs
            record[field.name] = (i % 3) + 1
          }
        } else if (field.name.toLowerCase().includes('price') || field.name.toLowerCase().includes('amount')) {
          record[field.name] = Math.floor(Math.random() * 1000) + 10
        } else if (field.name.toLowerCase().includes('stock') || field.name.toLowerCase().includes('quantity')) {
          record[field.name] = Math.floor(Math.random() * 100) + 1
        } else {
          record[field.name] = Math.floor(Math.random() * 100) + 1
        }
      } else if (baseType === 'Float' || baseType === 'Decimal') {
        record[field.name] = parseFloat((Math.random() * 1000 + 10).toFixed(2))
      } else if (baseType === 'Boolean') {
        record[field.name] = Math.random() > 0.5
      } else if (baseType === 'DateTime') {
        // Generate dates in the past week
        const daysAgo = Math.floor(Math.random() * 7)
        const date = new Date()
        date.setDate(date.getDate() - daysAgo)
        record[field.name] = date.toISOString()
      } else if (baseType === 'Json') {
        record[field.name] = { sample: 'data', index: i + 1 }
      } else {
        // Default to string
        record[field.name] = `sample_${i + 1}`
      }
    }
    
    if (Object.keys(record).length > 0) {
      mockRecords.push(record)
    }
  }
  
  if (mockRecords.length === 0) {
    console.log(`   ℹ️  No fields to generate mock data for ${model.name}`)
    return
  }
  
  // Insert mock records - handle foreign keys intelligently
  // For models with foreign keys, use existing IDs from parent tables
  for (const record of mockRecords) {
    const columns = Object.keys(record).map(k => `"${k.replace(/"/g, '""')}"`).join(', ')
    const values = Object.values(record).map((v: any) => {
      if (typeof v === 'string') {
        return `'${v.replace(/'/g, "''")}'`
      } else if (v instanceof Date) {
        return `'${v.toISOString()}'`
      } else if (typeof v === 'object') {
        return `'${JSON.stringify(v).replace(/'/g, "''")}'`
      } else {
        return v
      }
    }).join(', ')
    
    const insertSQL = `INSERT INTO ${escapedSchema}.${escapedTable} (${columns}) VALUES (${values})`
    
    try {
      await prisma.$executeRawUnsafe(insertSQL)
    } catch (insertError: any) {
      // If insert fails (e.g., foreign key constraint), skip this record
      console.warn(`   ⚠️  Failed to insert mock record for ${model.name}:`, insertError.message)
    }
  }
  
  console.log(`   ✅ Inserted ${mockRecords.length} mock records into ${model.name}`)
}

/**
 * Generate mock data for a MongoDB collection based on its schema
 */
async function generateMockDataForMongoCollection(
  collection: any,
  model: PrismaModel
): Promise<void> {
  // Check if collection already has data - if so, skip mock data generation
  try {
    const existingCount = await collection.countDocuments()
    if (existingCount > 0) {
      console.log(`   ℹ️  Collection ${model.name} already has data, skipping mock data generation`)
      return
    }
  } catch {
    // Collection might not exist yet, continue with mock data generation
  }
  
  // Generate only 1 mock document
  const documentCount = 1
  
  const mockDocuments: any[] = []
  const { ObjectId } = await import('mongodb')
  
  for (let i = 0; i < documentCount; i++) {
    const document: any = {}
    
    for (const field of model.fields) {
      const baseType = field.type.replace('?', '').replace('[]', '')
      
      if (field.isId) {
        // MongoDB uses ObjectId for IDs
        document._id = new ObjectId()
        continue
      }
      
      // Generate mock data based on field type and name
      if (baseType === 'String' || baseType === 'ObjectId') {
        if (field.name.toLowerCase().includes('email')) {
          document[field.name] = `user${i + 1}@example.com`
        } else if (field.name.toLowerCase().includes('username')) {
          document[field.name] = `user${i + 1}`
        } else if (field.name.toLowerCase().includes('password')) {
          document[field.name] = 'password123'
        } else if (field.name.toLowerCase().includes('name')) {
          document[field.name] = `Sample ${field.name} ${i + 1}`
        } else if (field.name.toLowerCase().includes('content')) {
          document[field.name] = `This is sample content for document ${i + 1}.`
        } else if (field.name.toLowerCase().includes('description')) {
          document[field.name] = `Sample description ${i + 1}`
        } else if (field.name.toLowerCase().includes('title')) {
          document[field.name] = `Sample Title ${i + 1}`
        } else if (baseType === 'ObjectId') {
          // Generate a valid ObjectId for reference fields
          document[field.name] = new ObjectId()
        } else {
          document[field.name] = `sample_${field.name}_${i + 1}`
        }
      } else if (baseType === 'Int') {
        // Generate random integers based on field name
        if (field.name.toLowerCase().includes('price') || field.name.toLowerCase().includes('amount')) {
          document[field.name] = Math.floor(Math.random() * 1000) + 10
        } else if (field.name.toLowerCase().includes('stock') || field.name.toLowerCase().includes('quantity')) {
          document[field.name] = Math.floor(Math.random() * 100) + 1
        } else {
          document[field.name] = Math.floor(Math.random() * 100) + 1
        }
      } else if (baseType === 'Float' || baseType === 'Decimal') {
        document[field.name] = parseFloat((Math.random() * 1000 + 10).toFixed(2))
      } else if (baseType === 'Boolean') {
        document[field.name] = Math.random() > 0.5
      } else if (baseType === 'DateTime') {
        // Generate dates in the past week
        const daysAgo = Math.floor(Math.random() * 7)
        const date = new Date()
        date.setDate(date.getDate() - daysAgo)
        document[field.name] = date
      } else if (baseType === 'Json') {
        document[field.name] = { sample: 'data', index: i + 1 }
      } else {
        // Default to string
        document[field.name] = `sample_${i + 1}`
      }
    }
    
    if (Object.keys(document).length > 0) {
      mockDocuments.push(document)
    }
  }
  
  if (mockDocuments.length === 0) {
    console.log(`   ℹ️  No fields to generate mock data for ${model.name}`)
    return
  }
  
  // Insert mock documents
  try {
    await collection.insertMany(mockDocuments)
    console.log(`   ✅ Inserted ${mockDocuments.length} mock documents into ${model.name}`)
  } catch (insertError: any) {
    console.warn(`   ⚠️  Failed to insert mock documents for ${model.name}:`, insertError.message)
  }
}

/**
 * Detect Mongoose models from TypeScript files in the workspace
 */
async function detectMongooseModels(workspaceBase: string): Promise<Array<{ name: string; filePath: string }>> {
  const mongooseModels: Array<{ name: string; filePath: string }> = []
  
  // Common paths where Mongoose models might be located
  const possiblePaths = [
    join(workspaceBase, 'src', 'mongo', 'models'),
    join(workspaceBase, 'src', 'models'),
    join(workspaceBase, 'models'),
    join(workspaceBase, 'lib', 'models'),
    join(workspaceBase, 'mongo', 'models'),
  ]
  
  for (const modelPath of possiblePaths) {
    if (!existsSync(modelPath)) continue
    
    try {
      const files = readdirSync(modelPath)
      for (const file of files) {
        if (!file.endsWith('.ts') && !file.endsWith('.js')) continue
        
        const filePath = join(modelPath, file)
        const stats = statSync(filePath)
        if (!stats.isFile()) continue
        
        const fileContent = readFileSync(filePath, 'utf-8')
        
        // Look for Mongoose schema definitions
        // Pattern: mongoose.model('ModelName', schema) or model('ModelName', schema)
        const modelRegex = /(?:mongoose\.)?model\s*\(\s*['"]([^'"]+)['"]/g
        let match
        
        while ((match = modelRegex.exec(fileContent)) !== null) {
          const modelName = match[1]
          mongooseModels.push({
            name: modelName,
            filePath: filePath.replace(process.cwd(), '').replace(/\\/g, '/'),
          })
        }
        
        // Also check for Schema definitions that might be exported
        // Pattern: export const ModelNameSchema = new Schema(...)
        const schemaExportRegex = /export\s+(?:const|let|var)\s+(\w+)Schema\s*=\s*new\s+Schema/gi
        let schemaMatch
        
        while ((schemaMatch = schemaExportRegex.exec(fileContent)) !== null) {
          const schemaName = schemaMatch[1]
          // Try to infer model name from schema name (e.g., ProductSchema -> Product)
          const modelName = schemaName.replace(/Schema$/, '')
          mongooseModels.push({
            name: modelName,
            filePath: filePath.replace(process.cwd(), '').replace(/\\/g, '/'),
          })
        }
      }
    } catch (error: any) {
      console.warn(`   ⚠️  Error scanning ${modelPath} for Mongoose models:`, error.message)
    }
  }
  
  // Deduplicate by model name
  const uniqueModels = mongooseModels.filter((model, index, self) => 
    index === self.findIndex(m => m.name.toLowerCase() === model.name.toLowerCase())
  )
  
  return uniqueModels
}

/**
 * Generate mock data for a Mongoose collection
 */
async function generateMockDataForMongooseCollection(
  collection: any,
  mongooseModel: { name: string; filePath: string }
): Promise<void> {
  // Check if collection already has data
  try {
    const existingCount = await collection.countDocuments()
    if (existingCount > 0) {
      console.log(`   ℹ️  Collection ${mongooseModel.name} already has data, skipping mock data generation`)
      return
    }
  } catch {
    // Collection might not exist yet, continue with mock data generation
  }
  
  // Generate 1 mock document with basic structure
  const { ObjectId } = await import('mongodb')
  const mockDocument: any = {
    _id: new ObjectId(),
  }
  
  // Add common fields based on model name
  const modelNameLower = mongooseModel.name.toLowerCase()
  if (modelNameLower.includes('product')) {
    mockDocument.productId = crypto.randomUUID()
    mockDocument.title = 'Sample Product'
    mockDocument.description = 'This is a sample product description'
    mockDocument.price = 99.99
    mockDocument.categories = ['electronics']
    mockDocument.images = ['https://example.com/image.jpg']
    mockDocument.metadata = { brand: 'Sample Brand', sku: 'SKU-001' }
  } else if (modelNameLower.includes('analytics') || modelNameLower.includes('log')) {
    mockDocument.event = 'page_view'
    mockDocument.timestamp = new Date()
    mockDocument.data = { page: '/home', userId: 'user-123' }
  } else if (modelNameLower.includes('media') || modelNameLower.includes('storage')) {
    mockDocument.url = 'https://example.com/file.jpg'
    mockDocument.type = 'image'
    mockDocument.size = 1024
    mockDocument.uploadedAt = new Date()
  } else {
    // Generic mock document
    mockDocument.name = `Sample ${mongooseModel.name}`
    mockDocument.createdAt = new Date()
    mockDocument.updatedAt = new Date()
  }
  
  try {
    await collection.insertOne(mockDocument)
    console.log(`   ✅ Inserted 1 mock document into ${mongooseModel.name}`)
  } catch (insertError: any) {
    console.warn(`   ⚠️  Failed to insert mock document for ${mongooseModel.name}:`, insertError.message)
  }
}

/**
 * Generate mock data for a fallback MongoDB collection
 */
async function generateMockDataForFallbackCollection(
  collection: any,
  collectionName: string
): Promise<void> {
  // Check if collection already has data
  try {
    const existingCount = await collection.countDocuments()
    if (existingCount > 0) {
      console.log(`   ℹ️  Collection ${collectionName} already has data, skipping mock data generation`)
      return
    }
  } catch {
    // Collection might not exist yet, continue with mock data generation
  }
  
  // Generate 1 mock document with basic structure
  const { ObjectId } = await import('mongodb')
  const mockDocument: any = {
    _id: new ObjectId(),
  }
  
  // Add fields based on collection name
  const nameLower = collectionName.toLowerCase()
  if (nameLower.includes('product')) {
    mockDocument.productId = crypto.randomUUID()
    mockDocument.title = 'Sample Product'
    mockDocument.description = 'This is a sample product description'
    mockDocument.price = 99.99
    mockDocument.categories = ['electronics']
    mockDocument.images = ['https://example.com/image.jpg']
    mockDocument.metadata = { brand: 'Sample Brand', sku: 'SKU-001' }
    mockDocument.reviews = []
  } else if (nameLower.includes('analytics')) {
    mockDocument.event = 'page_view'
    mockDocument.timestamp = new Date()
    mockDocument.data = { page: '/home', userId: 'user-123' }
    mockDocument.sessionId = crypto.randomUUID()
  } else if (nameLower.includes('media') || nameLower.includes('storage')) {
    mockDocument.url = 'https://example.com/file.jpg'
    mockDocument.type = 'image'
    mockDocument.size = 1024
    mockDocument.uploadedAt = new Date()
    mockDocument.metadata = { width: 1920, height: 1080, format: 'jpeg' }
  } else if (nameLower.includes('log')) {
    mockDocument.level = 'info'
    mockDocument.message = 'Sample log entry'
    mockDocument.timestamp = new Date()
    mockDocument.context = { userId: 'user-123', action: 'login' }
  } else {
    // Generic mock document
    mockDocument.name = `Sample ${collectionName}`
    mockDocument.createdAt = new Date()
    mockDocument.updatedAt = new Date()
    mockDocument.data = { sample: true }
  }
  
  try {
    await collection.insertOne(mockDocument)
    console.log(`   ✅ Inserted 1 mock document into ${collectionName}`)
  } catch (insertError: any) {
    console.warn(`   ⚠️  Failed to insert mock document for ${collectionName}:`, insertError.message)
  }
}

/**
 * Convert table plans from ProjectMetadata to Prisma model format
 * This bridges AI-extracted metadata with database creation logic
 */
function tablePlansToModels(tablePlans: any[]): PrismaModel[] {
  return tablePlans.map((plan) => {
    const fields: any[] = []
    
    // Always add canonical id field first (skip any user-provided id column in the loop below)
    fields.push({
      name: 'id',
      type: 'String',
      isRequired: true,
      isUnique: true,
      isId: true,
      default: { uuid: true },
    })
    
    // Normalize column names: convert snake_case system field variants to camelCase
    // so we never generate duplicate fields (e.g. created_at + createdAt)
    const CREATED_AT_VARIANTS = new Set(['createdat', 'created_at'])
    const UPDATED_AT_VARIANTS = new Set(['updatedat', 'updated_at'])
    const ID_VARIANTS = new Set(['id'])

    const hasCreatedAt = plan.columns?.some((col: any) => CREATED_AT_VARIANTS.has(col.name.toLowerCase()))
    const hasUpdatedAt = plan.columns?.some((col: any) => UPDATED_AT_VARIANTS.has(col.name.toLowerCase()))

    // Convert plan columns to Prisma fields, skipping system field variants
    // (they will be added canonically below)
    const seenFieldNames = new Set<string>()
    plan.columns?.forEach((column: any) => {
      const nameLower = column.name.toLowerCase()

      // Skip system field variants — they'll be added canonically
      if (CREATED_AT_VARIANTS.has(nameLower) || UPDATED_AT_VARIANTS.has(nameLower) || ID_VARIANTS.has(nameLower)) {
        return
      }

      // Deduplicate any remaining fields
      if (seenFieldNames.has(nameLower)) return
      seenFieldNames.add(nameLower)

      // Map data types
      let prismaType = 'String'
      const typeLower = column.type?.toLowerCase() || 'string'

      if (typeLower.includes('int') || typeLower.includes('number')) {
        prismaType = 'Int'
      } else if (typeLower.includes('float') || typeLower.includes('decimal')) {
        prismaType = 'Float'
      } else if (typeLower.includes('bool')) {
        prismaType = 'Boolean'
      } else if (typeLower.includes('date') || typeLower.includes('time')) {
        prismaType = 'DateTime'
      } else if (typeLower.includes('json')) {
        prismaType = 'Json'
      }

      fields.push({
        name: column.name,
        type: prismaType,
        isRequired: column.required !== false,
        isUnique: column.unique || false,
        isId: false,
        default: undefined,
        relation: column.references ? {
          referencesTable: column.references,
          referencesField: 'id',
        } : undefined,
      })
    })

    // Add createdAt if missing (canonical camelCase only)
    if (!hasCreatedAt) {
      fields.push({
        name: 'createdAt',
        type: 'DateTime',
        isRequired: true,
        default: { now: true },
      })
    }

    // Add updatedAt if missing (canonical camelCase only)
    if (!hasUpdatedAt) {
      fields.push({
        name: 'updatedAt',
        type: 'DateTime',
        isRequired: true,
        default: { updatedAt: true },
      })
    }
    
    return {
      name: plan.name,
      fields,
      isMongoDB: false, // Default to PostgreSQL
    }
  })
}

