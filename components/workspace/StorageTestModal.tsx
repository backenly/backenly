'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Upload, File, Trash2, Eye } from 'lucide-react'

interface StorageTestModalProps {
  isOpen: boolean
  onClose: () => void
  projectId: string
}

export function StorageTestModal({ isOpen, onClose, projectId }: StorageTestModalProps) {
  const [uploading, setUploading] = useState(false)
  const [files, setFiles] = useState<Array<{ id: string; name: string; size: number; url: string }>>([])

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    const formData = new FormData()
    formData.append('file', file)

    try {
      const response = await fetch(`/api/projects/${projectId}/storage-test`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })

      if (response.ok) {
        const data = await response.json()
        setFiles([...files, data.file])
      }
    } catch (error) {
      console.error('Failed to upload file:', error)
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (fileId: string) => {
    try {
      await fetch(`/api/projects/${projectId}/storage-files/${fileId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      setFiles(files.filter(f => f.id !== fileId))
    } catch (error) {
      console.error('Failed to delete file:', error)
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[80vh] bg-[#0B0F1A] border border-white/10 rounded-xl shadow-2xl z-50 flex flex-col"
          >
            <div className="flex items-center justify-between p-6 border-b border-white/5">
              <div>
                <h3 className="text-lg font-semibold text-[#E6E8EF]">Storage Test</h3>
                <p className="text-sm text-[#9AA3B2] mt-1">Upload and manage test files</p>
              </div>
              <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-lg transition-colors">
                <X className="w-5 h-5 text-[#9AA3B2]" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* Upload Section */}
              <div className="border-2 border-dashed border-white/10 rounded-lg p-8 text-center hover:border-purple-500/30 transition-all">
                <input
                  type="file"
                  id="file-upload"
                  onChange={handleFileUpload}
                  disabled={uploading}
                  className="hidden"
                />
                <label
                  htmlFor="file-upload"
                  className="cursor-pointer flex flex-col items-center space-y-3"
                >
                  <div className="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center">
                    <Upload className="w-6 h-6 text-purple-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[#E6E8EF]">
                      {uploading ? 'Uploading...' : 'Click to upload file'}
                    </p>
                    <p className="text-xs text-[#9AA3B2] mt-1">Test your storage configuration</p>
                  </div>
                </label>
              </div>

              {/* Files List */}
              {files.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold text-[#E6E8EF]">Uploaded Files</h4>
                  {files.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center justify-between p-3 bg-[#151B2E]/60 border border-white/10 rounded-lg"
                    >
                      <div className="flex items-center space-x-3">
                        <File className="w-5 h-5 text-purple-400" />
                        <div>
                          <p className="text-sm text-[#E6E8EF]">{file.name}</p>
                          <p className="text-xs text-[#9AA3B2]">
                            {(file.size / 1024).toFixed(2)} KB
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => window.open(file.url, '_blank')}
                          className="p-2 text-purple-400 hover:text-purple-300 hover:bg-white/5 rounded transition-colors"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(file.id)}
                          className="p-2 text-red-400 hover:text-red-300 hover:bg-white/5 rounded transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
