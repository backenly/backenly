'use client'

import { useState, useMemo } from 'react'
import { Button } from '@/components/ui/Button'
import { Toast } from '@/components/ui/Toast'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Plus, Search, Filter, Play, Pause, Trash2, Edit, Copy, Share2,
  CheckSquare, Square, Clock, Activity, Database, Globe, Timer,
  Mail, Code, Webhook, AlertCircle, CheckCircle2, XCircle, ChevronRight,
  ArrowRight, Settings, FileText, Eye, MoreVertical, GripVertical,
  ChevronDown, ArrowUpDown
} from 'lucide-react'
import { Tooltip } from '@/components/ui/Tooltip'

type WorkflowStatus = 'active' | 'inactive'
type TriggerType = 'schedule' | 'db_event' | 'api' | 'manual'
type StepType = 'function' | 'email' | 'http' | 'db_log' | 'condition' | 'wait'
type RunStatus = 'success' | 'error' | 'running'

interface Workflow {
  id: string
  name: string
  description?: string
  status: WorkflowStatus
  trigger: TriggerType
  triggerConfig?: {
    schedule?: string
    db?: string
    table?: string
    event?: 'insert' | 'update' | 'delete'
    endpoint?: string
  }
  steps: WorkflowStep[]
  lastRun?: string
  lastRunStatus?: RunStatus
  totalRuns: number
  successRate: number
  createdAt: string
}

interface WorkflowStep {
  id: string
  type: StepType
  name: string
  config: any
  order: number
}

interface WorkflowRun {
  id: string
  workflowId: string
  status: RunStatus
  startedAt: string
  completedAt?: string
  duration?: number
  steps: StepExecution[]
  error?: string
}

interface StepExecution {
  stepId: string
  stepName: string
  status: RunStatus
  duration: number
  input?: any
  output?: any
  error?: string
}

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([
    {
      id: '1',
      name: 'User Onboarding',
      description: 'Welcome email → Add to mailing list → Log analytics',
      status: 'active',
      trigger: 'db_event',
      triggerConfig: {
        db: 'postgres',
        table: 'users',
        event: 'insert'
      },
      steps: [
        { id: 's1', type: 'email', name: 'Send Welcome Email', config: {}, order: 1 },
        { id: 's2', type: 'http', name: 'Add to Mailing List', config: {}, order: 2 },
        { id: 's3', type: 'db_log', name: 'Log Analytics', config: {}, order: 3 }
      ],
      lastRun: '2m ago',
      lastRunStatus: 'success',
      totalRuns: 1234,
      successRate: 98.5,
      createdAt: '2024-01-15'
    },
    {
      id: '2',
      name: 'Failed Payment Handler',
      description: 'Notify user → Create support ticket → Pause account',
      status: 'active',
      trigger: 'api',
      triggerConfig: {
        endpoint: '/webhooks/payment-failed'
      },
      steps: [
        { id: 's1', type: 'email', name: 'Send Notification', config: {}, order: 1 },
        { id: 's2', type: 'http', name: 'Create Support Ticket', config: {}, order: 2 },
        { id: 's3', type: 'function', name: 'Pause Account', config: {}, order: 3 }
      ],
      lastRun: '5m ago',
      lastRunStatus: 'success',
      totalRuns: 45,
      successRate: 95.6,
      createdAt: '2024-01-20'
    },
    {
      id: '3',
      name: 'Nightly Metrics Report',
      description: 'Aggregate metrics → Generate report → Email admins',
      status: 'active',
      trigger: 'schedule',
      triggerConfig: {
        schedule: '0 2 * * *' // 2 AM daily
      },
      steps: [
        { id: 's1', type: 'function', name: 'Aggregate Metrics', config: {}, order: 1 },
        { id: 's2', type: 'function', name: 'Generate Report', config: {}, order: 2 },
        { id: 's3', type: 'email', name: 'Email Admins', config: {}, order: 3 }
      ],
      lastRun: '1d ago',
      lastRunStatus: 'success',
      totalRuns: 30,
      successRate: 100,
      createdAt: '2024-01-10'
    },
    {
      id: '4',
      name: 'Data Sync Workflow',
      description: 'Sync data between databases',
      status: 'inactive',
      trigger: 'schedule',
      triggerConfig: {
        schedule: '0 */6 * * *' // Every 6 hours
      },
      steps: [
        { id: 's1', type: 'function', name: 'Sync Data', config: {}, order: 1 },
        { id: 's2', type: 'db_log', name: 'Log Sync', config: {}, order: 2 }
      ],
      lastRun: '3d ago',
      lastRunStatus: 'error',
      totalRuns: 120,
      successRate: 87.5,
      createdAt: '2024-01-05'
    }
  ])

  const [selectedWorkflows, setSelectedWorkflows] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [sortBy, setSortBy] = useState<'name' | 'runs' | 'lastRun' | 'successRate'>('lastRun')
  const [showDesigner, setShowDesigner] = useState<Workflow | null>(null)
  const [showRunHistory, setShowRunHistory] = useState<Workflow | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' | 'warning' } | null>(null)

  const filteredAndSortedWorkflows = useMemo(() => {
    let filtered = workflows.filter(w => {
      const matchesSearch = w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        w.description?.toLowerCase().includes(searchQuery.toLowerCase())
      const matchesStatus = statusFilter === 'all' || w.status === statusFilter
      return matchesSearch && matchesStatus
    })

    filtered.sort((a, b) => {
      let comparison = 0
      switch (sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name)
          break
        case 'runs':
          comparison = a.totalRuns - b.totalRuns
          break
        case 'successRate':
          comparison = a.successRate - b.successRate
          break
        case 'lastRun':
          // Simple comparison - in real app, parse dates
          comparison = (a.lastRun || '').localeCompare(b.lastRun || '')
          break
      }
      return comparison
    })

    return filtered
  }, [workflows, searchQuery, statusFilter, sortBy])

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedWorkflows)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedWorkflows(newSelected)
  }

  const toggleSelectAll = () => {
    if (selectedWorkflows.size === filteredAndSortedWorkflows.length) {
      setSelectedWorkflows(new Set())
    } else {
      setSelectedWorkflows(new Set(filteredAndSortedWorkflows.map(w => w.id)))
    }
  }

  const handleBulkAction = (action: 'enable' | 'disable' | 'delete') => {
    if (selectedWorkflows.size === 0) {
      setToast({ message: 'Please select workflows first', type: 'warning' })
      return
    }

    setWorkflows(prev => prev.map(w => {
      if (selectedWorkflows.has(w.id)) {
        if (action === 'delete') return null
        return { ...w, status: action === 'enable' ? 'active' : 'inactive' }
      }
      return w
    }).filter(Boolean) as Workflow[])

    const count = selectedWorkflows.size
    const actionText = action === 'enable' ? 'enabled' : action === 'disable' ? 'disabled' : 'deleted'
    setToast({ message: `${count} workflow(s) ${actionText}`, type: 'success' })
    setSelectedWorkflows(new Set())
  }

  const getTriggerIcon = (trigger: TriggerType) => {
    switch (trigger) {
      case 'schedule':
        return <Timer className="w-4 h-4" />
      case 'db_event':
        return <Database className="w-4 h-4" />
      case 'api':
        return <Webhook className="w-4 h-4" />
      case 'manual':
        return <Play className="w-4 h-4" />
    }
  }

  const getTriggerLabel = (trigger: TriggerType, config?: Workflow['triggerConfig']) => {
    switch (trigger) {
      case 'schedule':
        return `Cron: ${config?.schedule || 'N/A'}`
      case 'db_event':
        return `${config?.db}/${config?.table} ${config?.event}`
      case 'api':
        return `Endpoint: ${config?.endpoint || 'N/A'}`
      case 'manual':
        return 'Manual trigger'
    }
  }

  // Use minimal gray colors for status
  const getStatusColor = (status: WorkflowStatus) => {
    return status === 'active'
      ? 'bg-[#181B20] text-text-muted border-[#23262B]'
      : 'bg-amber-500/20 text-amber-500 border-amber-500/30'
  }

  const getRunStatusColor = (status?: RunStatus) => {
    switch (status) {
      case 'success':
        return 'bg-green-500/20 text-green-400'
      case 'error':
        return 'bg-red-500/20 text-red-400'
      case 'running':
        return 'bg-blue-500/20 text-blue-400'
      default:
        return 'bg-gray-500/20 text-gray-400'
    }
  }

  const totalWorkflows = workflows.length
  const activeWorkflows = workflows.filter(w => w.status === 'active').length
  const totalRuns = workflows.reduce((sum, w) => sum + w.totalRuns, 0)
  const avgSuccessRate = workflows.reduce((sum, w) => sum + w.successRate, 0) / workflows.length

  return (
    <div className="p-8 bg-[#0a0a0f] min-h-screen">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Workflows</h1>
          <p className="text-text-muted">Automate your backend processes by visually connecting triggers, functions, and services</p>
        </div>
        <Button variant="primary" onClick={() => setShowDesigner({} as Workflow)}>
          <Plus className="w-4 h-4 mr-2" />
          New Workflow
        </Button>
      </div>

      {/* Slim Metric Bar */}
      <div className="bg-[#111418] rounded-lg border border-[#23262B] px-6 py-4 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-6 text-sm">
            <div>
              <span className="text-text-muted">Total Workflows: </span>
              <span className="text-white font-semibold">{totalWorkflows}</span>
            </div>
            <div className="w-px h-4 bg-[#23262B]"></div>
            <div>
              <span className="text-text-muted">Active: </span>
              <span className="text-white font-semibold">{activeWorkflows}</span>
            </div>
            <div className="w-px h-4 bg-[#23262B]"></div>
            <div>
              <span className="text-text-muted">Total Runs: </span>
              <span className="text-white font-semibold">{totalRuns.toLocaleString()}</span>
            </div>
            <div className="w-px h-4 bg-[#23262B]"></div>
            <div>
              <span className="text-text-muted">Success Rate: </span>
              <span className="text-emerald-500 font-semibold">{avgSuccessRate.toFixed(1)}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* Compact Search, Filter, and Sort Toolbar */}
      <div className="bg-[#111418] rounded-lg border border-[#23262B] p-3 mb-6">
        <div className="flex items-center space-x-3">
          {/* Search */}
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              placeholder="Search workflows..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-[#181B20] border border-[#23262B] rounded-lg text-white placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-[#0EA5E9] text-sm"
            />
          </div>

          {/* Status Filter */}
          <div className="relative">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="px-3 py-2 pr-8 bg-[#181B20] border border-[#23262B] rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0EA5E9] appearance-none cursor-pointer"
            >
              <option value="all">Status: All</option>
              <option value="active">Status: Active</option>
              <option value="inactive">Status: Inactive</option>
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
          </div>

          {/* Sort */}
          <div className="relative">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="px-3 py-2 pr-8 bg-[#181B20] border border-[#23262B] rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0EA5E9] appearance-none cursor-pointer"
            >
              <option value="lastRun">Sort: Last Run</option>
              <option value="name">Sort: Name</option>
              <option value="runs">Sort: Runs</option>
              <option value="successRate">Sort: Success Rate</option>
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
          </div>
        </div>
      </div>

      {/* Bulk Actions */}
      {selectedWorkflows.size > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#181B20] border border-primary-500/30 rounded-lg p-4 mb-6"
        >
          <div className="flex items-center justify-between">
            <span className="text-white font-medium">
              {selectedWorkflows.size} workflow(s) selected
            </span>
            <div className="flex items-center space-x-2">
              <Button variant="outline" size="sm" onClick={() => handleBulkAction('enable')}>
                <Play className="w-4 h-4 mr-2" />
                Enable
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleBulkAction('disable')}>
                <Pause className="w-4 h-4 mr-2" />
                Disable
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleBulkAction('delete')}
                className="text-red-400 hover:text-red-300 hover:border-red-500"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete
              </Button>
            </div>
          </div>
        </motion.div>
      )}

      {/* Workflows List */}
      <div className="bg-[#111418] rounded-lg border border-[#23262B] overflow-hidden">
        <div className="border-b border-[#23262B] p-3 bg-[#181B20]">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white uppercase tracking-wide">All Workflows</h2>
            <button
              onClick={toggleSelectAll}
              className="text-text-muted hover:text-white transition-colors"
              title="Select all"
            >
              {selectedWorkflows.size === filteredAndSortedWorkflows.length ? (
                <CheckSquare className="w-4 h-4" />
              ) : (
                <Square className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
        <div className="divide-y divide-[#23262B]">
          <AnimatePresence>
            {filteredAndSortedWorkflows.map((workflow, index) => {
              const isEven = index % 2 === 0
              const hasLowSuccess = workflow.successRate < 95
              const getFlowSummary = () => {
                if (workflow.trigger === 'db_event' && workflow.triggerConfig) {
                  return `postgres/${workflow.triggerConfig.table}/${workflow.triggerConfig.event}`
                } else if (workflow.trigger === 'schedule' && workflow.triggerConfig?.schedule) {
                  return `Cron: ${workflow.triggerConfig.schedule}`
                } else if (workflow.trigger === 'api' && workflow.triggerConfig?.endpoint) {
                  return `Endpoint: ${workflow.triggerConfig.endpoint}`
                }
                return workflow.description || 'No steps'
              }
              
              const getFlowSteps = () => {
                if (workflow.description) {
                  return workflow.description.split(' → ').map(s => s.trim())
                }
                return workflow.steps.map(s => s.name)
              }

              return (
              <motion.div
                key={workflow.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={`p-4 transition-colors ${
                  selectedWorkflows.has(workflow.id) 
                    ? 'bg-[#0EA5E9]/10 border-l-2 border-[#0EA5E9]' 
                    : hasLowSuccess
                    ? 'bg-red-500/5 hover:bg-red-500/10'
                    : isEven
                    ? 'bg-[#111418] hover:bg-[#181B20]'
                    : 'bg-[#0a0a0f] hover:bg-[#181B20]'
                }`}
              >
                <div className="flex items-center justify-between">
                  {/* Status & Identity (Left) */}
                  <div className="flex items-start space-x-3 flex-1 min-w-0">
                    {/* Checkbox */}
                    <button
                      onClick={() => toggleSelect(workflow.id)}
                      className="text-text-muted hover:text-white transition-colors flex-shrink-0 mt-0.5"
                    >
                      {selectedWorkflows.has(workflow.id) ? (
                        <CheckSquare className="w-4 h-4 text-[#0EA5E9]" />
                      ) : (
                        <Square className="w-4 h-4" />
                      )}
                    </button>

                    {/* Workflow Name & Status */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-2 mb-1">
                        <h3 className="text-sm font-semibold text-white font-mono truncate">
                          {workflow.name}
                        </h3>
                        <span className={`text-xs px-2 py-0.5 rounded border flex-shrink-0 ${getStatusColor(workflow.status)}`}>
                          {workflow.status === 'active' ? 'Active' : 'Inactive'}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded bg-[#181B20] text-text-muted border border-[#23262B] flex items-center space-x-1 flex-shrink-0">
                          {getTriggerIcon(workflow.trigger)}
                          <span className="capitalize">{workflow.trigger === 'db_event' ? 'DB Event' : workflow.trigger === 'schedule' ? 'CRON' : workflow.trigger.toUpperCase()}</span>
                        </span>
                      </div>
                      
                      {/* Flow Summary */}
                      <div className="text-xs text-text-muted mb-2">
                        <span className="text-text-muted/60">Flow: </span>
                        <span className="font-mono">
                          {getFlowSteps().map((step, idx) => (
                            <span key={idx}>
                              <span className="text-white">{step}</span>
                              {idx < getFlowSteps().length - 1 && (
                                <ArrowRight className="w-3 h-3 inline mx-1 text-text-muted/60" />
                              )}
                            </span>
                          ))}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Performance & Health (Center) */}
                  <div className="flex items-center space-x-4 text-xs text-text-muted mx-4">
                    <span className="font-mono">
                      {workflow.totalRuns.toLocaleString()} Runs
                    </span>
                    <span className="font-mono">·</span>
                    <span className="font-mono">
                      Last: {workflow.lastRun || 'Never'}
                    </span>
                    <span className="font-mono">·</span>
                    <span className={`font-semibold ${
                      hasLowSuccess ? 'text-red-400' : 'text-emerald-500'
                    }`}>
                      {workflow.successRate.toFixed(1)}% Success
                      {hasLowSuccess && <span className="text-red-400 ml-1">(Error)</span>}
                    </span>
                  </div>

                  {/* Actions (Right) */}
                  <div className="flex items-center space-x-1 flex-shrink-0">
                    <Tooltip content="Edit Workflow">
                      <button
                        onClick={() => setShowDesigner(workflow)}
                        className="p-2 text-text-muted hover:text-white hover:bg-[#181B20] rounded transition-colors"
                      >
                        <Edit className="w-5 h-5" />
                      </button>
                    </Tooltip>
                    <Tooltip content="View Logs">
                      <button
                        onClick={() => setShowRunHistory(workflow)}
                        className="p-2 text-text-muted hover:text-white hover:bg-[#181B20] rounded transition-colors"
                      >
                        <FileText className="w-5 h-5" />
                      </button>
                    </Tooltip>
                    <Tooltip content={workflow.status === 'active' ? 'Pause Workflow' : 'Start Workflow'}>
                      <button
                        onClick={() => {
                          setToast({ message: `Workflow ${workflow.name} ${workflow.status === 'active' ? 'paused' : 'enabled'}`, type: 'success' })
                          setWorkflows(prev => prev.map(w => 
                            w.id === workflow.id ? { ...w, status: w.status === 'active' ? 'inactive' : 'active' } : w
                          ))
                        }}
                        className="p-2 text-text-muted hover:text-white hover:bg-[#181B20] rounded transition-colors"
                      >
                        {workflow.status === 'active' ? (
                          <Pause className="w-5 h-5" />
                        ) : (
                          <Play className="w-5 h-5" />
                        )}
                      </button>
                    </Tooltip>
                    <Tooltip content="Delete Workflow">
                      <button
                        onClick={() => {
                          setToast({ message: `Workflow ${workflow.name} deleted`, type: 'success' })
                          setWorkflows(prev => prev.filter(w => w.id !== workflow.id))
                        }}
                        className="p-2 text-text-muted hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </motion.div>
              )
            })}
          </AnimatePresence>
          {filteredAndSortedWorkflows.length === 0 && (
            <div className="p-8 text-center">
              <p className="text-text-muted">No workflows found matching your criteria</p>
            </div>
          )}
        </div>
      </div>

      {/* Workflow Designer Modal */}
      <AnimatePresence>
        {showDesigner !== null && (
          <WorkflowDesigner
            workflow={showDesigner}
            onClose={() => setShowDesigner(null)}
            onSave={(workflow) => {
              if (workflow.id) {
                setWorkflows(prev => prev.map(w => w.id === workflow.id ? workflow : w))
              } else {
                setWorkflows(prev => [...prev, { ...workflow, id: Date.now().toString() }])
              }
              setToast({ message: `Workflow ${workflow.name} saved`, type: 'success' })
              setShowDesigner(null)
            }}
          />
        )}
      </AnimatePresence>

      {/* Run History Modal */}
      <AnimatePresence>
        {showRunHistory && (
          <WorkflowRunHistory
            workflow={showRunHistory}
            onClose={() => setShowRunHistory(null)}
          />
        )}
      </AnimatePresence>

      {/* Toast */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          isVisible={true}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  )
}


// Workflow Designer Component
function WorkflowDesigner({ 
  workflow, 
  onClose, 
  onSave 
}: { 
  workflow: Workflow | null
  onClose: () => void
  onSave: (workflow: Workflow) => void
}) {
  const isNew = !workflow || !workflow.id
  const [name, setName] = useState(workflow?.name || '')
  const [description, setDescription] = useState(workflow?.description || '')
  const [trigger, setTrigger] = useState<TriggerType>(workflow?.trigger || 'manual')
  const [triggerConfig, setTriggerConfig] = useState<Workflow['triggerConfig']>(workflow?.triggerConfig || {})
  const [steps, setSteps] = useState<WorkflowStep[]>(workflow?.steps || [])
  const [status, setStatus] = useState<WorkflowStatus>(workflow?.status || 'inactive')
  const [editingStep, setEditingStep] = useState<WorkflowStep | null>(null)

  const addStep = (type: StepType) => {
    const newStep: WorkflowStep = {
      id: `step-${Date.now()}`,
      type,
      name: `${type} step`,
      config: {},
      order: steps.length + 1
    }
    setSteps([...steps, newStep])
    setEditingStep(newStep)
  }

  const removeStep = (stepId: string) => {
    setSteps(steps.filter(s => s.id !== stepId).map((s, idx) => ({ ...s, order: idx + 1 })))
  }

  const updateStep = (stepId: string, updates: Partial<WorkflowStep>) => {
    setSteps(steps.map(s => s.id === stepId ? { ...s, ...updates } : s))
  }

  const handleSave = () => {
    if (!name.trim()) {
      return
    }
    onSave({
      id: workflow?.id || '',
      name,
      description,
      trigger,
      triggerConfig,
      steps,
      status,
      totalRuns: workflow?.totalRuns || 0,
      successRate: workflow?.successRate || 100,
      createdAt: workflow?.createdAt || new Date().toISOString()
    })
  }

  const getStepIcon = (type: StepType) => {
    switch (type) {
      case 'function':
        return <Code className="w-4 h-4" />
      case 'email':
        return <Mail className="w-4 h-4" />
      case 'http':
        return <Globe className="w-4 h-4" />
      case 'db_log':
        return <Database className="w-4 h-4" />
      case 'condition':
        return <AlertCircle className="w-4 h-4" />
      case 'wait':
        return <Clock className="w-4 h-4" />
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-[#111418] rounded-lg border border-[#23262B] max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="p-6 border-b border-[#23262B] bg-[#181B20]">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center space-x-2 text-sm text-text-muted mb-1">
                <span>Workflows</span>
                <ChevronRight className="w-4 h-4" />
                <span>{isNew ? 'New Workflow' : name}</span>
              </div>
              <h3 className="text-xl font-semibold text-white">
                {isNew ? 'Create New Workflow' : 'Edit Workflow'}
              </h3>
            </div>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 rounded"
            >
              <XCircle className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Basic Info */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-white mb-2">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., User Onboarding"
              className="w-full px-4 py-2 bg-[#0a0a0f] border border-[#23262B] rounded-lg text-white placeholder-text-muted focus:outline-none focus:border-primary-500"
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-white mb-2">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this workflow does..."
              rows={2}
              className="w-full px-4 py-2 bg-[#0a0a0f] border border-[#23262B] rounded-lg text-white placeholder-text-muted focus:outline-none focus:border-primary-500"
            />
          </div>

          {/* Trigger Configuration */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-white mb-2">Trigger</label>
            <select
              value={trigger}
              onChange={(e) => {
                setTrigger(e.target.value as TriggerType)
                setTriggerConfig({})
              }}
              className="w-full px-4 py-2 bg-[#0a0a0f] border border-[#23262B] rounded-lg text-white focus:outline-none focus:border-primary-500"
            >
              <option value="manual">Manual</option>
              <option value="schedule">Schedule (Cron)</option>
              <option value="db_event">Database Event</option>
              <option value="api">API Endpoint</option>
            </select>

            {trigger === 'schedule' && (
              <div className="mt-3">
                <label className="block text-sm font-medium text-text-muted mb-2">Cron Expression</label>
                <input
                  type="text"
                  value={triggerConfig?.schedule || ''}
                  onChange={(e) => setTriggerConfig({ ...triggerConfig, schedule: e.target.value })}
                  placeholder="0 2 * * * (2 AM daily)"
                  className="w-full px-4 py-2 bg-[#0a0a0f] border border-[#23262B] rounded-lg text-white placeholder-text-muted focus:outline-none focus:border-primary-500"
                />
              </div>
            )}

            {trigger === 'db_event' && (
              <div className="mt-3 grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-text-muted mb-2">Database</label>
                  <select
                    value={triggerConfig?.db || ''}
                    onChange={(e) => setTriggerConfig({ ...triggerConfig, db: e.target.value })}
                    className="w-full px-4 py-2 bg-[#0a0a0f] border border-[#23262B] rounded-lg text-white focus:outline-none focus:border-primary-500"
                  >
                    <option value="">Select DB</option>
                    <option value="postgres">PostgreSQL</option>
                    <option value="mongo">MongoDB</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-muted mb-2">Table</label>
                  <input
                    type="text"
                    value={triggerConfig?.table || ''}
                    onChange={(e) => setTriggerConfig({ ...triggerConfig, table: e.target.value })}
                    placeholder="users"
                    className="w-full px-4 py-2 bg-[#0a0a0f] border border-[#23262B] rounded-lg text-white placeholder-text-muted focus:outline-none focus:border-primary-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-muted mb-2">Event</label>
                  <select
                    value={triggerConfig?.event || ''}
                    onChange={(e) => setTriggerConfig({ ...triggerConfig, event: e.target.value as any })}
                    className="w-full px-4 py-2 bg-[#0a0a0f] border border-[#23262B] rounded-lg text-white focus:outline-none focus:border-primary-500"
                  >
                    <option value="">Select Event</option>
                    <option value="insert">Insert</option>
                    <option value="update">Update</option>
                    <option value="delete">Delete</option>
                  </select>
                </div>
              </div>
            )}

            {trigger === 'api' && (
              <div className="mt-3">
                <label className="block text-sm font-medium text-text-muted mb-2">Endpoint URL</label>
                <input
                  type="text"
                  value={triggerConfig?.endpoint || ''}
                  onChange={(e) => setTriggerConfig({ ...triggerConfig, endpoint: e.target.value })}
                  placeholder="/webhooks/my-workflow"
                  className="w-full px-4 py-2 bg-[#0a0a0f] border border-[#23262B] rounded-lg text-white placeholder-text-muted focus:outline-none focus:border-primary-500"
                />
              </div>
            )}
          </div>

          {/* Steps */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <label className="block text-sm font-medium text-white">Steps</label>
              <div className="flex items-center space-x-2">
                <Button variant="outline" size="sm" onClick={() => addStep('function')}>
                  <Code className="w-4 h-4 mr-2" />
                  Function
                </Button>
                <Button variant="outline" size="sm" onClick={() => addStep('email')}>
                  <Mail className="w-4 h-4 mr-2" />
                  Email
                </Button>
                <Button variant="outline" size="sm" onClick={() => addStep('http')}>
                  <Globe className="w-4 h-4 mr-2" />
                  HTTP
                </Button>
                <Button variant="outline" size="sm" onClick={() => addStep('condition')}>
                  <AlertCircle className="w-4 h-4 mr-2" />
                  Condition
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              {steps.map((step, idx) => (
                <div
                  key={step.id}
                  className="bg-[#181B20] rounded-lg p-4 border border-[#23262B]"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3 flex-1">
                      <GripVertical className="w-5 h-5 text-text-muted" />
                      <div className="flex items-center space-x-2">
                        {getStepIcon(step.type)}
                        <span className="text-sm text-text-muted">Step {step.order}</span>
                      </div>
                      <input
                        type="text"
                        value={step.name}
                        onChange={(e) => updateStep(step.id, { name: e.target.value })}
                        className="flex-1 px-3 py-1 bg-[#0a0a0f] border border-[#23262B] rounded text-white text-sm focus:outline-none focus:border-primary-500"
                        placeholder="Step name"
                      />
                    </div>
                    <div className="flex items-center space-x-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingStep(step)}
                      >
                        <Settings className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeStep(step.id)}
                        className="text-red-400 hover:text-red-300"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  {idx < steps.length - 1 && (
                    <div className="flex justify-center mt-2">
                      <ArrowRight className="w-4 h-4 text-text-muted" />
                    </div>
                  )}
                </div>
              ))}
              {steps.length === 0 && (
                <div className="text-center py-8 text-text-muted">
                  <p>No steps added yet. Click the buttons above to add steps.</p>
                </div>
              )}
            </div>
          </div>

          {/* Status Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-white mb-2">Status</label>
              <div className="flex items-center space-x-4">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={status === 'active'}
                    onChange={() => setStatus('active')}
                    className="w-4 h-4 text-primary-500"
                  />
                  <span className="text-sm text-white">Active</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={status === 'inactive'}
                    onChange={() => setStatus('inactive')}
                    className="w-4 h-4 text-primary-500"
                  />
                  <span className="text-sm text-white">Inactive</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-[#23262B] bg-[#181B20] flex items-center justify-end space-x-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={!name.trim()}>
            Save Workflow
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}

// Workflow Run History Component
function WorkflowRunHistory({ 
  workflow, 
  onClose 
}: { 
  workflow: Workflow
  onClose: () => void
}) {
  const runs: WorkflowRun[] = [
    {
      id: '1',
      workflowId: workflow.id,
      status: 'success',
      startedAt: '2024-01-25T10:30:00Z',
      completedAt: '2024-01-25T10:30:05Z',
      duration: 5000,
      steps: [
        {
          stepId: 's1',
          stepName: 'Send Welcome Email',
          status: 'success',
          duration: 1200,
          input: { userId: '123' },
          output: { emailId: 'email-456' }
        },
        {
          stepId: 's2',
          stepName: 'Add to Mailing List',
          status: 'success',
          duration: 800,
          input: { email: 'user@example.com' },
          output: { listId: 'list-789' }
        },
        {
          stepId: 's3',
          stepName: 'Log Analytics',
          status: 'success',
          duration: 300,
          input: { event: 'user_onboarded' },
          output: { logged: true }
        }
      ]
    },
    {
      id: '2',
      workflowId: workflow.id,
      status: 'error',
      startedAt: '2024-01-25T09:15:00Z',
      completedAt: '2024-01-25T09:15:03Z',
      duration: 3000,
      error: 'Failed to send email: Invalid API key',
      steps: [
        {
          stepId: 's1',
          stepName: 'Send Welcome Email',
          status: 'error',
          duration: 500,
          error: 'Invalid API key'
        }
      ]
    }
  ]

  const getStatusColor = (status: RunStatus) => {
    switch (status) {
      case 'success':
        return 'bg-green-500/20 text-green-400 border-green-500/30'
      case 'error':
        return 'bg-red-500/20 text-red-400 border-red-500/30'
      case 'running':
        return 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-[#111418] rounded-lg border border-[#23262B] max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
      >
        <div className="p-6 border-b border-[#23262B] bg-[#181B20]">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-white mb-1">{workflow.name} - Run History</h3>
              <p className="text-sm text-text-muted">{workflow.totalRuns} total runs</p>
            </div>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 rounded"
            >
              <XCircle className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-4">
            {runs.map((run) => (
              <div
                key={run.id}
                className="bg-[#181B20] rounded-lg p-4 border border-[#23262B]"
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-3">
                    <span className={`text-xs px-2 py-1 rounded border ${getStatusColor(run.status)}`}>
                      {run.status}
                    </span>
                    <span className="text-sm text-text-muted">
                      {new Date(run.startedAt).toLocaleString()}
                    </span>
                    {run.duration && (
                      <span className="text-sm text-text-muted">
                        {run.duration}ms
                      </span>
                    )}
                  </div>
                  <Button variant="outline" size="sm">
                    <Play className="w-4 h-4 mr-2" />
                    Re-run
                  </Button>
                </div>

                {run.error && (
                  <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                    <p className="text-sm text-red-400">{run.error}</p>
                  </div>
                )}

                <div className="space-y-2">
                  {run.steps.map((step, idx) => (
                    <div key={step.stepId} className="flex items-start space-x-3">
                      <div className="flex flex-col items-center">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center border ${getStatusColor(step.status)}`}>
                          {step.status === 'success' ? (
                            <CheckCircle2 className="w-4 h-4" />
                          ) : (
                            <XCircle className="w-4 h-4" />
                          )}
                        </div>
                        {idx < run.steps.length - 1 && (
                          <div className="w-px h-8 bg-[#23262B] mt-1"></div>
                        )}
                      </div>
                      <div className="flex-1 pb-4">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-white">{step.stepName}</span>
                          <span className="text-xs text-text-muted">{step.duration}ms</span>
                        </div>
                        {step.error && (
                          <p className="text-xs text-red-400 mt-1">{step.error}</p>
                        )}
                        {step.input && (
                          <details className="mt-2">
                            <summary className="text-xs text-text-muted cursor-pointer">Input</summary>
                            <pre className="mt-1 p-2 bg-[#0a0a0f] rounded text-xs text-text-muted overflow-x-auto">
                              {JSON.stringify(step.input, null, 2)}
                            </pre>
                          </details>
                        )}
                        {step.output && (
                          <details className="mt-2">
                            <summary className="text-xs text-text-muted cursor-pointer">Output</summary>
                            <pre className="mt-1 p-2 bg-[#0a0a0f] rounded text-xs text-text-muted overflow-x-auto">
                              {JSON.stringify(step.output, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
