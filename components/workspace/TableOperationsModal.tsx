'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Plus, Eye, Trash2, ChevronLeft, ChevronRight } from 'lucide-react'

interface TableOperationsModalProps {
  isOpen: boolean
  onClose: () => void
  projectId: string
  tableName: string
  mode: 'insert' | 'view' | 'delete'
}

interface Field {
  name: string
  type: string
  required: boolean
}

interface Row {
  [key: string]: any
}

export function TableOperationsModal({
  isOpen,
  onClose,
  projectId,
  tableName,
  mode,
}: TableOperationsModalProps) {
  const [fields, setFields] = useState<Field[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [formData, setFormData] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const rowsPerPage = 10

  // Load table schema when modal opens
  useEffect(() => {
    if (isOpen && tableName) {
      loadTableSchema()
      if (mode === 'view' || mode === 'delete') {
        loadRows()
      }
    }
  }, [isOpen, tableName, mode])

  const loadTableSchema = async () => {
    try {
      const response = await fetch(
        `/api/projects/${projectId}/table-schema?table=${tableName}`,
        { credentials: 'include' }
      )
      if (response.ok) {
        const data = await response.json()
        setFields(data.fields || [])
        
        // Initialize form data with empty values
        const initialData: Record<string, any> = {}
        data.fields?.forEach((field: Field) => {
          initialData[field.name] = ''
        })
        setFormData(initialData)
      }
    } catch (error) {
      console.error('Failed to load table schema:', error)
    }
  }

  const loadRows = async () => {
    setLoading(true)
    try {
      const response = await fetch(
        `/api/projects/${projectId}/table-op`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            entity: tableName,
            operation: 'select',
            payload: { limit: 100 },
          }),
        }
      )
      if (response.ok) {
        const data = await response.json()
        setRows(data.rows || [])
      }
    } catch (error) {
      console.error('Failed to load rows:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleInsert = async () => {
    setLoading(true)
    try {
      const response = await fetch(
        `/api/projects/${projectId}/table-op`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            entity: tableName,
            operation: 'insert',
            payload: formData,
          }),
        }
      )
      if (response.ok) {
        onClose()
      }
    } catch (error) {
      console.error('Failed to insert row:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (rowId: string) => {
    setLoading(true)
    try {
      const response = await fetch(
        `/api/projects/${projectId}/table-op`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            entity: tableName,
            operation: 'delete',
            payload: { id: rowId },
          }),
        }
      )
      if (response.ok) {
        setRows(rows.filter(row => row.id !== rowId))
      }
    } catch (error) {
      console.error('Failed to delete row:', error)
    } finally {
      setLoading(false)
    }
  }

  const updateFormField = (fieldName: string, value: any) => {
    setFormData({ ...formData, [fieldName]: value })
  }

  const getInputType = (fieldType: string): string => {
    const lowerType = fieldType.toLowerCase()
    if (lowerType.includes('int') || lowerType.includes('number')) return 'number'
    if (lowerType.includes('bool')) return 'checkbox'
    if (lowerType.includes('date')) return 'date'
    if (lowerType.includes('email')) return 'email'
    return 'text'
  }

  const paginatedRows = rows.slice(
    (currentPage - 1) * rowsPerPage,
    currentPage * rowsPerPage
  )
  const totalPages = Math.ceil(rows.length / rowsPerPage)

  const getTitle = () => {
    switch (mode) {
      case 'insert': return 'Insert Row'
      case 'view': return 'View Rows'
      case 'delete': return 'Delete Rows'
      default: return 'Table Operations'
    }
  }

  const getSubtitle = () => {
    switch (mode) {
      case 'insert': return `Add a new record to ${tableName}`
      case 'view': return `Viewing ${rows.length} rows from ${tableName}`
      case 'delete': return `Manage rows in ${tableName}`
      default: return tableName
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-4xl max-h-[85vh] bg-[#0B0F1A] border border-white/10 rounded-xl shadow-2xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-white/5">
              <div>
                <h3 className="text-lg font-semibold text-[#E6E8EF]">
                  {getTitle()}
                </h3>
                <p className="text-sm text-[#9AA3B2] mt-1">
                  {getSubtitle()}
                </p>
              </div>
              <button
                onClick={onClose}
                className="p-2 hover:bg-white/5 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-[#9AA3B2]" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {/* Insert Mode */}
              {mode === 'insert' && (
                <div className="space-y-4">
                  {fields.map((field) => (
                    <div key={field.name}>
                      <label className="block text-sm font-medium text-[#E6E8EF] mb-2">
                        {field.name}
                        {field.required && (
                          <span className="text-red-400 ml-1">*</span>
                        )}
                        <span className="text-xs text-[#9AA3B2] ml-2">
                          ({field.type})
                        </span>
                      </label>
                      {getInputType(field.type) === 'checkbox' ? (
                        <input
                          type="checkbox"
                          checked={formData[field.name] || false}
                          onChange={(e) =>
                            updateFormField(field.name, e.target.checked)
                          }
                          className="w-4 h-4 rounded border-white/10 bg-[#151B2E]/60 text-purple-600 focus:ring-purple-500"
                        />
                      ) : (
                        <input
                          type={getInputType(field.type)}
                          value={formData[field.name] || ''}
                          onChange={(e) =>
                            updateFormField(field.name, e.target.value)
                          }
                          required={field.required}
                          className="w-full px-4 py-2 bg-[#151B2E]/60 border border-white/10 rounded-lg text-[#E6E8EF] text-sm focus:outline-none focus:border-purple-500/50"
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* View/Delete Mode */}
              {(mode === 'view' || mode === 'delete') && (
                <>
                  {loading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="w-8 h-8 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
                    </div>
                  ) : rows.length === 0 ? (
                    <div className="text-center py-12">
                      <p className="text-sm text-[#9AA3B2]">No rows found</p>
                    </div>
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-white/5">
                              {fields.map((field) => (
                                <th
                                  key={field.name}
                                  className="text-left px-4 py-3 text-xs font-semibold text-[#9AA3B2] uppercase"
                                >
                                  {field.name}
                                </th>
                              ))}
                              {mode === 'delete' && (
                                <th className="text-right px-4 py-3 text-xs font-semibold text-[#9AA3B2] uppercase">
                                  Actions
                                </th>
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {paginatedRows.map((row, index) => (
                              <tr
                                key={index}
                                className="border-b border-white/5 hover:bg-white/5 transition-colors"
                              >
                                {fields.map((field) => (
                                  <td
                                    key={field.name}
                                    className="px-4 py-3 text-sm text-[#E6E8EF]"
                                  >
                                    {typeof row[field.name] === 'boolean'
                                      ? row[field.name]
                                        ? '✓'
                                        : '✗'
                                      : row[field.name]?.toString() || '-'}
                                  </td>
                                ))}
                                {mode === 'delete' && (
                                  <td className="px-4 py-3 text-right">
                                    <button
                                      onClick={() => handleDelete(row.id)}
                                      disabled={loading}
                                      className="p-2 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors disabled:opacity-50"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Pagination */}
                      {totalPages > 1 && (
                        <div className="flex items-center justify-between mt-6">
                          <p className="text-sm text-[#9AA3B2]">
                            Showing {(currentPage - 1) * rowsPerPage + 1} to{' '}
                            {Math.min(currentPage * rowsPerPage, rows.length)} of{' '}
                            {rows.length} rows
                          </p>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                              disabled={currentPage === 1}
                              className="p-2 text-[#9AA3B2] hover:text-[#E6E8EF] hover:bg-white/5 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-sm text-[#E6E8EF]">
                              Page {currentPage} of {totalPages}
                            </span>
                            <button
                              onClick={() =>
                                setCurrentPage(Math.min(totalPages, currentPage + 1))
                              }
                              disabled={currentPage === totalPages}
                              className="p-2 text-[#9AA3B2] hover:text-[#E6E8EF] hover:bg-white/5 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            {mode === 'insert' && (
              <div className="p-6 border-t border-white/5">
                <button
                  onClick={handleInsert}
                  disabled={loading}
                  className="w-full px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-600/50 disabled:cursor-not-allowed text-[#E6E8EF] text-sm font-semibold rounded-lg transition-colors flex items-center justify-center space-x-2"
                >
                  {loading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Inserting...</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4" />
                      <span>Insert Row</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
