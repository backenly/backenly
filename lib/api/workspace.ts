export interface FileNode {
  name: string
  type: 'file' | 'folder'
  path: string
  children?: FileNode[]
}

export interface FilesResponse {
  files: FileNode[]
}

export interface FileContentResponse {
  content: string
}

import { apiRequest } from './client'

// List files in workspace
export async function getWorkspaceFiles(basePath?: string): Promise<FileNode[]> {
  const params = new URLSearchParams()
  if (basePath) params.append('path', basePath)

  const url = `/api/workspace/files${params.toString() ? `?${params.toString()}` : ''}`
  const data: FilesResponse = await apiRequest<FilesResponse>(url)
  return data.files
}

// Get file content
export async function getFileContent(filePath: string): Promise<string> {
  try {
    const data = await apiRequest<FileContentResponse>('/api/workspace/files/content', {
      method: 'POST',
      body: JSON.stringify({ filePath }),
    })
    return data.content || ''
  } catch (error: any) {
    console.error(`❌ Failed to load file ${filePath}:`, error)
    throw error
  }
}

// Delete a file or folder
export async function deleteWorkspaceFile(filePath: string): Promise<void> {
  await apiRequest('/api/workspace/files/delete', {
    method: 'DELETE',
    body: JSON.stringify({ filePath }),
  })
}

// Save file content
export async function saveFileContent(filePath: string, content: string): Promise<void> {
  await apiRequest('/api/workspace/files', {
    method: 'PUT',
    body: JSON.stringify({ filePath, content }),
  })
}

// New table detection for bidirectional sync
export interface NewTableSuggestion {
  name: string
  description?: string
  createdAt: Date
  suggestedPrompt: string
}

export interface DetectNewTablesResponse {
  newTables: NewTableSuggestion[]
  totalTables: number
  tablesWithAPIs: number
  message?: string
}

// Detect tables without APIs (Database → Workspace sync)
export async function detectNewTables(): Promise<DetectNewTablesResponse> {
  const data = await apiRequest<{ data: DetectNewTablesResponse }>('/api/ai-workspace/detect-new-tables', {
    method: 'POST',
  })
  return data.data
}

