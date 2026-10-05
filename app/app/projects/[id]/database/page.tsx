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

import { useState, useEffect, useRef } from 'react'
import {
  AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, Cable, Camera, Check, ChevronLeft, ChevronRight, Columns,
  Database as DatabaseIcon, Edit2, Filter, History, Key, Link2, Loader2, Maximize2, Minimize2, Network,
  Plus, Puzzle, RefreshCw, Rows, Save, Search, Shapes, Split, Table2, Terminal, Trash2, X,
  type LucideIcon,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AgentPrompt,
  CommandBar,
  EmptyState,
  IconButton,
  INPUT_BASE,
  KIT,
  KitButton,
  KitConfirmDialog,
  KitField,
  KitInput,
  KitModal,
  KitNote,
  KitTab,
  KitTabs,
  Segmented,
  Skeleton,
  Spinner,
  Tag,
} from '@/components/inspector/kit'
import { EDGE, FOCUS, FOCUS_INSET, RULE, R_CONTROL, R_PANEL, R_TAG } from '@/components/console/tokens'
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
  addConstraint,
  renameColumn,
  dropColumn,
  validateProjectAccess,
  type TableInfo,
  type ColumnInfo,
  type IndexInfo,
  type DatabaseType,
} from '@/lib/api/database'
import { isForeignKeyShaped, suggestForeignKeyColumn } from '@/lib/db/fk-shape'
import { SqlWorkspace } from '@/components/database/SqlWorkspace'
import { SchemaHistory } from '@/components/database/SchemaHistory'
import { EnumsPanel } from '@/components/database/EnumsPanel'
import { ExtensionsPanel } from '@/components/database/ExtensionsPanel'
import { StructuralEvolutionPanel } from '@/components/database/StructuralEvolutionPanel'
import { DatabaseSnapshots } from '@/components/database/DatabaseSnapshots'
import { useParams, useRouter } from 'next/navigation'
import { getCurrentProjectId } from '@/lib/api/client'
import EnhancedSchemaVisualizer from '@/components/database/EnhancedSchemaVisualizer'


type ViewMode = 'data' | 'structure'
type TableView = 'data' | 'structure'
type DatabaseView = 'tables' | 'visualization' | 'sql' | 'history' | 'snapshots' | 'types' | 'extensions' | 'evolution'

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

  // Filters the sidebar table list only. Purely client-side — the full list is
  // already loaded, so this never refetches.
  const [tableFilter, setTableFilter] = useState('')

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
  // Constraints requested alongside a new column. Applied AFTER the column
  // exists, because every one of them is an ALTER on a column that has to be
  // there first. Each is a separate typed action through the same governed
  // path, not a hand-assembled DDL string.
  const [newColumnUnique, setNewColumnUnique] = useState(false)
  const [newColumnReferences, setNewColumnReferences] = useState('')
  const [newColumnCheck, setNewColumnCheck] = useState('')
  // Reports which constraints applied and which did not. The column can succeed
  // while a constraint fails — an FK against a table with incompatible rows,
  // for instance — and saying "added" would be a lie in exactly the case the
  // operator most needs to know about.
  const [constraintOutcome, setConstraintOutcome] = useState<string[] | null>(null)

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
  const resetAddColumnForm = () => {
    setNewColumnName('')
    setNewColumnType('text')
    setNewColumnNullable(true)
    setNewColumnUnique(false)
    setNewColumnReferences('')
    setNewColumnCheck('')
  }

  const handleAddColumn = async () => {
    if (!selectedTable || !resolvedProjectId || !newColumnName.trim()) return
    const columnName = newColumnName.trim()
    try {
      setAddingColumn(true)
      setError(null)
      setConstraintOutcome(null)

      await addColumn(resolvedProjectId, selectedTable, {
        name: columnName,
        type: newColumnType,
        nullable: newColumnNullable,
      })

      // The column now exists. Each constraint is applied separately, and one
      // failing does not undo the column or stop the others: an FK can fail on
      // rows that do not match while a UNIQUE on the same new column succeeds.
      // Reporting each outcome is the point — a single "added" over a partial
      // result is how a schema silently ends up weaker than the operator
      // believes it is.
      const requested: Array<{ label: string; run: () => Promise<void> }> = []
      if (newColumnUnique) {
        requested.push({
          label: 'unique',
          run: () => addConstraint(resolvedProjectId, selectedTable, columnName, 'unique'),
        })
      }
      if (newColumnReferences) {
        requested.push({
          label: `foreign key to ${newColumnReferences}`,
          run: () =>
            // The table is passed as referencedTable, NOT as the expression.
            // The executor infers a target when none is given, and an inferred
            // target is not necessarily the one just chosen here.
            addConstraint(
              resolvedProjectId,
              selectedTable,
              columnName,
              'foreign_key',
              undefined,
              newColumnReferences,
            ),
        })
      }
      if (newColumnCheck.trim()) {
        requested.push({
          label: 'check',
          run: () =>
            addConstraint(resolvedProjectId, selectedTable, columnName, 'check', newColumnCheck.trim()),
        })
      }

      const failures: string[] = []
      for (const c of requested) {
        try {
          await c.run()
        } catch (err: any) {
          failures.push(`${c.label}: ${err?.message || 'failed'}`)
        }
      }

      if (failures.length > 0) {
        // Deliberately NOT thrown. The column was created, so treating this as
        // a failed operation would leave the operator thinking nothing
        // happened and adding it a second time.
        setConstraintOutcome([
          `Column "${columnName}" was added, but ${failures.length} of ${requested.length} constraints did not apply.`,
          ...failures,
        ])
        await loadTableData()
        return
      }

      setShowAddColumnModal(false)
      resetAddColumnForm()
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

  // The grid reads best with the key first, the table's own columns next and
  // the managed timestamps last; otherwise createdAt, updatedAt and an
  // all-NULL deleted_at fill the first screen and push the data off it.
  // Structure keeps the real ordinal order.
  const gridColumns = [
    ...columns.filter((c) => c.primary),
    ...columns.filter((c) => !c.primary && !isReservedColumn(c.name)),
    ...columns.filter((c) => !c.primary && isReservedColumn(c.name)),
  ]

  const visibleTables = tableFilter.trim()
    ? tables.filter((t) => t.name.toLowerCase().includes(tableFilter.trim().toLowerCase()))
    : tables

  // Columns a person fills in when inserting: auto-serials and auto-stamped
  // timestamps are the database's job.
  const insertableColumns = columns.filter((col) => {
    const isAutoSerial = col.type.toLowerCase().includes('serial')
    const isAutoTimestamp =
      (col.name.toLowerCase() === 'createdat' || col.name.toLowerCase() === 'updatedat') &&
      (col.default?.includes('now()') || col.default?.includes('CURRENT_TIMESTAMP'))
    return !isAutoSerial && !isAutoTimestamp
  })

  const closeAddColumn = () => {
    if (addingColumn) return
    setShowAddColumnModal(false)
    resetAddColumnForm()
    setConstraintOutcome(null)
    setError(null)
  }

  const openCreateTable = () => {
    setError(null)
    setShowCreateTableModal(true)
  }

  const fkBlocked = !!newColumnReferences && !isForeignKeyShaped(newColumnName)

  return (
    <div className={`console-fill flex flex-col overflow-hidden ${KIT.bg}`}>
      {/* ── Command bar ─────────────────────────────────────────
          A data grid needs vertical room far more than it needs a hero
          header, so the page's identity is one 52px row. */}
      <CommandBar
        title="Database"
        context={
          tables.length > 0 ? (
            <span className="tabular-nums">
              {tables.length} {tables.length === 1 ? 'table' : 'tables'}
            </span>
          ) : undefined
        }
      >
        <KitButton
          variant="primary"
          size="sm"
          icon={Plus}
          onClick={openCreateTable}
          disabled={!selectedSchema}
          title={selectedSchema ? 'Create a table in this project' : 'Waiting for the workspace schema'}
        >
          New table
        </KitButton>
      </CommandBar>

      {/* ── Views ───────────────────────────────────────────────
          Tables and Schema read the workspace schema; SQL, History, Types,
          Extensions and Snapshots are project-wide and need no table. */}
      {selectedSchema && (
        <KitTabs className="flex-shrink-0 px-3 sm:px-4">
          {DATABASE_VIEWS.map((view) => {
            const Icon = view.icon
            return (
              <KitTab key={view.id} active={showVisualization === view.id} onClick={() => setShowVisualization(view.id)}>
                <Icon strokeWidth={1.75} />
                {view.label}
              </KitTab>
            )
          })}
        </KitTabs>
      )}

      {/* ── Workbench ─────────────────────────────────────────
          The inner layer is absolutely positioned so a wide grid sizes
          itself against this box instead of pushing the app shell's flex
          chain wider than the viewport. */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">
          {/* Table rail: the Tables view only. On a phone it is the first
              screen, and picking a table drills into it. */}
          {showVisualization === 'tables' && (
            <div
              className={`w-full flex-shrink-0 flex-col border-r ${RULE} md:w-[248px] ${KIT.rail} ${
                selectedTable ? 'hidden md:flex' : 'flex'
              }`}
            >
              <div className={`flex h-[44px] flex-shrink-0 items-center justify-between gap-2 border-b ${RULE} pl-4 pr-2`}>
                <span className="text-[13px] font-medium text-zinc-200">Tables</span>
                <div className="flex flex-shrink-0 items-center gap-0.5">
                  <IconButton
                    icon={RefreshCw}
                    label="Refresh tables"
                    onClick={handleRefresh}
                    className={loading ? '[&_svg]:animate-spin' : ''}
                  />
                  <IconButton icon={Plus} label="New table" onClick={openCreateTable} disabled={!selectedSchema} />
                </div>
              </div>

              {tables.length > 0 && (
                <div className={`flex-shrink-0 border-b ${RULE} p-2`}>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                    <input
                      type="search"
                      aria-label="Search tables"
                      placeholder="Search tables…"
                      value={tableFilter}
                      onChange={(e) => setTableFilter(e.target.value)}
                      className={`${INPUT_BASE} h-[30px] pl-8 pr-2.5`}
                    />
                  </div>
                </div>
              )}

              {error && !showAddRowModal && !editingRow && !showAddColumnModal && !showCreateTableModal && !showDeleteModal && !showDeleteColumnModal && (
                <div className="flex-shrink-0 p-2">
                  <KitNote tone="danger" icon={AlertCircle}>
                    {error}
                  </KitNote>
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
                {loading && tables.length === 0 ? (
                  <div className="space-y-1.5 px-3 py-2" aria-hidden>
                    {[0, 1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-[24px] w-full" />
                    ))}
                  </div>
                ) : tables.length === 0 ? (
                  <div className="px-4 py-5">
                    <p className="text-[13px] font-medium text-zinc-200">No tables yet</p>
                    <p className="mt-1 text-[12.5px] leading-[19px] text-zinc-500">
                      Your coding agent creates tables as it builds. You can also add one by hand.
                    </p>
                    <KitButton size="sm" icon={Plus} onClick={openCreateTable} disabled={!selectedSchema} className="mt-3">
                      New table
                    </KitButton>
                  </div>
                ) : visibleTables.length === 0 ? (
                  <p className="px-4 py-6 text-center text-[12.5px] leading-relaxed text-zinc-600">
                    No table matches “{tableFilter}”.
                  </p>
                ) : (
                  <ul className="space-y-px px-2">
                    {visibleTables.map((table) => {
                      const active = selectedTable === table.name
                      return (
                        <li key={table.name}>
                          <div
                            role="button"
                            tabIndex={0}
                            aria-current={active ? 'true' : undefined}
                            onClick={() => setSelectedTable(table.name)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                setSelectedTable(table.name)
                              }
                            }}
                            className={`group relative flex h-[32px] cursor-pointer items-center gap-2.5 rounded-[7px] px-2.5 transition-colors ${FOCUS_INSET} ${
                              active ? 'bg-white/[0.07] text-zinc-50' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
                            }`}
                          >
                            <Table2
                              className={`h-3.5 w-3.5 flex-shrink-0 ${active ? 'text-zinc-300' : 'text-zinc-600'}`}
                              strokeWidth={1.75}
                            />
                            <span className="flex-1 truncate font-mono text-[12.5px]">{table.name}</span>
                            <span
                              className={`flex-shrink-0 text-[12px] tabular-nums group-hover:opacity-0 group-focus-within:opacity-0 ${
                                active ? 'text-zinc-400' : 'text-zinc-600'
                              }`}
                              title={`${(table.rows ?? 0).toLocaleString()} rows`}
                            >
                              {(table.rows ?? 0).toLocaleString()}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setError(null)
                                setTableToDelete(table.name)
                                setShowDeleteModal(true)
                              }}
                              aria-label={`Delete table ${table.name}`}
                              title="Delete table"
                              className={`absolute right-1.5 flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-zinc-500 opacity-0 transition-opacity hover:bg-rose-500/[0.12] hover:text-rose-300 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${FOCUS_INSET}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              {tables.length > 0 && (
                <div className={`flex h-[32px] flex-shrink-0 items-center border-t ${RULE} px-4 text-[12px] tabular-nums text-zinc-500`}>
                  {tableFilter.trim()
                    ? `${visibleTables.length} of ${tables.length}`
                    : `${tables.length} table${tables.length === 1 ? '' : 's'}`}
                </div>
              )}
            </div>
          )}

          {/* ── Main pane ─────────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col">
            {showVisualization === 'history' && resolvedProjectId ? (
              <SchemaHistory projectId={resolvedProjectId} />
            ) : showVisualization === 'types' && resolvedProjectId ? (
              // Project-scoped: types live in the workspace schema and need no
              // selected table.
              <EnumsPanel projectId={resolvedProjectId} />
            ) : showVisualization === 'extensions' && resolvedProjectId ? (
              // Deployment-scoped, reached through a project: extensions are
              // database-wide, which the panel says.
              <ExtensionsPanel projectId={resolvedProjectId} />
            ) : showVisualization === 'evolution' && resolvedProjectId ? (
              // Project-scoped. Here and not on the Autonomy page because an
              // extraction creates a table, and only this section creates
              // backend reality.
              <StructuralEvolutionPanel projectId={resolvedProjectId} />
            ) : showVisualization === 'snapshots' && resolvedProjectId ? (
              // Project-scoped like the schema graph: it needs no selected
              // table, and a project whose tables have not loaded can still
              // be snapshotted.
              <DatabaseSnapshots projectId={resolvedProjectId} />
            ) : showVisualization === 'sql' && resolvedProjectId ? (
              // Project-scoped, like the schema graph: it needs no selected
              // table, and a deployment whose tables have not loaded yet can
              // still be queried.
              <SqlWorkspace projectId={resolvedProjectId} />
            ) : showVisualization === 'visualization' && activeDb === 'postgresql' && selectedSchema ? (
              <>
                <div className={`flex h-[44px] flex-shrink-0 items-center justify-between gap-3 border-b ${RULE} pl-4 pr-2 sm:pl-5`}>
                  <div className="flex min-w-0 items-baseline gap-2.5">
                    <h2 className="text-[13px] font-medium text-zinc-100">Schema graph</h2>
                    <span className="hidden truncate text-[12px] text-zinc-500 sm:inline">
                      Tables and the foreign keys between them
                    </span>
                  </div>
                  <div className="flex items-center gap-0.5">
                    <IconButton icon={Maximize2} label="Full screen" onClick={() => setIsVisualizationExpanded(true)} />
                    <IconButton
                      icon={RefreshCw}
                      label="Refresh"
                      onClick={handleRefresh}
                      className={loading ? '[&_svg]:animate-spin' : ''}
                    />
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
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
                {/* Table toolbar */}
                <div className={`flex h-[44px] flex-shrink-0 items-center justify-between gap-3 border-b ${RULE} pl-3 pr-2 sm:pl-5`}>
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedTable(null)}
                      className={`-ml-1 mr-0.5 inline-flex h-[28px] items-center gap-1 rounded-[6px] px-1.5 text-[12.5px] text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-100 md:hidden ${FOCUS}`}
                      aria-label="Back to tables"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      Tables
                    </button>
                    <h2 className="truncate font-mono text-[13px] font-medium text-zinc-100">{selectedTable}</h2>
                    <span className="hidden whitespace-nowrap text-[12px] tabular-nums text-zinc-500 sm:inline">
                      {totalRows.toLocaleString()} {totalRows === 1 ? 'row' : 'rows'}
                      {columns.length > 0 && (
                        <>
                          <span className="px-1.5 text-zinc-700">·</span>
                          {columns.length} {columns.length === 1 ? 'column' : 'columns'}
                        </>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <Segmented
                      size="sm"
                      label="Table view"
                      value={viewMode}
                      onChange={(v) => setViewMode(v)}
                      options={[
                        { value: 'data', label: 'Data', icon: Rows },
                        { value: 'structure', label: 'Structure', icon: Columns },
                      ]}
                    />
                    {viewMode === 'data' && (
                      <KitButton size="sm" icon={Plus} onClick={handleAddRow}>
                        <span className="hidden sm:inline">Insert row</span>
                        <span className="sm:hidden">Row</span>
                      </KitButton>
                    )}
                    <IconButton
                      icon={RefreshCw}
                      label="Refresh"
                      onClick={handleRefresh}
                      className={loading ? '[&_svg]:animate-spin' : ''}
                    />
                  </div>
                </div>

                {/* Filter bar: above the grid, always visible in Data */}
                {viewMode === 'data' && (
                  <div className={`flex min-h-[44px] flex-shrink-0 flex-wrap items-center gap-2 border-b ${RULE} px-3 py-1.5 sm:px-5`}>
                    <div className="relative w-full max-w-[280px] flex-1">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                      <input
                        type="search"
                        aria-label="Search rows"
                        placeholder="Search rows…"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className={`${INPUT_BASE} h-[30px] pl-8 pr-2.5`}
                      />
                    </div>
                    {sortColumn && (
                      <span className={`inline-flex h-[26px] items-center gap-1.5 ${R_TAG} border ${EDGE} bg-white/[0.03] pl-2 pr-1 text-[12px] text-zinc-400`}>
                        <ArrowUpDown className="h-3 w-3 text-zinc-500" />
                        Sorted by <span className="font-mono text-zinc-200">{sortColumn}</span>
                        <span className="text-zinc-500">{sortDirection === 'asc' ? 'ascending' : 'descending'}</span>
                        <button
                          type="button"
                          onClick={() => handleSort(sortColumn)}
                          aria-label="Clear sort"
                          className={`ml-0.5 flex h-[20px] w-[20px] items-center justify-center rounded-[4px] text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 ${FOCUS_INSET}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    )}
                    {filterColumn && (
                      <span className={`inline-flex h-[26px] items-center gap-1.5 ${R_TAG} border ${EDGE} bg-white/[0.03] pl-2 pr-1 text-[12px] text-zinc-400`}>
                        <Filter className="h-3 w-3 text-zinc-500" />
                        <span className="font-mono text-zinc-200">{filterColumn}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setFilterColumn(null)
                            setFilterValue('')
                          }}
                          aria-label="Clear filter"
                          className={`ml-0.5 flex h-[20px] w-[20px] items-center justify-center rounded-[4px] text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 ${FOCUS_INSET}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    )}
                  </div>
                )}

                {viewMode === 'data' ? (
                  <>
                    <div className="min-h-0 flex-1 overflow-auto">
                      {loading && rows.length === 0 ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2">
                          <Spinner className="h-4 w-4 text-zinc-500" />
                          <p className="text-[12.5px] text-zinc-500">Loading rows…</p>
                        </div>
                      ) : rows.length === 0 && committedSearch ? (
                        <EmptyState
                          icon={Search}
                          title="No matching rows"
                          description={`Nothing in ${selectedTable} matches “${committedSearch}”.`}
                          action={
                            <KitButton size="sm" icon={X} onClick={() => setSearchTerm('')}>
                              Clear search
                            </KitButton>
                          }
                          className="h-full"
                        />
                      ) : rows.length === 0 ? (
                        <EmptyState
                          icon={Table2}
                          title="No rows yet"
                          description="Rows appear here the moment your app, your agent or a function writes to this table."
                          action={
                            <>
                              <KitButton size="sm" icon={Plus} onClick={handleAddRow}>
                                Insert row
                              </KitButton>
                              <KitButton
                                size="sm"
                                variant="ghost"
                                icon={Cable}
                                onClick={() => router.push(`/app/projects/${resolvedProjectId}/connect`)}
                              >
                                Connect your agent
                              </KitButton>
                            </>
                          }
                          className="h-full"
                        />
                      ) : (
                        <table className={`w-max min-w-full border-separate border-spacing-0 transition-opacity ${loading ? 'opacity-60' : ''}`}>
                          <thead className="sticky top-0 z-20">
                            <tr>
                              {/* Row-number gutter: pinned left so the row you are
                                  reading stays identifiable when scrolled wide. */}
                              <th
                                scope="col"
                                className={`sticky left-0 z-30 w-[56px] border-b border-r ${RULE} ${KIT.gridHead} px-3 py-2 text-right text-[12px] font-normal text-zinc-600`}
                              >
                                <span className="sr-only">Row</span>#
                              </th>
                              {gridColumns.map((col) => {
                                const isSorted = sortColumn === col.name
                                const numeric = isNumericType(col.type)
                                return (
                                  <th
                                    key={col.name}
                                    scope="col"
                                    aria-sort={isSorted ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}
                                    className={`group/th min-w-[150px] max-w-[380px] border-b ${RULE} ${KIT.gridHead} p-0 text-left font-normal`}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => handleSort(col.name)}
                                      title={
                                        isSorted
                                          ? sortDirection === 'asc'
                                            ? 'Sorted ascending. Click for descending'
                                            : 'Sorted descending. Click to clear'
                                          : 'Sort by this column'
                                      }
                                      className={`flex w-full flex-col gap-0.5 px-4 py-2 transition-colors hover:bg-white/[0.03] ${FOCUS_INSET} ${
                                        numeric ? 'items-end text-right' : 'items-start text-left'
                                      }`}
                                    >
                                      <span className="flex items-center gap-1.5">
                                        {col.primary && (
                                          <Key className="h-3 w-3 text-amber-300/70" strokeWidth={2} aria-label="Primary key" />
                                        )}
                                        {col.foreign && (
                                          <Link2 className="h-3 w-3 text-violet-300/80" strokeWidth={2} aria-label="Foreign key" />
                                        )}
                                        <span className={`font-mono text-[12px] font-medium ${isSorted ? 'text-zinc-50' : 'text-zinc-300'}`}>
                                          {col.name}
                                        </span>
                                        {isSorted ? (
                                          sortDirection === 'asc' ? (
                                            <ArrowUp className="h-3 w-3 text-zinc-200" />
                                          ) : (
                                            <ArrowDown className="h-3 w-3 text-zinc-200" />
                                          )
                                        ) : (
                                          <ArrowUpDown className="h-3 w-3 text-zinc-600 opacity-0 transition-opacity group-hover/th:opacity-100" />
                                        )}
                                      </span>
                                      <span className="font-mono text-[11px] text-zinc-600">{col.type}</span>
                                    </button>
                                  </th>
                                )
                              })}
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((row, idx) => (
                              <tr
                                key={idx}
                                tabIndex={0}
                                onClick={() => openRowEditor(row)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') openRowEditor(row)
                                }}
                                aria-label={`Row ${(currentPage - 1) * PAGE_SIZE + idx + 1}. Open to edit`}
                                className={`group/row cursor-pointer transition-colors ${KIT.rowHoverOn} ${FOCUS_INSET}`}
                              >
                                <td
                                  className={`sticky left-0 z-10 border-b border-r border-white/[0.04] ${KIT.bg} px-3 py-[9px] text-right text-[12px] tabular-nums text-zinc-600 transition-colors ${KIT.rowHoverGroup} group-hover/row:text-zinc-400`}
                                >
                                  {(currentPage - 1) * PAGE_SIZE + idx + 1}
                                </td>
                                {gridColumns.map((col) => {
                                  const value = row[col.name]
                                  const isNull = value === null || value === undefined
                                  const displayValue = isNull
                                    ? 'NULL'
                                    : typeof value === 'object'
                                    ? JSON.stringify(value)
                                    : String(value)
                                  const numeric = isNumericType(col.type)
                                  return (
                                    <td
                                      key={col.name}
                                      className={`max-w-[380px] border-b border-white/[0.04] px-4 py-[9px] ${numeric ? 'text-right' : ''}`}
                                    >
                                      <span
                                        title={displayValue}
                                        className={`block truncate font-mono text-[12px] ${
                                          isNull ? 'italic text-zinc-600' : numeric ? 'tabular-nums text-zinc-200' : 'text-zinc-300'
                                        }`}
                                      >
                                        {displayValue}
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

                    {/* Pagination footer: only when there is at least one row */}
                    {totalRows > 0 && (
                      <div className={`flex h-[40px] flex-shrink-0 items-center justify-between gap-3 border-t ${RULE} px-3 sm:px-5`}>
                        <span className="truncate text-[12px] tabular-nums text-zinc-500">
                          {`${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, totalRows)} of ${totalRows.toLocaleString()}`}
                          {committedSearch && <span className="ml-1.5 text-zinc-600">matching “{committedSearch}”</span>}
                        </span>
                        {totalPages > 1 && (
                          <div className="flex flex-shrink-0 items-center gap-1">
                            <KitButton
                              size="sm"
                              variant="ghost"
                              icon={ChevronLeft}
                              onClick={() => goToPage(currentPage - 1)}
                              disabled={currentPage <= 1 || loading}
                            >
                              Previous
                            </KitButton>
                            <span className="px-1.5 text-[12px] tabular-nums text-zinc-500">
                              {currentPage} of {Math.max(1, totalPages)}
                            </span>
                            <KitButton
                              size="sm"
                              variant="ghost"
                              iconRight={ChevronRight}
                              onClick={() => goToPage(currentPage + 1)}
                              disabled={currentPage >= totalPages || loading}
                            >
                              Next
                            </KitButton>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto px-3 py-5 sm:px-5 sm:py-6">
                    {/* Columns */}
                    <section aria-labelledby="db-columns-title">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h3 id="db-columns-title" className="flex items-baseline gap-2">
                          <span className="text-[14px] font-semibold tracking-[-0.01em] text-zinc-100">Columns</span>
                          <span className="text-[12.5px] tabular-nums text-zinc-500">{columns.length}</span>
                        </h3>
                        <KitButton
                          size="sm"
                          icon={Plus}
                          onClick={() => {
                            setError(null)
                            setConstraintOutcome(null)
                            setShowAddColumnModal(true)
                          }}
                        >
                          Add column
                        </KitButton>
                      </div>
                      <div className={`overflow-x-auto border ${EDGE} ${R_PANEL}`}>
                        <table className="w-full min-w-[720px] border-separate border-spacing-0">
                          <thead>
                            <tr className={KIT.gridHead}>
                              {['Column', 'Type', 'Nullable', 'Default', 'Constraints'].map((h) => (
                                <th
                                  key={h}
                                  scope="col"
                                  className={`border-b ${RULE} px-4 py-2 text-left text-[12px] font-normal text-zinc-500`}
                                >
                                  {h}
                                </th>
                              ))}
                              <th scope="col" className={`w-[92px] border-b ${RULE} px-4 py-2 text-right text-[12px] font-normal text-zinc-500`}>
                                <span className="sr-only">Actions</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {columns.map((col) => (
                              <tr key={col.name} className="group transition-colors hover:bg-white/[0.02]">
                                <td className="border-b border-white/[0.04] px-4 py-2.5">
                                  <div className="flex items-center gap-2">
                                    {col.primary ? (
                                      <Key className="h-3 w-3 flex-shrink-0 text-amber-300/70" strokeWidth={2} aria-label="Primary key" />
                                    ) : col.foreign ? (
                                      <Link2 className="h-3 w-3 flex-shrink-0 text-violet-300/80" strokeWidth={2} aria-label="Foreign key" />
                                    ) : (
                                      <span className="h-3 w-3 flex-shrink-0" />
                                    )}
                                    {renamingColumn === col.name ? (
                                      <div className="flex items-center gap-1">
                                        <input
                                          autoFocus
                                          aria-label={`New name for ${col.name}`}
                                          value={renameColumnNewName}
                                          onChange={(e) => setRenameColumnNewName(e.target.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleRenameColumn()
                                            if (e.key === 'Escape') {
                                              setRenamingColumn(null)
                                              setRenameColumnNewName('')
                                            }
                                          }}
                                          disabled={savingRename}
                                          className={`${INPUT_BASE} h-[28px] w-44 px-2 font-mono sm:text-[12.5px]`}
                                        />
                                        <IconButton
                                          icon={savingRename ? Loader2 : Check}
                                          label="Save the new name"
                                          onClick={handleRenameColumn}
                                          disabled={savingRename || !renameColumnNewName.trim()}
                                          className={savingRename ? '[&_svg]:animate-spin' : ''}
                                        />
                                        <IconButton
                                          icon={X}
                                          label="Keep the old name"
                                          onClick={() => {
                                            setRenamingColumn(null)
                                            setRenameColumnNewName('')
                                          }}
                                          disabled={savingRename}
                                        />
                                      </div>
                                    ) : (
                                      <span className="font-mono text-[12.5px] text-zinc-100">{col.name}</span>
                                    )}
                                  </div>
                                </td>
                                <td className="border-b border-white/[0.04] px-4 py-2.5">
                                  <span className="font-mono text-[12px] text-zinc-400">{col.type}</span>
                                </td>
                                <td className="border-b border-white/[0.04] px-4 py-2.5">
                                  <span className={`text-[12.5px] ${col.nullable ? 'text-zinc-500' : 'text-zinc-300'}`}>
                                    {col.nullable ? 'Yes' : 'No'}
                                  </span>
                                </td>
                                <td className="max-w-[240px] border-b border-white/[0.04] px-4 py-2.5">
                                  {col.default ? (
                                    <span className="block truncate font-mono text-[12px] text-zinc-500" title={col.default}>
                                      {col.default}
                                    </span>
                                  ) : (
                                    <span className="text-[12px] text-zinc-700">None</span>
                                  )}
                                </td>
                                <td className="border-b border-white/[0.04] px-4 py-2.5">
                                  <div className="flex flex-wrap items-center gap-1">
                                    {col.primary && <Tag mono>primary key</Tag>}
                                    {col.unique && !col.primary && <Tag mono>unique</Tag>}
                                    {col.foreign && <Tag mono tone="violet">foreign key</Tag>}
                                    {col.indexed && !col.primary && <Tag mono>indexed</Tag>}
                                    {!col.primary && !col.unique && !col.foreign && !col.indexed && (
                                      <span className="text-[12px] text-zinc-700">None</span>
                                    )}
                                  </div>
                                </td>
                                <td className="border-b border-white/[0.04] px-3 py-2 text-right">
                                  {isReservedColumn(col.name) ? (
                                    <span
                                      className="text-[12px] text-zinc-600"
                                      title="Managed by Backenly. It cannot be renamed or dropped."
                                    >
                                      Managed
                                    </span>
                                  ) : (
                                    <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                                      <IconButton
                                        icon={Edit2}
                                        label={`Rename ${col.name}`}
                                        onClick={() => {
                                          setRenamingColumn(col.name)
                                          setRenameColumnNewName(col.name)
                                        }}
                                        disabled={renamingColumn !== null}
                                      />
                                      <IconButton
                                        icon={Trash2}
                                        label={`Drop ${col.name}`}
                                        onClick={() => {
                                          setError(null)
                                          setColumnToDelete(col.name)
                                          setShowDeleteColumnModal(true)
                                        }}
                                        className="hover:!bg-rose-500/[0.12] hover:!text-rose-300"
                                      />
                                    </div>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>

                    {/* Indexes: what Postgres actually has, read from the catalog */}
                    {indexes.length > 0 && (
                      <section aria-labelledby="db-indexes-title" className="mt-8">
                        <h3 id="db-indexes-title" className="mb-3 flex items-baseline gap-2">
                          <span className="text-[14px] font-semibold tracking-[-0.01em] text-zinc-100">Indexes</span>
                          <span className="text-[12.5px] tabular-nums text-zinc-500">{indexes.length}</span>
                        </h3>
                        <div className={`overflow-x-auto border ${EDGE} ${R_PANEL}`}>
                          <table className="w-full min-w-[480px] border-separate border-spacing-0">
                            <thead>
                              <tr className={KIT.gridHead}>
                                {['Name', 'Columns', 'Kind'].map((h) => (
                                  <th
                                    key={h}
                                    scope="col"
                                    className={`border-b ${RULE} px-4 py-2 text-left text-[12px] font-normal text-zinc-500`}
                                  >
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {indexes.map((ix) => (
                                <tr key={ix.name}>
                                  <td className="max-w-[320px] border-b border-white/[0.04] px-4 py-2.5">
                                    <span className="block truncate font-mono text-[12px] text-zinc-200" title={ix.name}>
                                      {ix.name}
                                    </span>
                                  </td>
                                  <td className="border-b border-white/[0.04] px-4 py-2.5 font-mono text-[12px] text-zinc-400">
                                    {ix.columns.join(', ')}
                                  </td>
                                  <td className="border-b border-white/[0.04] px-4 py-2.5 text-[12.5px] text-zinc-400">
                                    {ix.unique ? 'unique' : 'index'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    )}
                  </div>
                )}
              </>
            ) : (
              <EmptyState
                icon={DatabaseIcon}
                title={tables.length === 0 ? 'No tables yet' : 'Pick a table'}
                description={
                  tables.length === 0
                    ? 'Ask your coding agent for the data your app needs. Each table it creates comes with REST endpoints, row-level security and a reversible change record.'
                    : 'Choose a table on the left to browse its rows and structure.'
                }
                action={
                  tables.length === 0 ? (
                    <div className="flex w-full flex-col items-center gap-3">
                      <AgentPrompt prompt="Add a products table with a name, a price in cents and a stock count. Anyone can read it; only admins can write." />
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <KitButton
                          variant="primary"
                          size="sm"
                          icon={Cable}
                          onClick={() => router.push(`/app/projects/${resolvedProjectId}/connect`)}
                        >
                          Connect your agent
                        </KitButton>
                        <KitButton size="sm" icon={Plus} onClick={openCreateTable} disabled={!selectedSchema}>
                          New table
                        </KitButton>
                      </div>
                    </div>
                  ) : undefined
                }
                className="h-full"
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Full-screen schema graph ─────────────────────────── */}
      <AnimatePresence>
        {isVisualizationExpanded && selectedSchema && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className={`fixed inset-0 z-50 flex flex-col ${KIT.bg}`}
            role="dialog"
            aria-modal="true"
            aria-label="Schema graph, full screen"
          >
            <div className={`flex h-[52px] flex-shrink-0 items-center justify-between gap-3 border-b ${RULE} pl-5 pr-3`}>
              <div className="flex min-w-0 items-baseline gap-2.5">
                <h2 className="text-[15px] font-semibold tracking-[-0.014em] text-zinc-50">Schema graph</h2>
                <span className="hidden truncate text-[12px] text-zinc-500 sm:inline">
                  {tables.length} {tables.length === 1 ? 'table' : 'tables'}
                </span>
              </div>
              <IconButton icon={Minimize2} label="Exit full screen" onClick={() => setIsVisualizationExpanded(false)} />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <EnhancedSchemaVisualizer
                schema={selectedSchema}
                databaseType={activeDb}
                projectId={resolvedProjectId || undefined}
                view={databaseView}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Insert row ─────────────────────────────────────── */}
      <KitModal
        open={showAddRowModal}
        onClose={() => {
          if (!loading) setShowAddRowModal(false)
        }}
        title="Insert row"
        description={<span className="font-mono text-[12.5px] text-zinc-400">{selectedTable}</span>}
        width="max-w-lg"
        footer={
          <>
            <KitButton variant="ghost" onClick={() => setShowAddRowModal(false)} disabled={loading}>
              Cancel
            </KitButton>
            <KitButton variant="primary" icon={Plus} onClick={saveNewRow} loading={loading}>
              Insert
            </KitButton>
          </>
        }
      >
        <div className="space-y-3.5">
          {insertableColumns.map((col) => (
            <RowField
              key={col.name}
              column={col}
              required={!col.nullable && !col.default}
              value={newRowData[col.name] ?? ''}
              onChange={(v) => setNewRowData((prev) => ({ ...prev, [col.name]: v }))}
              placeholder={col.default ? `default: ${col.default}` : col.nullable ? 'null' : ''}
              dateAsPicker
            />
          ))}
          {error && (
            <KitNote tone="danger" icon={AlertCircle}>
              {error}
            </KitNote>
          )}
        </div>
      </KitModal>

      {/* ── Edit row ──────────────────────────────────────── */}
      <KitModal
        open={!!editingRow}
        onClose={() => {
          if (!savingRow && !deletingRow) closeRowEditor()
        }}
        title="Edit row"
        description={
          <span className="font-mono text-[12.5px] text-zinc-400">
            {selectedTable}
            {rowPkValue(editingRow) !== undefined && rowPkValue(editingRow) !== null && (
              <span className="text-zinc-600"> · id {String(rowPkValue(editingRow))}</span>
            )}
          </span>
        }
        width="max-w-lg"
        footer={
          <>
            <KitButton
              variant="danger"
              icon={Trash2}
              onClick={deleteEditingRow}
              loading={deletingRow}
              disabled={savingRow}
              className="sm:mr-auto"
            >
              Delete row
            </KitButton>
            <KitButton variant="ghost" onClick={closeRowEditor} disabled={savingRow || deletingRow}>
              Cancel
            </KitButton>
            <KitButton variant="primary" icon={Save} onClick={saveRowEdit} loading={savingRow} disabled={deletingRow}>
              Save changes
            </KitButton>
          </>
        }
      >
        <div className="space-y-3.5">
          {columns.map((col) => {
            const readOnly = !!col.primary || isReservedColumn(col.name)
            return (
              <RowField
                key={col.name}
                column={col}
                readOnly={readOnly}
                required={!col.nullable && !col.default && !readOnly}
                value={editRowData[col.name] ?? ''}
                onChange={(v) => setEditRowData((prev) => ({ ...prev, [col.name]: v }))}
                placeholder={col.nullable ? 'null' : ''}
                nullLabel="null"
              />
            )
          })}
          {error && (
            <KitNote tone="danger" icon={AlertCircle}>
              {error}
            </KitNote>
          )}
        </div>
      </KitModal>

      {/* ── Add column: funnels through the canonical tableLifecycle ── */}
      <KitModal
        open={showAddColumnModal}
        onClose={closeAddColumn}
        title="Add column"
        description={<span className="font-mono text-[12.5px] text-zinc-400">{selectedTable}</span>}
        footer={
          <>
            <KitButton variant="ghost" onClick={closeAddColumn} disabled={addingColumn}>
              Cancel
            </KitButton>
            <KitButton
              variant="primary"
              icon={Plus}
              onClick={handleAddColumn}
              loading={addingColumn}
              disabled={!newColumnName.trim() || fkBlocked}
            >
              Add column
            </KitButton>
          </>
        }
      >
        <div className="space-y-4">
          <KitField label="Name" hint="Letters, numbers and underscores. It must start with a letter or an underscore.">
            <KitInput
              value={newColumnName}
              onChange={(e) => setNewColumnName(e.target.value)}
              placeholder="e.g. email, price, is_active"
              disabled={addingColumn}
              className="font-mono"
            />
          </KitField>

          <KitField label="Type">
            <select
              value={newColumnType}
              onChange={(e) => setNewColumnType(e.target.value)}
              disabled={addingColumn}
              className={`${INPUT_BASE} h-[36px] px-2.5 sm:h-[32px]`}
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
          </KitField>

          <label className="flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              checked={newColumnNullable}
              onChange={(e) => setNewColumnNullable(e.target.checked)}
              disabled={addingColumn}
              className={CHECKBOX}
            />
            <span className="text-[13px] text-zinc-300">Allow empty values (nullable)</span>
          </label>

          <div className={`border-t ${RULE} pt-4`}>
            <label className="mb-3 block text-[12.5px] font-medium leading-[18px] text-zinc-300">Constraints</label>

            <label className="mb-4 flex cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={newColumnUnique}
                onChange={(e) => setNewColumnUnique(e.target.checked)}
                disabled={addingColumn}
                className={CHECKBOX}
              />
              <span className="text-[13px] text-zinc-300">Unique</span>
            </label>

            <div className="mb-4">
              <KitField label="References" hint="Points this column at the target table's primary key.">
                <select
                  value={newColumnReferences}
                  onChange={(e) => setNewColumnReferences(e.target.value)}
                  disabled={addingColumn}
                  className={`${INPUT_BASE} h-[36px] px-2.5 sm:h-[32px]`}
                >
                  <option value="">No foreign key</option>
                  {tables
                    .filter((t) => t.name !== selectedTable)
                    .map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                </select>
              </KitField>
              {fkBlocked && (
                <p className="mt-1.5 text-[12px] leading-[17px] text-amber-200/90">
                  A foreign key needs a column named like{' '}
                  <span className="font-mono">{suggestForeignKeyColumn(newColumnReferences)}</span>. Rename the column, or
                  the key will be refused.
                </p>
              )}
            </div>

            <KitField label="Check" hint="A condition every row must satisfy. Validated by the server.">
              <KitInput
                value={newColumnCheck}
                onChange={(e) => setNewColumnCheck(e.target.value)}
                placeholder="e.g. price > 0"
                disabled={addingColumn}
                className="font-mono"
              />
            </KitField>
          </div>

          {constraintOutcome && (
            <KitNote tone="warn" icon={AlertCircle} title={constraintOutcome[0]}>
              <ul className="space-y-0.5">
                {constraintOutcome.slice(1).map((line, i) => (
                  <li key={i} className="font-mono text-[12px] text-amber-100/80">
                    {line}
                  </li>
                ))}
              </ul>
            </KitNote>
          )}

          {error && (
            <KitNote tone="danger" icon={AlertCircle}>
              {error}
            </KitNote>
          )}
        </div>
      </KitModal>

      {/* ── Drop column ───────────────────────────────────── */}
      <KitConfirmDialog
        open={showDeleteColumnModal && !!columnToDelete}
        onCancel={() => {
          if (!droppingColumn) setShowDeleteColumnModal(false)
        }}
        onConfirm={handleDropColumn}
        title="Drop column?"
        description={
          <>
            Permanently deletes <span className="font-mono text-zinc-200">{columnToDelete}</span> and all of its data
            from <span className="font-mono text-zinc-200">{selectedTable}</span>. The REST API is regenerated so the
            column disappears from its payloads.
          </>
        }
        confirmLabel="Drop column"
        danger
        busy={droppingColumn}
      >
        {error && (
          <KitNote tone="danger" icon={AlertCircle}>
            {error}
          </KitNote>
        )}
      </KitConfirmDialog>

      {/* ── New table: funnels through /api/database/create-table ── */}
      <KitModal
        open={showCreateTableModal}
        onClose={() => {
          if (!creatingTable) setShowCreateTableModal(false)
        }}
        title="New table"
        description="Backenly adds id, createdAt and updatedAt, then generates REST endpoints with auth and rate limits."
        footer={
          <>
            <KitButton variant="ghost" onClick={() => setShowCreateTableModal(false)} disabled={creatingTable}>
              Cancel
            </KitButton>
            <KitButton
              variant="primary"
              icon={Plus}
              onClick={handleCreateTable}
              loading={creatingTable}
              disabled={!newTableName.trim()}
            >
              Create table
            </KitButton>
          </>
        }
      >
        <div className="space-y-4">
          <KitField label="Name">
            <KitInput
              value={newTableName}
              onChange={(e) => setNewTableName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateTable()
              }}
              placeholder="e.g. posts, orders, comments"
              disabled={creatingTable}
              className="font-mono"
            />
          </KitField>
          <KitField label={<>Description <span className="font-normal text-zinc-500">(optional)</span></>}>
            <KitInput
              value={newTableDescription}
              onChange={(e) => setNewTableDescription(e.target.value)}
              placeholder="What this table stores"
              disabled={creatingTable}
            />
          </KitField>
          {error && (
            <KitNote tone="danger" icon={AlertCircle}>
              {error}
            </KitNote>
          )}
        </div>
      </KitModal>

      {/* ── Delete table ──────────────────────────────────── */}
      <KitConfirmDialog
        open={showDeleteModal && !!tableToDelete}
        onCancel={() => {
          if (!deletingTable) setShowDeleteModal(false)
        }}
        onConfirm={handleDeleteTable}
        title="Delete table?"
        description={
          <>
            Permanently deletes <span className="font-mono text-zinc-200">{tableToDelete}</span>, all of its rows and its
            generated REST endpoints. This cannot be undone.
          </>
        }
        confirmLabel="Delete table"
        danger
        busy={deletingTable}
      >
        {error && (
          <KitNote tone="danger" icon={AlertCircle}>
            {error}
          </KitNote>
        )}
      </KitConfirmDialog>
    </div>
  )
}

// ─── Parts ────────────────────────────────────────────────────────────────────

const DATABASE_VIEWS: Array<{ id: DatabaseView; label: string; icon: LucideIcon }> = [
  { id: 'tables', label: 'Tables', icon: Table2 },
  { id: 'visualization', label: 'Schema', icon: Network },
  { id: 'sql', label: 'SQL', icon: Terminal },
  { id: 'history', label: 'History', icon: History },
  { id: 'types', label: 'Types', icon: Shapes },
  { id: 'extensions', label: 'Extensions', icon: Puzzle },
  { id: 'snapshots', label: 'Snapshots', icon: Camera },
  { id: 'evolution', label: 'Evolution', icon: Split },
]

const CHECKBOX =
  'h-4 w-4 flex-shrink-0 cursor-pointer rounded-[4px] border-white/20 bg-white/[0.04] text-violet-500 focus:ring-violet-400/30 focus:ring-offset-0'

function isNumericType(type: string): boolean {
  const t = type.toLowerCase()
  return (
    t.includes('int') ||
    t.includes('numeric') ||
    t.includes('decimal') ||
    t.includes('float') ||
    t.includes('double') ||
    t.includes('real') ||
    t.includes('serial')
  )
}

/** One column's input in the insert and edit dialogs: typed to the column. */
function RowField({
  column,
  value,
  onChange,
  placeholder,
  required,
  readOnly = false,
  dateAsPicker = false,
  nullLabel,
}: {
  column: { name: string; type: string }
  value: string
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  readOnly?: boolean
  /** Insert uses the native date-time picker; edit keeps the stored ISO text. */
  dateAsPicker?: boolean
  nullLabel?: string
}) {
  const type = column.type.toLowerCase()
  const isBool = type.includes('bool')
  const isNumber = type.includes('int') || type.includes('float') || type.includes('numeric')
  const isDate = type.includes('date') || type.includes('timestamp')
  const label = (
    <span className="flex items-baseline gap-2">
      <span className="font-mono text-zinc-200">{column.name}</span>
      <span className="font-mono text-[11.5px] font-normal text-zinc-600">{column.type}</span>
      {readOnly && <span className="text-[11.5px] font-normal text-zinc-600">read-only</span>}
      {required && (
        <span className="text-[11.5px] font-normal text-zinc-500" aria-label="required">
          required
        </span>
      )}
    </span>
  )

  if (readOnly) {
    return (
      <KitField label={label}>
        <div className={`min-h-[32px] break-all ${R_CONTROL} border border-white/[0.05] bg-white/[0.02] px-3 py-1.5 font-mono text-[12px] text-zinc-500`}>
          {value === '' ? <span className="italic text-zinc-600">null</span> : value}
        </div>
      </KitField>
    )
  }

  if (isBool) {
    return (
      <KitField label={label}>
        <select value={value} onChange={(e) => onChange(e.target.value)} className={`${INPUT_BASE} h-[36px] px-2.5 sm:h-[32px]`}>
          <option value="">{nullLabel ? `${nullLabel}` : 'Choose…'}</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </KitField>
    )
  }

  return (
    <KitField label={label}>
      <KitInput
        type={isNumber ? 'number' : isDate && dateAsPicker ? 'datetime-local' : 'text'}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono"
      />
    </KitField>
  )
}
