'use client'

/**
 * DATA (MANAGED) - SECTION BOUNDARY ENFORCEMENT
 * ==================================================
 * 
 * PURPOSE: Convert intent into reality (THE ONLY SECTION THAT CAN)
 * 
 * ✅ ALLOWED:
 * - Plan tables (show metadata before creation)
 * - Show warnings before "Make Real" action
 * - Create real database tables
 * - Auto-create API Definitions with tables
 * - Edit table structure (with warnings)
 * - View/edit real table data
 * 
 * ❌ NOT ALLOWED:
 * - Silent table creation without confirmation
 * - Auto-rebuilding schema after edits
 * - Regenerating from metadata after tables exist
 * - Showing fake/temporary tables
 * 
 * REASONING: Database is where intent becomes irreversible reality.
 * This is why confirmation modal is mandatory.
 * 
 * SOURCE OF TRUTH: Workspace PostgreSQL + tables table
 * REQUIRES CONFIRMATION: Yes (one-way operation)
 * GOLDEN RULE: This is the ONLY section that creates backend reality.
 * 
 * See: lib/config/SECTION_BOUNDARIES.ts
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Plus, Search, RefreshCw, Database as DatabaseIcon,
  Filter, ArrowUpDown, ArrowUp, ArrowDown, X, ChevronDown, ChevronRight, ChevronLeft,
  FileCode, Save, Edit2, Trash2, Copy, Download, Upload,
  Table2, Columns, Settings, Eye, EyeOff, Key,
  Info, MoreVertical, Play, Building2, Folder, Activity, Network, CheckCircle2, Loader2,
  Maximize2, Minimize2, HelpCircle, AlertCircle
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import { KitNote } from '@/components/inspector/kit'
import {
  getSchemas,
  getTables,
  getStructure,
  getRows,
  getIndexes,
  insertRow,
  updateRow,
  deleteRow,
  addColumn,
  renameColumn,
  dropColumn,
  validateProjectAccess,
  type TableInfo,
  type ColumnInfo,
  type IndexInfo,
  type DatabaseType,
} from '@/lib/api/database'
import { useParams, useRouter } from 'next/navigation'
import { getCurrentProjectId } from '@/lib/api/client'
import EnhancedSchemaVisualizer from '@/components/database/EnhancedSchemaVisualizer'


type ViewMode = 'data' | 'structure'
type TableView = 'data' | 'structure'
type DatabaseView = 'tables' | 'visualization'

// Rows fetched per page in the data browser. Kept in one place so the
// pagination footer, the "step back a page after delete" math, and the query
// all agree.
const PAGE_SIZE = 50

interface Table {
  schema?: string
  name: string
  rows?: number
  documents?: number
  size: string
  description?: string
}

interface Column {
  name: string
  type: string
  nullable: boolean
  primary?: boolean
  foreign?: boolean
  default?: string
  unique?: boolean
  indexed?: boolean
  description?: string
}

interface Row {
  [key: string]: any
}

interface Index {
  name: string
  columns: string[]
  unique: boolean
  type: string
}

export default function ProjectDatabasePage() {
  const router = useRouter()
  const { id: urlProjectId } = useParams<{ id: string }>()
  
  // Get the actual current project ID to ensure we're working with the right context
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  
  // Track if we're in the middle of redirecting to prevent re-validation loops
  const [isRedirecting, setIsRedirecting] = useState(false)
  
  // Track if initial validation has completed
  const [isValidated, setIsValidated] = useState(false)
  
  // Project display name (instead of UUID)
  const [displayProjectName, setDisplayProjectName] = useState<string>('')
  
  // Resolve the definitive project ID - prioritize URL param, fallback to current session project
  const resolvedProjectId = urlProjectId || currentProjectId
  
  const [activeDb, setActiveDb] = useState<DatabaseType>('postgresql')
  const [databaseView, setDatabaseView] = useState<'platform' | 'workspace' | 'all'>('workspace')
  const [schemas, setSchemas] = useState<string[]>([])
  const [selectedSchema, setSelectedSchema] = useState<string | null>(null)
  const [tables, setTables] = useState<Table[]>([])
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [columns, setColumns] = useState<Column[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [indexes, setIndexes] = useState<Index[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('data')
  const [searchTerm, setSearchTerm] = useState('')
  const [filterColumn, setFilterColumn] = useState<string | null>(null)
  const [filterValue, setFilterValue] = useState('')
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [totalRows, setTotalRows] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [selectedRow, setSelectedRow] = useState<Row | null>(null)
  const [hoveredRow, setHoveredRow] = useState<number | null>(null)

  // Committed search term (what's actually sent to the server). `searchTerm` is
  // the live input; a debounce effect promotes it to `committedSearch`.
  const [committedSearch, setCommittedSearch] = useState('')

  // Row editor (click a row → view / edit / delete). All fields are strings in
  // the form; we coerce back to column types on save.
  const [editingRow, setEditingRow] = useState<Row | null>(null)
  const [editRowData, setEditRowData] = useState<Record<string, any>>({})
  const [savingRow, setSavingRow] = useState(false)
  const [deletingRow, setDeletingRow] = useState(false)

  // Monotonic counter so a slow rows request can never overwrite a newer one
  // (e.g. fast typing in search, or switching tables mid-fetch).
  const rowReqSeq = useRef(0)
  const [showSQLModal, setShowSQLModal] = useState(false)
  const [sqlQuery, setSqlQuery] = useState('')
  const [sqlResults, setSqlResults] = useState<Row[]>([])
  const [sqlError, setSqlError] = useState<string | null>(null)
  const [showAddRowModal, setShowAddRowModal] = useState(false)
  const [newRowData, setNewRowData] = useState<Record<string, any>>({})
  const [showQueryBuilder, setShowQueryBuilder] = useState(false)
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set())
  const [showVisualization, setShowVisualization] = useState<DatabaseView>('tables')
  const [setupSuccess, setSetupSuccess] = useState(false)
  const [setupMessage, setSetupMessage] = useState<string | null>(null)
  const [isVisualizationExpanded, setIsVisualizationExpanded] = useState(false)
  
  // New table creation state
  const [showCreateTableModal, setShowCreateTableModal] = useState(false)
  const [newTableName, setNewTableName] = useState('')
  const [newTableDescription, setNewTableDescription] = useState('')
  const [creatingTable, setCreatingTable] = useState(false)
  
  // Delete table state
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [tableToDelete, setTableToDelete] = useState<string | null>(null)
  const [deletingTable, setDeletingTable] = useState(false)

  // Column-edit state (Structure view inline mutations — all funnel through
  // the canonical tableLifecycle service, so manual edits behave exactly like
  // AI-driven ones: schema snapshot, typegen, validator cache invalidation).
  const [showAddColumnModal, setShowAddColumnModal] = useState(false)
  const [newColumnName, setNewColumnName] = useState('')
  const [newColumnType, setNewColumnType] = useState('text')
  const [newColumnNullable, setNewColumnNullable] = useState(true)
  const [addingColumn, setAddingColumn] = useState(false)

  const [renamingColumn, setRenamingColumn] = useState<string | null>(null)
  const [renameColumnNewName, setRenameColumnNewName] = useState('')
  const [savingRename, setSavingRename] = useState(false)

  const [columnToDelete, setColumnToDelete] = useState<string | null>(null)
  const [showDeleteColumnModal, setShowDeleteColumnModal] = useState(false)
  const [droppingColumn, setDroppingColumn] = useState(false)
  
  // Metadata (for history/reference only - not for UI state)
  const [metadata, setMetadata] = useState<any>(null)
  const [loadingMetadata, setLoadingMetadata] = useState(false)

  // Load the current project ID from session/storage if not in URL
  useEffect(() => {
    if (urlProjectId) {
      setCurrentProjectId(urlProjectId)
      return
    }

    async function loadCurrentProjectId() {
      try {
        const id = await getCurrentProjectId()
        setCurrentProjectId(id)
        console.log('🔄 [Database] Loaded current project ID from session:', id)
      } catch (err) {
        console.error('❌ [Database] Failed to load current project ID:', err)
      }
    }
    
    loadCurrentProjectId()
  }, [urlProjectId])

  // 🚫 CRITICAL: Validate project access BEFORE loading anything
  useEffect(() => {
    if (!resolvedProjectId || isRedirecting) return;
    
    // Prevent duplicate calls in React 18 Strict Mode
    let cancelled = false;
    
    const validate = async () => {
      if (cancelled) return;
      await validateAndLoadProject();
    };
    
    validate();
    
    return () => {
      cancelled = true;
    };
  }, [resolvedProjectId, isRedirecting])
  
  const validateAndLoadProject = async () => {
    if (!resolvedProjectId || isRedirecting) return;
    
    // Use sessionStorage to prevent validation loops across redirects
    const validationKey = `db_validated_${resolvedProjectId}`;
    const alreadyValidated = sessionStorage.getItem(validationKey);
    
    if (alreadyValidated === 'true') {
      console.log('⏭️ [Database] Skipping re-validation, already validated:', resolvedProjectId);
      // Just load the data without re-validating
      setIsValidated(true);
      setLoading(true);
      await Promise.all([
        loadSchemas(),
        loadMetadata()
      ]);
      return;
    }
    
    console.log('🚫 [Database] Validating project access:', resolvedProjectId);
    
    try {
      setLoading(true);
      setError(null);
      
      // 🚫 LAYER 3: NEVER trust URL projectId - validate first!
      const validation = await validateProjectAccess(resolvedProjectId);
      
      if (!validation.valid) {
        console.error('❌ [Database] Project validation failed:', validation.error);
        
        switch (validation.error) {
          case 'NOT_FOUND': {
            // 🔄 SMART RECOVERY: Try to fall back to a valid current project
            try {
              const fallbackProjectId = await getCurrentProjectId();
              if (fallbackProjectId && fallbackProjectId !== resolvedProjectId) {
                console.warn('⚠️ [Database] URL projectId invalid, auto-recovering with fallback project:', {
                  invalidProjectId: resolvedProjectId,
                  fallbackProjectId,
                });
                // Set redirecting flag to prevent re-validation during navigation
                setIsRedirecting(true);
                // Silently redirect to the valid fallback project
                router.replace(`/app/projects/${fallbackProjectId}/database`);
                return;
              }
            } catch (fallbackError) {
              console.error('❌ [Database] Failed to resolve fallback project:', fallbackError);
            }

            // No valid fallback - show error and redirect to projects page
            setError('This project does not exist or you do not have access to it.');
            setTimeout(() => {
              setIsRedirecting(true);
              router.replace('/app');
            }, 2000);
            break;
          }
            
          case 'UNAUTHORIZED':
            setError('Please log in to continue.');
            setTimeout(() => {
              setIsRedirecting(true);
              router.replace('/auth/login');
            }, 2000);
            break;
            
          default:
            setError(validation.message || 'Failed to validate project access');
        }
        
        setLoading(false);
        return; // 🚫 STOP HERE - do not proceed!
      }
      
      console.log('✅ [Database] Project validation passed, loading schemas and metadata...');
      
      // Set project display name from validation result if available
      if ((validation as any).project?.name) {
        setDisplayProjectName((validation as any).project.name)
      } else {
        // Fallback: fetch project name
        fetch(`/api/projects/${resolvedProjectId}`, { credentials: 'include' })
          .then(r => r.json())
          .then(d => { if (d.success && d.data?.name) setDisplayProjectName(d.data.name) })
          .catch(() => {})
      }
      
      // Mark this project as validated in sessionStorage
      sessionStorage.setItem(validationKey, 'true');
      setIsValidated(true);
      
      // Project is valid - now load schemas AND metadata
      await Promise.all([
        loadSchemas(),
        loadMetadata()
      ]);
      
    } catch (err: any) {
      console.error('❌ [Database] Validation error:', err);
      setError('Failed to validate project access');
      setLoading(false);
    }
  }

  // Load initial data using the URL parameter - REMOVED, handled by validateAndLoadProject
  // useEffect(() => {
  //   if (projectId) {
  //     loadSchemas()
  //   }
  // }, [projectId])

  // Load schemas when database type changes
  useEffect(() => {
    if (resolvedProjectId && !loading && isValidated) {
      // Only reload if project is already validated
      loadSchemas()
      setSelectedSchema(null)
      setSelectedTable(null)
    }
  }, [activeDb, isValidated])

  // Load tables when schema changes
  useEffect(() => {
    if (selectedSchema) {
      loadTables()
      setSelectedTable(null)
    }
  }, [selectedSchema])

  // Table switch — reset all view controls to defaults, then load the fresh
  // structure and first page. We pass explicit defaults to loadRows so it never
  // fires with the previous table's page/sort/search still in state.
  useEffect(() => {
    if (!selectedTable || !selectedSchema) return
    setCurrentPage(1)
    setSearchTerm('')
    setCommittedSearch('')
    setSortColumn(null)
    setSortDirection('asc')
    setViewMode('data')
    setEditingRow(null)
    loadStructure()
    loadRows({ page: 1, search: '', sortBy: null, sortOrder: 'asc' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTable])

  // Debounce the search box into the committed term and reload from page 1.
  useEffect(() => {
    if (!selectedTable) return
    const trimmed = searchTerm.trim()
    const handle = setTimeout(() => {
      if (trimmed === committedSearch) return
      setCommittedSearch(trimmed)
      setCurrentPage(1)
      loadRows({ page: 1, search: trimmed })
    }, 350)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm])

  // Handle ESC key to exit fullscreen
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isVisualizationExpanded) {
        setIsVisualizationExpanded(false)
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isVisualizationExpanded])

  // Chat-driven schema changes (ChatDock dispatches backenly:database-changed
  // after any state-changing agent turn). Re-fetch the table list, keep the
  // user's current selection if it still exists, and move off it if the agent
  // just dropped it — this is what makes a chat "drop table X" disappear from
  // this sidebar without a manual refresh.
  useEffect(() => {
    const onDatabaseChanged = async () => {
      if (!selectedSchema) return
      try {
        const tableList = await getTables(activeDb, selectedSchema, { projectId: resolvedProjectId || undefined, view: databaseView })
        setTables(tableList)
        setSelectedTable(prev => {
          if (prev && tableList.some(t => t.name === prev)) return prev
          return tableList.length > 0 ? tableList[0].name : null
        })
      } catch {
        // Best-effort refresh — the manual Refresh button still works.
      }
    }
    window.addEventListener('backenly:database-changed', onDatabaseChanged)
    return () => window.removeEventListener('backenly:database-changed', onDatabaseChanged)
  }, [selectedSchema, activeDb, databaseView, resolvedProjectId])

  const loadSchemas = async () => {
    if (!resolvedProjectId) {
      console.warn('No projectId available, skipping schema load')
      return
    }
      
    try {
      // ⚡ OPTIMIZATION: If we already have schemas for this project, don't show loading
      if (schemas.length === 0) {
        setLoading(true)
      }
      setError(null)
        
      // For workspace context, we only want to show the current project's workspace schema
      const schemaList = await getSchemas({ projectId: resolvedProjectId, view: 'workspace' })
        
      // Filter to only show the current project's workspace
      const projectWorkspace = `workspace_${resolvedProjectId}`
      const filteredSchemas = schemaList.filter(schema => schema === projectWorkspace)
        
      console.log('Loaded schemas for project:', { projectId: resolvedProjectId, allSchemas: schemaList, filtered: filteredSchemas })
        
      setSchemas(filteredSchemas)
        
      // Auto-select the project's workspace schema
      if (filteredSchemas.length > 0) {
        setSelectedSchema(filteredSchemas[0])
        // Auto-expand the schema so tables are visible
        const newExpanded = new Set(expandedSchemas)
        newExpanded.add(filteredSchemas[0])
        setExpandedSchemas(newExpanded)
      } else {
        setError(`No workspace found for this project. Expected schema: ${projectWorkspace}`)
      }
    } catch (err: any) {
      console.error('Error loading schemas:', err)
        
      // 🚫 Handle specific error codes
      if (err.message === 'PROJECT_NOT_FOUND') {
        setError('This project no longer exists.')
        setTimeout(() => router.replace('/app'), 2000);
      } else if (err.message === 'PROJECT_FORBIDDEN') {
        setError('You do not have access to this project.')
        setTimeout(() => router.replace('/app'), 2000);
      } else if (err.message === 'UNAUTHORIZED') {
        setError('Please log in again.')
        setTimeout(() => router.replace('/auth/login'), 2000);
      } else {
        setError(err.message || 'Failed to load schemas')
      }
    } finally {
      setLoading(false)
    }
  }

  const loadTables = async (skipAutoSetup = false) => {
    if (!selectedSchema) return
    try {
      setLoading(true)
      setError(null)
      const tableList = await getTables(activeDb, selectedSchema, { projectId: resolvedProjectId || undefined, view: databaseView })

      // Hide the built-in `users` auth table while it is just empty scaffolding
      // on a not-yet-built project. Backenly seeds this table for end-user auth,
      // but a freshly-named project (no agent connected, no signups) should read
      // as empty — showing a `users` table nobody created is the exact "faked
      // before you built anything" surface we are removing. It reappears from the
      // live workspace schema even after a manual delete, so suppress it here at
      // the display layer instead. A `users` table with real rows, or ANY real
      // (non-users) table beside it, always shows — we only drop the empty
      // placeholder that stands alone.
      const realTables = tableList.filter(t => t.name.toLowerCase() !== 'users')
      const usersTable = tableList.find(t => t.name.toLowerCase() === 'users')
      const usersIsEmptyScaffold = !!usersTable && (usersTable.rows ?? 0) === 0 && realTables.length === 0
      const visibleTables = usersIsEmptyScaffold ? realTables : tableList
      setTables(visibleTables)

      // Auto-select the first table so the data view is shown immediately
      if (visibleTables.length > 0) {
        setSelectedTable(visibleTables[0].name)
      }

      // No eager auto-setup. Backenly is agent-native: a freshly-named project
      // has NOT been built yet, so an empty workspace must read as empty — we
      // never provision a placeholder `users` table on first visit just to have
      // something to show. Tables appear when the connected coding agent (or a
      // real end-user signup) genuinely creates them. `_skipAutoSetup` is kept
      // only for the manual "Prepare workspace" affordance below.
      void skipAutoSetup
    } catch (err: any) {
      console.error('Error loading tables:', err)
      setError(err.message || 'Failed to load tables')
    } finally {
      setLoading(false)
    }
  }
  
  const checkAndSetupDatabase = async () => {
    if (!resolvedProjectId) return
    
    try {
      console.log('[Database] Checking if automatic setup is needed...')
      setLoading(true)
      setSetupSuccess(false)
      setSetupMessage(null)
      
      // Call the setup API with explicit projectId
      const response = await fetch(`/api/database/setup-workspace?projectId=${resolvedProjectId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ projectId: resolvedProjectId })
      })
      
      if (response.ok) {
        const result = await response.json()
        if (result.success && result.details?.totalTables > 0) {
          console.log(`[Database] ✅ Auto-setup successful! Created ${result.details.totalTables} tables`)
          setSetupSuccess(true)
          setSetupMessage(`Successfully created ${result.details.totalTables} tables: ${result.details.tablesCreated.join(', ')}`)
          // Reload tables to show the newly created ones (skip auto-setup to prevent loop)
          setTimeout(() => {
            loadTables(true) // Skip auto-setup on this reload
            // Clear success message after 5 seconds
            setTimeout(() => {
              setSetupSuccess(false)
              setSetupMessage(null)
            }, 5000)
          }, 1000)
        } else if (result.success) {
          // Project has no tables yet — this is a valid empty state, don't show any message
          console.log('[Database] Project workspace ready — no tables created yet')
          setSetupMessage(null)
        } else {
          console.log('[Database] No tables to create from schema')
          setSetupMessage('No Prisma schema found or no tables to create')
        }
      } else {
        const error = await response.json()
        console.log('[Database] Auto-setup not needed or failed:', error.error)
        setSetupMessage(error.error || 'Setup failed')
      }
    } catch (err: any) {
      console.log('[Database] Auto-setup check failed:', err.message)
      setSetupMessage('Failed to setup database. Please try again.')
      // Silently fail - user can manually trigger if needed
    } finally {
      setLoading(false)
    }
  }
  
  // PHASE 3: Load metadata (planned tables)
  // Load metadata for historical reference only (not displayed in UI)
  const loadMetadata = async () => {
    if (!resolvedProjectId) return
    
    try {
      setLoadingMetadata(true)
      console.log('📊 [Database] Loading project metadata...')
      
      const response = await fetch(`/api/projects/${resolvedProjectId}/metadata`, {
        credentials: 'include' // Required to send cookies for authentication
      })
      
      if (!response.ok) {
        if (response.status === 404) {
          console.log('ℹ️ [Database] No metadata found yet')
          setMetadata(null)
          return
        }
        throw new Error('Failed to load metadata')
      }
      
      const data = await response.json()
      console.log('✅ [Database] Metadata loaded:', data)
      
      setMetadata(data.metadata)
      // With bootstrap flow, all tables are real - no planned state
    } catch (err: any) {
      console.error('❌ [Database] Failed to load metadata:', err)
      setMetadata(null)
    } finally {
      setLoadingMetadata(false)
    }
  }
  
  // Removed: makeTablesReal() - with bootstrap flow, tables are created atomically during project creation

  // Load the column structure (+ indexes) for the selected table. Only changes
  // when the table itself changes, so it's decoupled from row paging/sort/search.
  const loadStructure = async () => {
    if (!selectedTable || !selectedSchema) return
    try {
      const structure = await getStructure(activeDb, selectedTable, selectedSchema, { projectId: resolvedProjectId || undefined, view: databaseView })
      setColumns(structure)

      if (activeDb === 'postgresql') {
        try {
          const indexList = await getIndexes(selectedSchema, selectedTable, { projectId: resolvedProjectId || undefined, view: databaseView })
          setIndexes(indexList)
        } catch (err) {
          console.warn('Could not load indexes:', err)
          setIndexes([])
        }
      }
    } catch (err: any) {
      console.error('Error loading structure:', err)
      setError(err.message || 'Failed to load table structure')
    }
  }

  // Load a page of rows. Overrides let callers fetch with values that haven't
  // been committed to state yet (avoids the classic setState-is-async paging
  // bug). A request-sequence guard drops responses that a newer request beat.
  const loadRows = async (override?: {
    page?: number
    search?: string
    sortBy?: string | null
    sortOrder?: 'asc' | 'desc'
  }) => {
    if (!selectedTable || !selectedSchema) return
    const page = override?.page ?? currentPage
    const search = override?.search !== undefined ? override.search : committedSearch
    const sortBy = override?.sortBy !== undefined ? override.sortBy : sortColumn
    const sortOrder = override?.sortOrder ?? sortDirection

    const seq = ++rowReqSeq.current
    try {
      setLoading(true)
      setError(null)
      const rowData = await getRows(activeDb, selectedTable, {
        schema: selectedSchema,
        projectId: resolvedProjectId || undefined,
        view: databaseView,
        limit: PAGE_SIZE,
        page,
        sortBy: sortBy || undefined,
        sortOrder,
        search: search || undefined,
      })
      if (seq !== rowReqSeq.current) return // superseded by a newer request
      setRows(rowData.data || [])
      setTotalRows(rowData.pagination?.total || 0)
      setTotalPages(rowData.pagination?.totalPages || 0)
    } catch (err: any) {
      if (seq !== rowReqSeq.current) return
      console.error('Error loading rows:', err)
      setError(err.message || 'Failed to load rows')
    } finally {
      if (seq === rowReqSeq.current) setLoading(false)
    }
  }

  // Full reload (structure + rows) — used after schema-changing mutations and
  // by the manual refresh button.
  const loadTableData = async () => {
    await Promise.all([loadStructure(), loadRows()])
  }

  const handleRefresh = () => {
    if (selectedTable) {
      loadStructure()
      loadRows()
    } else if (selectedSchema) {
      loadTables()
    } else {
      loadSchemas()
    }
  }

  const goToPage = (page: number) => {
    const target = Math.min(Math.max(1, page), Math.max(1, totalPages))
    if (target === currentPage) return
    setCurrentPage(target)
    loadRows({ page: target })
  }

  // Column header click cycles: none → asc → desc → none.
  const handleSort = (colName: string) => {
    let nextCol: string | null = colName
    let nextDir: 'asc' | 'desc' = 'asc'
    if (sortColumn === colName) {
      if (sortDirection === 'asc') {
        nextDir = 'desc'
      } else {
        nextCol = null
        nextDir = 'asc'
      }
    }
    setSortColumn(nextCol)
    setSortDirection(nextDir)
    setCurrentPage(1)
    loadRows({ page: 1, sortBy: nextCol, sortOrder: nextDir })
  }

  const toggleSchema = (schema: string) => {
    const newExpanded = new Set(expandedSchemas)
    if (newExpanded.has(schema)) {
      newExpanded.delete(schema)
    } else {
      newExpanded.add(schema)
    }
    setExpandedSchemas(newExpanded)
  }

  const handleAddRow = () => {
    setNewRowData({})
    setError(null)
    setShowAddRowModal(true)
  }

  const saveNewRow = async () => {
    if (!selectedTable || !selectedSchema) return
    try {
      setLoading(true)
      setError(null)
      
      // Convert data types based on column types
      const processedData: Record<string, any> = {}
      
      for (const [key, value] of Object.entries(newRowData)) {
        if (value === '' || value === null || value === undefined) {
          // Skip empty values - let database handle defaults/nulls
          continue
        }
        
        const column = columns.find(c => c.name === key)
        if (!column) {
          processedData[key] = value
          continue
        }
        
        // Skip auto-generated columns (createdAt, updatedAt with defaults)
        const isAutoTimestamp = (key.toLowerCase() === 'createdat' || key.toLowerCase() === 'updatedat') && 
                                (column.default?.includes('now()') || column.default?.includes('CURRENT_TIMESTAMP'))
        if (isAutoTimestamp) {
          console.log(`Skipping auto-generated column: ${key}`)
          continue
        }
        
        const typeLower = column.type.toLowerCase()
        
        // Type conversion based on column type
        if (typeLower.includes('int') || typeLower.includes('serial') || typeLower.includes('bigint')) {
          const parsed = parseInt(value as string, 10)
          if (!isNaN(parsed)) {
            processedData[key] = parsed
          }
        } else if (typeLower.includes('float') || typeLower.includes('double') || typeLower.includes('decimal') || typeLower.includes('numeric')) {
          const parsed = parseFloat(value as string)
          if (!isNaN(parsed)) {
            processedData[key] = parsed
          }
        } else if (typeLower.includes('bool')) {
          processedData[key] = value === 'true' || value === '1' || value === true
        } else if (typeLower.includes('date') || typeLower.includes('timestamp')) {
          // Only include if user explicitly provided a valid date
          if (value && value !== '') {
            const dateValue = new Date(value as string)
            if (!isNaN(dateValue.getTime())) {
              processedData[key] = dateValue.toISOString()
            }
          }
        } else {
          // String types - use as-is
          processedData[key] = value
        }
      }
      
      console.log('Inserting row with processed data:', processedData)
      
      await insertRow(activeDb, selectedTable, processedData, selectedSchema, resolvedProjectId || undefined)
      setShowAddRowModal(false)
      setNewRowData({})
      loadRows()
    } catch (err: any) {
      console.error('Error adding row:', err)
      // Surfaced inline inside the modal — the modal stays open on failure.
      setError(err.message || 'Failed to add row')
    } finally {
      setLoading(false)
    }
  }

  // ── Row editor (view / edit / delete a single row) ────────────────────────
  // Coerce a form string back to the column's real type. Returns `undefined`
  // to mean "skip this field" (e.g. an empty value on a non-nullable column).
  const coerceValueForColumn = (col: Column, raw: any): any => {
    const typeLower = col.type.toLowerCase()
    if (raw === '' || raw === null || raw === undefined) {
      return col.nullable ? null : undefined
    }
    if (typeLower.includes('int') || typeLower.includes('serial') || typeLower.includes('bigint')) {
      const n = parseInt(raw as string, 10)
      return isNaN(n) ? undefined : n
    }
    if (typeLower.includes('float') || typeLower.includes('double') || typeLower.includes('decimal') || typeLower.includes('numeric') || typeLower.includes('real')) {
      const n = parseFloat(raw as string)
      return isNaN(n) ? undefined : n
    }
    if (typeLower.includes('bool')) {
      return raw === 'true' || raw === '1' || raw === true
    }
    if (typeLower.includes('json')) {
      try { return JSON.parse(raw as string) } catch { return raw }
    }
    if (typeLower.includes('date') || typeLower.includes('timestamp')) {
      const d = new Date(raw as string)
      return isNaN(d.getTime()) ? undefined : d.toISOString()
    }
    return raw
  }

  // The primary-key value used to target the row for update/delete.
  const rowPkValue = (row: Row | null): any => {
    if (!row) return undefined
    const pkCol = columns.find(c => c.primary)?.name || 'id'
    return row[pkCol] ?? row['id']
  }

  const openRowEditor = (row: Row) => {
    setEditingRow(row)
    const init: Record<string, any> = {}
    for (const col of columns) {
      const v = row[col.name]
      init[col.name] = v === null || v === undefined
        ? ''
        : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v)
    }
    setEditRowData(init)
    setError(null)
  }

  const closeRowEditor = () => {
    setEditingRow(null)
    setEditRowData({})
    setError(null)
  }

  const saveRowEdit = async () => {
    if (!editingRow || !selectedTable || !selectedSchema) return
    const id = rowPkValue(editingRow)
    if (id === undefined || id === null) {
      setError('This row has no id column, so it cannot be edited from here.')
      return
    }
    try {
      setSavingRow(true)
      setError(null)

      // Send only fields that actually changed, coerced back to column types.
      const payload: Record<string, any> = {}
      for (const col of columns) {
        if (col.primary || isReservedColumn(col.name)) continue // id / timestamps are managed
        const original = editingRow[col.name]
        const originalStr = original === null || original === undefined
          ? ''
          : typeof original === 'object' ? JSON.stringify(original) : String(original)
        const currentStr = editRowData[col.name] ?? ''
        if (currentStr === originalStr) continue
        const coerced = coerceValueForColumn(col, currentStr)
        if (coerced !== undefined) payload[col.name] = coerced
      }

      if (Object.keys(payload).length === 0) {
        // Nothing to save — just close.
        closeRowEditor()
        return
      }

      await updateRow(activeDb, selectedTable, id, payload, selectedSchema, resolvedProjectId || undefined)
      closeRowEditor()
      await loadRows()
    } catch (err: any) {
      console.error('Error updating row:', err)
      setError(err.message || 'Failed to update row')
    } finally {
      setSavingRow(false)
    }
  }

  const deleteEditingRow = async () => {
    if (!editingRow || !selectedTable || !selectedSchema) return
    const id = rowPkValue(editingRow)
    if (id === undefined || id === null) {
      setError('This row has no id column, so it cannot be deleted from here.')
      return
    }
    try {
      setDeletingRow(true)
      setError(null)
      await deleteRow(activeDb, selectedTable, id, selectedSchema, resolvedProjectId || undefined)
      closeRowEditor()
      // If that was the last row on the page, step back so we don't land on an
      // empty page.
      const remaining = Math.max(0, totalRows - 1)
      const lastPage = Math.max(1, Math.ceil(remaining / PAGE_SIZE))
      const target = Math.min(currentPage, lastPage)
      if (target !== currentPage) {
        setCurrentPage(target)
        await loadRows({ page: target })
      } else {
        await loadRows()
      }
    } catch (err: any) {
      console.error('Error deleting row:', err)
      setError(err.message || 'Failed to delete row')
    } finally {
      setDeletingRow(false)
    }
  }

  const handleCreateTable = async () => {
    if (!newTableName.trim() || !selectedSchema || !resolvedProjectId) return

    try {
      setCreatingTable(true)
      setError(null)

      // Create table via API
      const response = await fetch('/api/database/create-table', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tableName: newTableName,
          description: newTableDescription,
          schema: selectedSchema,
          databaseType: activeDb,
          projectId: resolvedProjectId,
        }),
      })
      
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to create table')
      }
      
      // Success - close modal and refresh
      setShowCreateTableModal(false)
      setNewTableName('')
      setNewTableDescription('')
      await loadTables()
      
    } catch (err: any) {
      console.error('Error creating table:', err)
      setError(err.message || 'Failed to create table')
    } finally {
      setCreatingTable(false)
    }
  }
  
  const handleDeleteTable = async () => {
    if (!tableToDelete || !selectedSchema || !resolvedProjectId) return
    
    try {
      setDeletingTable(true)
      setError(null)
      
      // Delete table via API
      const response = await fetch('/api/database/delete-table', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tableName: tableToDelete,
          schema: selectedSchema,
          databaseType: activeDb,
          projectId: resolvedProjectId,
        }),
      })
      
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to delete table')
      }
      
      // Success - close modal and refresh
      setShowDeleteModal(false)
      setTableToDelete(null)
      
      // Deselect the table if it was selected
      if (selectedTable === tableToDelete) {
        setSelectedTable(null)
      }
      
      await loadTables()
      
    } catch (err: any) {
      console.error('Error deleting table:', err)
      setError(err.message || 'Failed to delete table')
    } finally {
      setDeletingTable(false)
    }
  }

  // ── Column mutation handlers ─────────────────────────────────────────────
  // These call the same `executeAction` path the AI brain uses (via the
  // /api/database/schema/columns route + lib/services/tableLifecycle). So a
  // manual rename triggers the same schema-version snapshot, typegen refresh,
  // and Zod validator cache eviction that an AI-driven rename does.
  const handleAddColumn = async () => {
    if (!selectedTable || !resolvedProjectId || !newColumnName.trim()) return
    try {
      setAddingColumn(true)
      setError(null)
      await addColumn(resolvedProjectId, selectedTable, {
        name: newColumnName.trim(),
        type: newColumnType,
        nullable: newColumnNullable,
      })
      setShowAddColumnModal(false)
      setNewColumnName('')
      setNewColumnType('text')
      setNewColumnNullable(true)
      await loadTableData()
    } catch (err: any) {
      console.error('Error adding column:', err)
      setError(err.message || 'Failed to add column')
    } finally {
      setAddingColumn(false)
    }
  }

  const handleRenameColumn = async () => {
    if (!selectedTable || !resolvedProjectId || !renamingColumn || !renameColumnNewName.trim()) return
    if (renameColumnNewName.trim() === renamingColumn) {
      setRenamingColumn(null)
      setRenameColumnNewName('')
      return
    }
    try {
      setSavingRename(true)
      setError(null)
      await renameColumn(resolvedProjectId, selectedTable, renamingColumn, renameColumnNewName.trim())
      setRenamingColumn(null)
      setRenameColumnNewName('')
      await loadTableData()
    } catch (err: any) {
      console.error('Error renaming column:', err)
      setError(err.message || 'Failed to rename column')
    } finally {
      setSavingRename(false)
    }
  }

  const handleDropColumn = async () => {
    if (!selectedTable || !resolvedProjectId || !columnToDelete) return
    try {
      setDroppingColumn(true)
      setError(null)
      await dropColumn(resolvedProjectId, selectedTable, columnToDelete)
      setShowDeleteColumnModal(false)
      setColumnToDelete(null)
      await loadTableData()
    } catch (err: any) {
      console.error('Error dropping column:', err)
      setError(err.message || 'Failed to drop column')
    } finally {
      setDroppingColumn(false)
    }
  }

  // Reserved column names that cannot be renamed/dropped — match the executor's
  // server-side guard so the UI never offers an action that will be rejected.
  const RESERVED_COLUMNS = new Set(['id', 'createdat', 'updatedat', 'deleted_at', 'deletedat'])
  const isReservedColumn = (name: string) => RESERVED_COLUMNS.has(name.toLowerCase())

  // Muted semantic tints for data cells — telemetry, not syntax highlighting.
  const getDataTypeColor = (type: string): string => {
    const lowerType = type.toLowerCase()
    if (lowerType.includes('int') || lowerType.includes('number') || lowerType.includes('decimal') || lowerType.includes('numeric')) return 'text-sky-300/80'
    if (lowerType.includes('varchar') || lowerType.includes('text') || lowerType.includes('string')) return 'text-zinc-300'
    if (lowerType.includes('bool')) return 'text-emerald-300/80'
    if (lowerType.includes('date') || lowerType.includes('time')) return 'text-amber-500/80'
    if (lowerType.includes('json')) return 'text-rose-300/80'
    return 'text-zinc-400'
  }

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col">

      {/* ── Page header ─────────────────────────────────────── */}
      <InspectorPageHeader
        icon={DatabaseIcon}
        title="Tables"
        description="Database tables, schema, relationships, and rows"
        badge={{ label: 'Managed', variant: 'managed' }}
        stat={tables.length > 0 ? `${tables.length}` : undefined}
      />

      {/* ── Content area ────────────────────────────────────── */}
      <div className="flex-1 p-7">
        <div className="max-w-[1800px] mx-auto">

        {/* View Switcher */}
        {selectedSchema && (
          <div className="mb-4 flex items-center">
            <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
              <button
                onClick={() => setShowVisualization('tables')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors focus:outline-none ${
                  showVisualization === 'tables'
                    ? 'bg-white/[0.06] text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <Table2 className="w-3.5 h-3.5" />
                Tables
              </button>
              <button
                onClick={() => setShowVisualization('visualization')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors focus:outline-none ${
                  showVisualization === 'visualization'
                    ? 'bg-white/[0.06] text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <Network className="w-3.5 h-3.5" />
                Schema
              </button>
            </div>
          </div>
        )}
        
        {/* Setup Success/Error Message - only show for actual success (tables created) or real errors */}
        {setupMessage && setupSuccess && (
          <div className="mb-4">
            <KitNote
              tone="success"
              icon={CheckCircle2}
              title="Data ready"
              actions={
                <button
                  onClick={() => {
                    setSetupSuccess(false)
                    setSetupMessage(null)
                  }}
                  className="text-zinc-500 hover:text-zinc-200 transition-colors focus:outline-none"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              }
            >
              {setupMessage}
            </KitNote>
          </div>
        )}

        {/* Main Content */}
        <div className="flex gap-4">
          {/* Sidebar - Schema & Table List (Hidden in visualization mode) */}
          {showVisualization !== 'visualization' && (
            <div className="w-64 flex-shrink-0">
              <div className="rounded-xl border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] overflow-hidden" style={{ maxHeight: 'calc(100vh - 220px)' }}>

                {/* Sidebar Header */}
                <div className="px-4 pt-3.5 pb-3 border-b border-white/[0.06]">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Tables</span>
                    <div className="flex items-center gap-0.5">
                      <button
                        onClick={handleRefresh}
                        className="p-1.5 text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
                        title="Refresh"
                      >
                        <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                      </button>
                      <button
                        onClick={() => setShowCreateTableModal(true)}
                        className="p-1.5 text-zinc-600 hover:text-violet-300 hover:bg-white/[0.06] rounded-md transition-colors"
                        title="New table"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  {/* Workspace label */}
                  {schemas.map((schema) => (
                    <div key={schema} className="flex items-center gap-2 px-2.5 py-1.5 bg-white/[0.02] rounded-md border border-white/[0.05]">
                      <div className="w-[5px] h-[5px] rounded-full bg-violet-300 flex-shrink-0" />
                      <span className="text-[11.5px] font-medium text-zinc-300 truncate">{displayProjectName || 'workspace'}</span>
                      {tables.length > 0 && (
                        <span className="ml-auto font-mono text-[10.5px] tabular-nums text-zinc-500 flex-shrink-0">{tables.length}</span>
                      )}
                    </div>
                  ))}
                  {error && (
                    <div className="mt-2 p-2.5 bg-rose-500/[0.06] border border-rose-500/15 rounded-md text-[11px] leading-4 text-rose-300/90">
                      {error}
                    </div>
                  )}
                </div>

                {/* Table List */}
                <div className="overflow-y-auto overflow-x-hidden py-2" style={{ maxHeight: 'calc(100vh - 340px)' }}>
                  {loading && tables.length === 0 ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-4 h-4 text-white/30 animate-spin" />
                    </div>
                  ) : tables.length === 0 ? (
                    <div className="px-4 py-6 text-center space-y-3">
                      <DatabaseIcon className="w-4 h-4 text-zinc-600 mx-auto" />
                      <div>
                        <p className="text-[12px] font-semibold text-zinc-200 mb-0.5">No tables yet</p>
                        <p className="text-[11px] text-zinc-500 leading-relaxed">Connect your coding agent and it builds your schema here.</p>
                      </div>
                      <button
                        onClick={checkAndSetupDatabase}
                        disabled={loading || setupSuccess}
                        className="w-full h-7 px-3 border border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/20 hover:bg-white/[0.08] rounded-lg text-[11.5px] font-medium flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {loading ? (
                          <><Loader2 className="w-3 h-3 animate-spin" /><span>Preparing…</span></>
                        ) : setupSuccess ? (
                          <><CheckCircle2 className="w-3 h-3" /><span>Done</span></>
                        ) : (
                          <span>Prepare workspace</span>
                        )}
                      </button>
                    </div>
                  ) : (
                    <div className="px-2 space-y-px">
                      {tables.map((table) => (
                        <div
                          key={table.name}
                          className={`group relative flex items-center gap-2 px-2.5 py-[7px] rounded-md cursor-pointer transition-colors ${
                            selectedTable === table.name
                              ? 'bg-white/[0.05] text-zinc-50'
                              : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.03]'
                          }`}
                          onClick={() => setSelectedTable(table.name)}
                        >
                          {/* Active indicator */}
                          <div className={`w-[5px] h-[5px] rounded-full flex-shrink-0 transition-colors ${
                            selectedTable === table.name ? 'bg-violet-300' : 'bg-white/[0.12] group-hover:bg-white/25'
                          }`} />

                          {/* Table name */}
                          <span className={`flex-1 text-[12px] font-mono truncate transition-colors ${
                            selectedTable === table.name ? 'text-zinc-50' : ''
                          }`}>
                            {table.name}
                          </span>

                          {/* Row count — hidden on hover to show delete */}
                          <span className={`font-mono text-[10.5px] tabular-nums flex-shrink-0 transition-all ${
                            selectedTable === table.name ? 'text-zinc-400' : 'text-zinc-600'
                          } group-hover:opacity-0`}>
                            {table.rows ?? 0}
                          </span>

                          {/* Delete — appears on hover */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setTableToDelete(table.name)
                              setShowDeleteModal(true)
                            }}
                            className="absolute right-2 opacity-0 group-hover:opacity-100 p-1 hover:bg-rose-500/15 rounded-md transition-all"
                            title="Delete table"
                          >
                            <Trash2 className="w-3 h-3 text-rose-300/70" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Main Panel - Table Data / Visualization */}
          <div className={showVisualization === 'visualization' ? 'flex-1 w-full' : 'flex-1 min-w-0'}>
            <div className="rounded-xl border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] overflow-hidden">
              {showVisualization === 'visualization' && activeDb === 'postgresql' && selectedSchema ? (
                <>
                  {/* Visualization Header */}
                  <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <h2 className="text-[12.5px] font-semibold text-zinc-100">Schema graph</h2>
                      <span className="truncate font-mono text-[11px] text-zinc-500">{selectedSchema}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setIsVisualizationExpanded(true)}
                        className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
                        title="Fullscreen mode"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={handleRefresh}
                        className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
                        title="Refresh"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-hidden" style={{ height: 'calc(100vh - 250px)' }}>
                    <EnhancedSchemaVisualizer
                      schema={selectedSchema}
                      databaseType={activeDb}
                      projectId={resolvedProjectId || undefined}
                      view={databaseView}
                    />
                  </div>
                </>
              ) : selectedTable && selectedSchema ? (
                <>
                  {/* Table Toolbar */}
                  <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <h2 className="truncate font-mono text-[13px] font-medium text-zinc-100">{selectedTable}</h2>
                      <span className="whitespace-nowrap font-mono text-[11px] text-zinc-500 tabular-nums">
                        {totalRows.toLocaleString()} row{totalRows === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* View Mode Toggle */}
                      <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
                        <button
                          onClick={() => setViewMode('data')}
                          className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors focus:outline-none ${
                            viewMode === 'data'
                              ? 'bg-white/[0.06] text-zinc-100'
                              : 'text-zinc-500 hover:text-zinc-300'
                          }`}
                        >
                          Data
                        </button>
                        <button
                          onClick={() => setViewMode('structure')}
                          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors focus:outline-none ${
                            viewMode === 'structure'
                              ? 'bg-white/[0.06] text-zinc-100'
                              : 'text-zinc-500 hover:text-zinc-300'
                          }`}
                        >
                          <Columns className="w-3 h-3" />
                          Structure
                        </button>
                      </div>

                      {viewMode === 'data' && (
                        <button
                          onClick={handleAddRow}
                          className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-white px-2.5 text-[11.5px] font-semibold text-black transition-colors hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-violet-400/50"
                        >
                          <Plus className="w-3 h-3" />
                          Insert row
                        </button>
                      )}

                      <button
                        onClick={handleRefresh}
                        className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
                        title="Refresh"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                      </button>
                    </div>
                  </div>

                  {/* Filter bar — above the grid, always visible */}
                  {viewMode === 'data' && (
                    <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.05]">
                      <div className="relative flex-1 max-w-xs">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
                        <input
                          type="text"
                          placeholder="Search rows…"
                          value={searchTerm}
                          onChange={e => setSearchTerm(e.target.value)}
                          className="w-full h-7 pl-7 pr-3 bg-[#0f1015] border border-white/[0.07] rounded-lg text-[11.5px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 transition-colors"
                        />
                      </div>
                      {sortColumn && (
                        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-white/[0.07] bg-white/[0.02]">
                          <ArrowUpDown className="w-3 h-3 text-zinc-500" />
                          <span className="font-mono text-[10.5px] text-zinc-300">{sortColumn}</span>
                          <span className="font-mono text-[10px] text-zinc-600">{sortDirection}</span>
                          <button onClick={() => setSortColumn(null)} className="text-zinc-600 hover:text-zinc-300 ml-0.5">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                      {filterColumn && (
                        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-white/[0.07] bg-white/[0.02]">
                          <Filter className="w-3 h-3 text-zinc-500" />
                          <span className="font-mono text-[10.5px] text-zinc-300">{filterColumn}</span>
                          <button onClick={() => { setFilterColumn(null); setFilterValue('') }} className="text-zinc-600 hover:text-zinc-300 ml-0.5">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Table Content */}
                  {viewMode === 'data' ? (
                    <>
                    <div className="overflow-auto" style={{ maxHeight: 'calc(100vh - 410px)' }}>
                      {loading ? (
                        <div className="p-8 text-center">
                          <Loader2 className="w-4 h-4 text-zinc-500 animate-spin mx-auto mb-2" />
                          <p className="text-[12px] text-zinc-500">Loading data…</p>
                        </div>
                      ) : rows.length === 0 && committedSearch ? (
                        <div className="flex flex-col items-center justify-center px-8" style={{ minHeight: 'calc(100vh - 410px)' }}>
                          <Search className="w-4 h-4 text-zinc-600 mb-3" />
                          <p className="text-[13px] font-semibold text-zinc-200 mb-1">No matching rows</p>
                          <p className="text-[12px] text-zinc-500 text-center max-w-xs mb-5 leading-relaxed">
                            Nothing in <span className="font-mono text-zinc-300">{selectedTable}</span> matches “{committedSearch}”.
                          </p>
                          <button
                            onClick={() => setSearchTerm('')}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[12px] font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.08]"
                          >
                            <X className="w-3.5 h-3.5" />
                            Clear search
                          </button>
                        </div>
                      ) : rows.length === 0 ? (
                        <div className="flex flex-col items-center justify-center px-8" style={{ minHeight: 'calc(100vh - 410px)' }}>
                          <Table2 className="w-4 h-4 text-zinc-600 mb-3" />
                          <p className="text-[13px] font-semibold text-zinc-200 mb-1">Table is empty</p>
                          <p className="text-[12px] text-zinc-500 text-center max-w-xs mb-5 leading-relaxed">
                            No rows yet. Data lands here the moment your app or agent writes to it.
                          </p>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={handleAddRow}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[12px] font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.08]"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              Insert row
                            </button>
                            <button
                              onClick={() => router.push(`/app/projects/${resolvedProjectId}/connect`)}
                              className="inline-flex h-8 items-center rounded-lg bg-white px-3.5 text-[12px] font-semibold text-black transition-colors hover:bg-zinc-200"
                            >
                              Connect your agent
                            </button>
                          </div>
                        </div>
                      ) : (
                        <table className="w-full">
                          <thead className="sticky top-0 z-10">
                            <tr className="bg-[#16171d] border-b border-white/[0.06]">
                              {columns.map((col) => {
                                const isSorted = sortColumn === col.name
                                return (
                                  <th
                                    key={col.name}
                                    onClick={() => handleSort(col.name)}
                                    className="px-4 py-2.5 text-left cursor-pointer select-none hover:bg-white/[0.03] transition-colors group/th"
                                    title={isSorted ? (sortDirection === 'asc' ? 'Sorted ascending. Click for descending' : 'Sorted descending. Click to clear') : 'Click to sort'}
                                  >
                                    <div className="flex items-center gap-1.5">
                                      <span className={`text-[9.5px] font-semibold uppercase tracking-[0.1em] ${isSorted ? 'text-zinc-200' : 'text-zinc-500'}`}>{col.name}</span>
                                      {col.primary && (
                                        <span className="font-mono text-[9px] font-semibold uppercase text-amber-500/80">pk</span>
                                      )}
                                      {col.foreign && (
                                        <span className="font-mono text-[9px] font-semibold uppercase text-violet-300/80">fk</span>
                                      )}
                                      {isSorted ? (
                                        sortDirection === 'asc'
                                          ? <ArrowUp className="w-3 h-3 text-violet-300" />
                                          : <ArrowDown className="w-3 h-3 text-violet-300" />
                                      ) : (
                                        <ArrowUpDown className="w-3 h-3 text-zinc-700 opacity-0 group-hover/th:opacity-100 transition-opacity" />
                                      )}
                                    </div>
                                    <div className="font-mono text-[9.5px] text-zinc-700 mt-0.5">{col.type}</div>
                                  </th>
                                )
                              })}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/[0.04]">
                            {rows.map((row, idx) => (
                              <tr
                                key={idx}
                                className="hover:bg-white/[0.025] transition-colors cursor-pointer"
                                onClick={() => openRowEditor(row)}
                              >
                                {columns.map((col) => {
                                  const value = row[col.name]
                                  const displayValue = value === null || value === undefined
                                    ? 'NULL'
                                    : typeof value === 'object'
                                    ? JSON.stringify(value)
                                    : String(value)

                                  return (
                                    <td key={col.name} className="px-4 py-[9px]">
                                      <span className={`font-mono text-[12px] ${
                                        value === null || value === undefined
                                          ? 'text-zinc-700 italic'
                                          : getDataTypeColor(col.type)
                                      }`}>
                                        {displayValue.length > 60
                                          ? `${displayValue.substring(0, 60)}…`
                                          : displayValue}
                                      </span>
                                    </td>
                                  )
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>

                    {/* Pagination footer — only when there is at least one row */}
                    {totalRows > 0 && (
                      <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-2.5">
                        <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
                          {`${((currentPage - 1) * PAGE_SIZE) + 1}–${Math.min(currentPage * PAGE_SIZE, totalRows)} of ${totalRows.toLocaleString()}`}
                          {committedSearch && <span className="ml-1.5 text-zinc-600">· filtered by “{committedSearch}”</span>}
                        </span>
                        {totalPages > 1 && (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => goToPage(currentPage - 1)}
                              disabled={currentPage <= 1 || loading}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.02] pl-1.5 pr-2.5 text-[11.5px] text-zinc-300 hover:bg-white/[0.05] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              <ChevronLeft className="w-3.5 h-3.5" />
                              Prev
                            </button>
                            <span className="px-2 font-mono text-[11px] text-zinc-500 tabular-nums">
                              {currentPage} / {Math.max(1, totalPages)}
                            </span>
                            <button
                              onClick={() => goToPage(currentPage + 1)}
                              disabled={currentPage >= totalPages || loading}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.02] pl-2.5 pr-1.5 text-[11.5px] text-zinc-300 hover:bg-white/[0.05] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              Next
                              <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    </>
                  ) : (
                    <div className="p-6 overflow-auto" style={{ maxHeight: 'calc(100vh - 380px)' }}>
                      {/* Column Structure */}
                      <div className="mb-6">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="flex items-baseline gap-2">
                            <span className="text-[12.5px] font-semibold text-zinc-100">Columns</span>
                            <span className="font-mono text-[11px] text-zinc-500 tabular-nums">{columns.length}</span>
                          </h3>
                          <button
                            onClick={() => setShowAddColumnModal(true)}
                            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[11.5px] font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.08]"
                          >
                            <Plus className="w-3 h-3" />
                            Add column
                          </button>
                        </div>
                        <div className="border border-white/[0.07] rounded-lg overflow-hidden">
                          <table className="w-full">
                            <thead>
                              <tr className="border-b border-white/[0.06]">
                                <th className="px-4 py-2 text-left text-[9.5px] font-semibold text-zinc-600 uppercase tracking-[0.1em]">Column</th>
                                <th className="px-4 py-2 text-left text-[9.5px] font-semibold text-zinc-600 uppercase tracking-[0.1em]">Type</th>
                                <th className="px-4 py-2 text-left text-[9.5px] font-semibold text-zinc-600 uppercase tracking-[0.1em]">Nullable</th>
                                <th className="px-4 py-2 text-left text-[9.5px] font-semibold text-zinc-600 uppercase tracking-[0.1em]">Default</th>
                                <th className="px-4 py-2 text-left text-[9.5px] font-semibold text-zinc-600 uppercase tracking-[0.1em]">Constraints</th>
                                <th className="px-4 py-2 text-right text-[9.5px] font-semibold text-zinc-600 uppercase tracking-[0.1em] w-[88px]">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/[0.04]">
                              {columns.map((col, idx) => (
                                <tr key={col.name} className="group hover:bg-white/[0.025] transition-colors">
                                  <td className="px-4 py-2.5">
                                    <div className="flex items-center gap-2">
                                      {col.primary ? (
                                        <Key className="w-3 h-3 text-amber-500/70 flex-shrink-0" />
                                      ) : (
                                        <span className="w-3 h-3 flex-shrink-0" />
                                      )}
                                      {renamingColumn === col.name ? (
                                        <div className="flex items-center gap-1.5">
                                          <input
                                            autoFocus
                                            value={renameColumnNewName}
                                            onChange={(e) => setRenameColumnNewName(e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') handleRenameColumn()
                                              if (e.key === 'Escape') { setRenamingColumn(null); setRenameColumnNewName('') }
                                            }}
                                            disabled={savingRename}
                                            className="h-7 px-2 bg-[#0f1015] border border-violet-400/30 focus:border-violet-400/60 rounded-md text-[12px] font-mono text-zinc-50 outline-none w-40"
                                          />
                                          <button
                                            onClick={handleRenameColumn}
                                            disabled={savingRename || !renameColumnNewName.trim()}
                                            className="p-1 text-violet-300 hover:text-violet-200 hover:bg-white/[0.06] rounded-md transition-colors disabled:opacity-30"
                                            title="Save rename"
                                          >
                                            {savingRename ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                                          </button>
                                          <button
                                            onClick={() => { setRenamingColumn(null); setRenameColumnNewName('') }}
                                            disabled={savingRename}
                                            className="p-1 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
                                            title="Cancel"
                                          >
                                            <X className="w-3.5 h-3.5" />
                                          </button>
                                        </div>
                                      ) : (
                                        <>
                                          <span className="font-mono text-[12px] text-zinc-200">{col.name}</span>
                                          {col.primary && (
                                            <span className="font-mono text-[9px] font-semibold uppercase text-amber-500/80">pk</span>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5">
                                    <span className={`font-mono text-[11.5px] ${getDataTypeColor(col.type)}`}>
                                      {col.type}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5">
                                    <span className={`font-mono text-[11px] ${col.nullable ? 'text-zinc-600' : 'text-zinc-400'}`}>
                                      {col.nullable ? 'nullable' : 'not null'}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5">
                                    <span className="font-mono text-[11px] text-zinc-600">
                                      {col.default || <span className="text-zinc-700">—</span>}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5">
                                    <div className="flex items-center gap-2 font-mono text-[10px] font-medium uppercase">
                                      {col.unique && <span className="text-zinc-400">unique</span>}
                                      {col.foreign && <span className="text-violet-300/80">fk</span>}
                                      {col.indexed && <span className="text-sky-300/80">indexed</span>}
                                      {!col.unique && !col.foreign && !col.indexed && (
                                        <span className="text-zinc-700 normal-case">—</span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5 text-right">
                                    {isReservedColumn(col.name) ? (
                                      <span className="font-mono text-[10px] text-zinc-700" title="Reserved system column. Cannot be renamed or dropped">system</span>
                                    ) : (
                                      <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button
                                          onClick={() => { setRenamingColumn(col.name); setRenameColumnNewName(col.name) }}
                                          disabled={renamingColumn !== null}
                                          className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                          title="Rename column"
                                        >
                                          <Edit2 className="w-3 h-3" />
                                        </button>
                                        <button
                                          onClick={() => { setColumnToDelete(col.name); setShowDeleteColumnModal(true) }}
                                          className="p-1.5 text-zinc-500 hover:text-rose-300 hover:bg-rose-500/10 rounded-md transition-colors"
                                          title="Drop column"
                                        >
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-24 px-8">
                  <DatabaseIcon className="w-4 h-4 text-zinc-600 mb-3" />
                  <p className="text-[13px] font-semibold text-zinc-200 mb-1">No tables yet</p>
                  <p className="text-[12px] text-zinc-500 text-center max-w-xs leading-relaxed">
                    Describe what you want to build in chat and Backenly creates your tables automatically.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Fullscreen Visualization Modal */}
      <AnimatePresence>
        {isVisualizationExpanded && selectedSchema && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/95"
            onClick={() => setIsVisualizationExpanded(false)}
          >
            <div className="absolute inset-0 flex flex-col" onClick={(e) => e.stopPropagation()}>
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] bg-[#16171d]">
                <div className="flex items-baseline gap-2">
                  <Network className="w-3.5 h-3.5 text-zinc-500 self-center" />
                  <h2 className="text-[12.5px] font-semibold text-zinc-100">Schema graph</h2>
                  <p className="font-mono text-[11px] text-zinc-500">{selectedSchema}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setIsVisualizationExpanded(false)}
                    className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
                    title="Exit fullscreen"
                  >
                    <Minimize2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setIsVisualizationExpanded(false)}
                    className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
                    title="Close"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              
              {/* Fullscreen Visualization */}
              <div className="flex-1 overflow-hidden">
                <EnhancedSchemaVisualizer
                  schema={selectedSchema}
                  databaseType={activeDb}
                  projectId={resolvedProjectId || undefined}
                  view={databaseView}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Insert Row Modal */}
      <AnimatePresence>
        {showAddRowModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
            onClick={() => setShowAddRowModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.15 }}
              className="bg-[#16171d] border border-white/[0.12] rounded-xl shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] w-full max-w-lg max-h-[80vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-[13px] font-semibold text-zinc-50">Insert row</h2>
                  <p className="font-mono text-[11px] text-zinc-500">{selectedTable}</p>
                </div>
                <button
                  onClick={() => setShowAddRowModal(false)}
                  className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Fields */}
              <div className="overflow-y-auto flex-1 p-5 space-y-3">
                {columns
                  .filter((col) => {
                    const isAutoSerial = col.type.toLowerCase().includes('serial')
                    const isAutoTimestamp =
                      (col.name.toLowerCase() === 'createdat' || col.name.toLowerCase() === 'updatedat') &&
                      (col.default?.includes('now()') || col.default?.includes('CURRENT_TIMESTAMP'))
                    return !isAutoSerial && !isAutoTimestamp
                  })
                  .map((col) => (
                    <div key={col.name}>
                      <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">
                        <span className="font-mono text-zinc-300">{col.name}</span>
                        <span className="ml-2 font-mono text-[10px] text-zinc-600">{col.type}</span>
                        {!col.nullable && !col.default && (
                          <span className="ml-1 text-rose-300/70">*</span>
                        )}
                      </label>
                      {col.type.toLowerCase().includes('bool') ? (
                        <select
                          value={newRowData[col.name] ?? ''}
                          onChange={(e) => setNewRowData((prev) => ({ ...prev, [col.name]: e.target.value }))}
                          className="w-full h-8 px-3 bg-[#0f1015] border border-white/[0.07] rounded-lg text-zinc-200 text-[12px] focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 transition-colors"
                        >
                          <option value="">-- select --</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          type={
                            col.type.toLowerCase().includes('int') || col.type.toLowerCase().includes('float') || col.type.toLowerCase().includes('numeric')
                              ? 'number'
                              : col.type.toLowerCase().includes('date') || col.type.toLowerCase().includes('timestamp')
                              ? 'datetime-local'
                              : 'text'
                          }
                          placeholder={col.default ? `default: ${col.default}` : col.nullable ? 'null' : ''}
                          value={newRowData[col.name] ?? ''}
                          onChange={(e) => setNewRowData((prev) => ({ ...prev, [col.name]: e.target.value }))}
                          className="w-full h-8 px-3 bg-[#0f1015] border border-white/[0.07] rounded-lg text-zinc-200 text-[12px] placeholder:text-zinc-600 focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 transition-colors"
                        />
                      )}
                    </div>
                  ))}
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-white/[0.06]">
                {error && (
                  <p className="mb-3 text-[11.5px] leading-5 text-rose-300">
                    {error}
                  </p>
                )}
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => setShowAddRowModal(false)}
                    className="h-8 px-3 text-[12px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveNewRow}
                    disabled={loading}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[12px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    Insert
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Row Editor Modal — view / edit / delete a single row */}
      <AnimatePresence>
        {editingRow && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
            onClick={() => !savingRow && !deletingRow && closeRowEditor()}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.15 }}
              className="bg-[#16171d] border border-white/[0.12] rounded-xl shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] w-full max-w-lg max-h-[82vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
                <div className="flex items-baseline gap-2 min-w-0">
                  <h2 className="text-[13px] font-semibold text-zinc-50">Edit row</h2>
                  <p className="font-mono text-[11px] text-zinc-500 truncate">
                    {selectedTable}
                    {rowPkValue(editingRow) !== undefined && rowPkValue(editingRow) !== null && (
                      <span className="text-zinc-600"> · id {String(rowPkValue(editingRow))}</span>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => !savingRow && !deletingRow && closeRowEditor()}
                  className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Fields */}
              <div className="overflow-y-auto flex-1 p-5 space-y-3">
                {columns.map((col) => {
                  const readOnly = col.primary || isReservedColumn(col.name)
                  const isBool = col.type.toLowerCase().includes('bool')
                  return (
                    <div key={col.name}>
                      <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">
                        <span className="font-mono text-zinc-300">{col.name}</span>
                        <span className="ml-2 font-mono text-[10px] text-zinc-600">{col.type}</span>
                        {readOnly && <span className="ml-2 font-mono text-[10px] text-zinc-600">read-only</span>}
                        {!col.nullable && !col.default && !readOnly && (
                          <span className="ml-1 text-rose-300/70">*</span>
                        )}
                      </label>
                      {readOnly ? (
                        <div className="w-full min-h-8 px-3 py-1.5 bg-white/[0.02] border border-white/[0.05] rounded-lg text-zinc-500 text-[12px] font-mono break-all">
                          {editRowData[col.name] === '' || editRowData[col.name] === undefined
                            ? <span className="text-zinc-700 italic">null</span>
                            : editRowData[col.name]}
                        </div>
                      ) : isBool ? (
                        <select
                          value={editRowData[col.name] ?? ''}
                          onChange={(e) => setEditRowData((prev) => ({ ...prev, [col.name]: e.target.value }))}
                          className="w-full h-8 px-3 bg-[#0f1015] border border-white/[0.07] rounded-lg text-zinc-200 text-[12px] focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 transition-colors"
                        >
                          <option value="">-- null --</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          type={
                            col.type.toLowerCase().includes('int') || col.type.toLowerCase().includes('float') || col.type.toLowerCase().includes('numeric')
                              ? 'number'
                              : 'text'
                          }
                          placeholder={col.nullable ? 'null' : ''}
                          value={editRowData[col.name] ?? ''}
                          onChange={(e) => setEditRowData((prev) => ({ ...prev, [col.name]: e.target.value }))}
                          className="w-full h-8 px-3 bg-[#0f1015] border border-white/[0.07] rounded-lg text-zinc-200 text-[12px] font-mono placeholder:text-zinc-600 focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 transition-colors"
                        />
                      )}
                    </div>
                  )
                })}

                {error && (
                  <div className="px-3 py-2 bg-rose-500/[0.06] border border-rose-500/15 rounded-lg text-[11px] text-rose-300/90">{error}</div>
                )}
              </div>

              {/* Footer — Delete on the left, Cancel / Save on the right */}
              <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-white/[0.06]">
                <button
                  onClick={deleteEditingRow}
                  disabled={savingRow || deletingRow}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.08] px-3 text-[12px] font-semibold text-rose-300 transition-colors hover:bg-rose-500/[0.16] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deletingRow ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Delete
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={closeRowEditor}
                    disabled={savingRow || deletingRow}
                    className="h-8 px-3 text-[12px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] rounded-lg transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveRowEdit}
                    disabled={savingRow || deletingRow}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[12px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {savingRow ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    Save changes
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Add Column Modal — funnels through canonical tableLifecycle */}
      <AnimatePresence>
        {showAddColumnModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
            onClick={() => !addingColumn && setShowAddColumnModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.15 }}
              className="bg-[#16171d] border border-white/[0.12] rounded-xl shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-[13px] font-semibold text-zinc-50">Add column</h2>
                  <p className="font-mono text-[11px] text-zinc-500">{selectedTable}</p>
                </div>
                <button
                  onClick={() => !addingColumn && setShowAddColumnModal(false)}
                  className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-[10px] font-semibold text-zinc-600 uppercase tracking-[0.12em] mb-1.5">Name</label>
                  <input
                    autoFocus
                    value={newColumnName}
                    onChange={(e) => setNewColumnName(e.target.value)}
                    placeholder="e.g. email, price, is_active"
                    disabled={addingColumn}
                    className="w-full h-8 px-3 bg-[#0f1015] border border-white/[0.07] rounded-lg text-zinc-50 text-[12.5px] font-mono placeholder:text-zinc-600 focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 transition-colors"
                  />
                  <p className="text-[10.5px] text-zinc-600 mt-1.5">Letters, numbers, underscores. Must start with a letter or underscore.</p>
                </div>

                <div>
                  <label className="block text-[10px] font-semibold text-zinc-600 uppercase tracking-[0.12em] mb-1.5">Type</label>
                  <select
                    value={newColumnType}
                    onChange={(e) => setNewColumnType(e.target.value)}
                    disabled={addingColumn}
                    className="w-full h-8 px-3 bg-[#0f1015] border border-white/[0.07] rounded-lg text-zinc-200 text-[12.5px] focus:outline-none focus:border-violet-400/40 transition-colors"
                  >
                    <option value="text">text (string)</option>
                    <option value="int">int (whole number)</option>
                    <option value="bigint">bigint (large number)</option>
                    <option value="numeric">numeric (decimal)</option>
                    <option value="boolean">boolean (true/false)</option>
                    <option value="timestamp">timestamp (date + time)</option>
                    <option value="uuid">uuid (unique identifier)</option>
                    <option value="jsonb">jsonb (structured JSON)</option>
                  </select>
                </div>

                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newColumnNullable}
                    onChange={(e) => setNewColumnNullable(e.target.checked)}
                    disabled={addingColumn}
                    className="w-4 h-4 rounded border-white/20 bg-white/[0.04] text-violet-500 focus:ring-violet-400/30"
                  />
                  <span className="text-[12px] text-zinc-300">Allow empty values (nullable)</span>
                </label>

                {error && (
                  <div className="px-3 py-2 bg-rose-500/[0.06] border border-rose-500/15 rounded-lg text-[11px] text-rose-300/90">{error}</div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/[0.06]">
                <button
                  onClick={() => setShowAddColumnModal(false)}
                  disabled={addingColumn}
                  className="h-8 px-3 text-[12px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddColumn}
                  disabled={addingColumn || !newColumnName.trim()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[12px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {addingColumn ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Add column
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Drop Column Confirmation Modal */}
      <AnimatePresence>
        {showDeleteColumnModal && columnToDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
            onClick={() => !droppingColumn && setShowDeleteColumnModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.15 }}
              className="bg-[#16171d] border border-rose-500/25 rounded-xl shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 py-4 border-b border-white/[0.06]">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-4 h-4 text-rose-300 flex-shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-[13px] font-semibold text-zinc-50">Drop column?</h2>
                    <p className="text-[12px] text-zinc-400 mt-1 leading-5">
                      Permanently delete <span className="font-mono text-rose-300">{columnToDelete}</span> and all of its data from <span className="font-mono text-zinc-200">{selectedTable}</span>. The REST API will be regenerated so the column disappears from CRUD payloads.
                    </p>
                  </div>
                </div>
              </div>
              {error && (
                <div className="mx-5 mt-4 px-3 py-2 bg-rose-500/[0.06] border border-rose-500/15 rounded-lg text-[11px] text-rose-300/90">{error}</div>
              )}
              <div className="flex items-center justify-end gap-2 px-5 py-4">
                <button
                  onClick={() => setShowDeleteColumnModal(false)}
                  disabled={droppingColumn}
                  className="h-8 px-3 text-[12px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDropColumn}
                  disabled={droppingColumn}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.10] px-3.5 text-[12px] font-semibold text-rose-300 transition-colors hover:bg-rose-500/[0.18] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {droppingColumn ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Drop column
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Create Table Modal — funnels through /api/database/create-table (executeAction) */}
      <AnimatePresence>
        {showCreateTableModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
            onClick={() => !creatingTable && setShowCreateTableModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.15 }}
              className="bg-[#16171d] border border-white/[0.12] rounded-xl shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
                <h2 className="text-[13px] font-semibold text-zinc-50">New table</h2>
                <button
                  onClick={() => !creatingTable && setShowCreateTableModal(false)}
                  className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-[10px] font-semibold text-zinc-600 uppercase tracking-[0.12em] mb-1.5">Name</label>
                  <input
                    autoFocus
                    value={newTableName}
                    onChange={(e) => setNewTableName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCreateTable() }}
                    placeholder="e.g. posts, orders, comments"
                    disabled={creatingTable}
                    className="w-full h-8 px-3 bg-[#0f1015] border border-white/[0.07] rounded-lg text-zinc-50 text-[12.5px] font-mono placeholder:text-zinc-600 focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 transition-colors"
                  />
                  <p className="text-[10.5px] text-zinc-600 mt-1.5">Backenly adds id, createdAt and updatedAt automatically, plus REST endpoints with auth and rate limits.</p>
                </div>

                <div>
                  <label className="block text-[10px] font-semibold text-zinc-600 uppercase tracking-[0.12em] mb-1.5">Description <span className="normal-case tracking-normal text-zinc-700">(optional)</span></label>
                  <input
                    value={newTableDescription}
                    onChange={(e) => setNewTableDescription(e.target.value)}
                    placeholder="What this table stores"
                    disabled={creatingTable}
                    className="w-full h-8 px-3 bg-[#0f1015] border border-white/[0.07] rounded-lg text-zinc-200 text-[12.5px] placeholder:text-zinc-600 focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 transition-colors"
                  />
                </div>

                {error && (
                  <div className="px-3 py-2 bg-rose-500/[0.06] border border-rose-500/15 rounded-lg text-[11px] text-rose-300/90">{error}</div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/[0.06]">
                <button
                  onClick={() => setShowCreateTableModal(false)}
                  disabled={creatingTable}
                  className="h-8 px-3 text-[12px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateTable}
                  disabled={creatingTable || !newTableName.trim()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[12px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creatingTable ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Create table
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Table Confirmation Modal */}
      <AnimatePresence>
        {showDeleteModal && tableToDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
            onClick={() => !deletingTable && setShowDeleteModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.15 }}
              className="bg-[#16171d] border border-rose-500/25 rounded-xl shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 py-4 border-b border-white/[0.06]">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-4 h-4 text-rose-300 flex-shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-[13px] font-semibold text-zinc-50">Delete table?</h2>
                    <p className="text-[12px] text-zinc-400 mt-1 leading-5">
                      Permanently delete <span className="font-mono text-rose-300">{tableToDelete}</span>, all of its rows, and its generated REST endpoints. This cannot be undone.
                    </p>
                  </div>
                </div>
              </div>
              {error && (
                <div className="mx-5 mt-4 px-3 py-2 bg-rose-500/[0.06] border border-rose-500/15 rounded-lg text-[11px] text-rose-300/90">{error}</div>
              )}
              <div className="flex items-center justify-end gap-2 px-5 py-4">
                <button
                  onClick={() => setShowDeleteModal(false)}
                  disabled={deletingTable}
                  className="h-8 px-3 text-[12px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteTable}
                  disabled={deletingTable}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.10] px-3.5 text-[12px] font-semibold text-rose-300 transition-colors hover:bg-rose-500/[0.18] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deletingTable ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Delete table
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

        </div>
      </div>
  )
}
