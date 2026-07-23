'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { Database, ChevronRight, Table, Info, Check, Eye, Trash2 } from 'lucide-react'
import { TableOperationsModal } from './TableOperationsModal'

interface EntityInfo {
  name: string
  fieldCount: number
}

interface EntitiesCreatedPanelProps {
  entities: EntityInfo[]
  onNavigateToTables: () => void
  stageCompleted: boolean
  showIndicator: boolean
  projectId: string
}

export function EntitiesCreatedPanel({ entities, onNavigateToTables, stageCompleted, showIndicator, projectId }: EntitiesCreatedPanelProps) {
  const router = useRouter()
  const [hoveredEntity, setHoveredEntity] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<'insert' | 'view' | 'delete'>('view')
  const [selectedTable, setSelectedTable] = useState<string>('')

  if (entities.length === 0) return null

  const openModal = (table: string, mode: 'insert' | 'view' | 'delete') => {
    setSelectedTable(table)
    setModalMode(mode)
    setModalOpen(true)
  }

  const handleViewTable = () => {
    router.push(`/app/projects/${projectId}/database`)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.1 }}
      data-panel="entities"
      className={`bg-[#151B2E]/60 backdrop-blur-xl border rounded-xl p-6 transition-all ${
        showIndicator && !stageCompleted ? 'border-purple-500/50 shadow-lg shadow-purple-500/20' : 'border-white/5'
      }`}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center">
            <Database className="w-5 h-5 text-blue-400 stroke-[2]" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-[#E6E8EF]">
              Tables
            </h3>
            <p className="text-sm text-[#9AA3B2]">
              {entities.length} {entities.length === 1 ? 'table' : 'tables'}
            </p>
          </div>
        </div>
        <button
          onClick={onNavigateToTables}
          className="flex items-center space-x-1 text-sm text-purple-400 hover:text-purple-300 transition-colors group"
        >
          <span>View all</span>
          <ChevronRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform stroke-[2]" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {entities.map((entity) => (
          <div
            key={entity.name}
            onMouseEnter={() => setHoveredEntity(entity.name)}
            onMouseLeave={() => setHoveredEntity(null)}
            className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden hover:border-blue-500/40 hover:shadow-lg hover:shadow-blue-500/10 transition-all duration-200 group"
          >
            <div
              onClick={onNavigateToTables}
              className="p-4 cursor-pointer"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-200 group-hover:text-blue-400 transition-colors duration-200">
                  {entity.name}
                </span>
                <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded font-medium">
                  {entity.fieldCount}
                </span>
              </div>
              <div className="text-xs text-gray-500 group-hover:text-gray-400 transition-colors duration-200">
                Click to inspect
              </div>
            </div>
            
            {/* Quick Actions - Smooth Slide Animation */}
            {hoveredEntity === entity.name && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ 
                  height: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
                  opacity: { duration: 0.15, ease: 'easeOut' }
                }}
                className="border-t border-gray-800 bg-black/40 backdrop-blur-sm"
              >
                <div className="p-2 grid grid-cols-2 gap-1">
                  <button
                    onClick={handleViewTable}
                    className="px-2 py-2 text-xs text-gray-300 hover:text-white hover:bg-gray-800 rounded-md flex items-center justify-center gap-1.5 transition-all duration-150"
                    title="View table in database"
                  >
                    <Eye className="w-3.5 h-3.5 stroke-[2]" />
                    <span className="font-medium">View</span>
                  </button>
                  <button
                    onClick={() => openModal(entity.name, 'delete')}
                    className="px-2 py-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-md flex items-center justify-center gap-1.5 transition-all duration-150"
                    title="Delete rows"
                  >
                    <Trash2 className="w-3.5 h-3.5 stroke-[2]" />
                    <span className="font-medium">Delete</span>
                  </button>
                </div>
              </motion.div>
            )}
          </div>
        ))}
      </div>

      {/* PHASE 4: Table Operations Modal */}
      <TableOperationsModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        projectId={projectId}
        tableName={selectedTable}
        mode={modalMode}
      />
    </motion.div>
  )
}
