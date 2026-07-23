'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Copy, Check, Terminal, Globe } from 'lucide-react'

interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string
  description?: string
}

interface ApiEndpointPanelProps {
  projectId: string
  endpoints: ApiEndpoint[]
  baseUrl?: string
}

export function ApiEndpointPanel({ projectId, endpoints, baseUrl = 'https://api.backenly.dev' }: ApiEndpointPanelProps) {
  const [copiedEndpoint, setCopiedEndpoint] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'endpoints' | 'curl'>('endpoints')
  
  const projectUrl = `${baseUrl}/${projectId}`
  
  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedEndpoint(id)
    setTimeout(() => setCopiedEndpoint(null), 2000)
  }
  
  const getCurlExample = (endpoint: ApiEndpoint) => {
    const fullUrl = `${projectUrl}${endpoint.path}`
    
    if (endpoint.method === 'GET') {
      return `curl ${fullUrl}`
    }
    
    if (endpoint.method === 'POST') {
      return `curl -X POST ${fullUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"key": "value"}'`
    }
    
    return `curl -X ${endpoint.method} ${fullUrl}`
  }
  
  if (endpoints.length === 0) {
    return (
      <div className="p-4 text-center">
        <p className="text-xs text-slate-500">No APIs yet</p>
        <p className="text-[10px] text-slate-600 mt-1">Create tables to generate APIs</p>
      </div>
    )
  }
  
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] text-slate-500">API Endpoints</p>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-600">
          <Globe className="w-3 h-3" />
          <span className="truncate max-w-[150px]">{projectUrl}</span>
        </div>
      </div>
      
      {/* Tabs */}
      <div className="flex gap-1 mb-3">
        <button
          onClick={() => setActiveTab('endpoints')}
          className={`px-2 py-1 text-[10px] rounded transition-colors ${
            activeTab === 'endpoints' 
              ? 'bg-slate-800 text-slate-200' 
              : 'text-slate-600 hover:text-slate-400'
          }`}
        >
          Endpoints
        </button>
        <button
          onClick={() => setActiveTab('curl')}
          className={`px-2 py-1 text-[10px] rounded transition-colors ${
            activeTab === 'curl' 
              ? 'bg-slate-800 text-slate-200' 
              : 'text-slate-600 hover:text-slate-400'
          }`}
        >
          <Terminal className="w-3 h-3 inline mr-1" />
          cURL
        </button>
      </div>
      
      <AnimatePresence mode="wait">
        {activeTab === 'endpoints' ? (
          <motion.div
            key="endpoints"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-1.5"
          >
            {endpoints.slice(0, 5).map((endpoint, idx) => {
              const fullUrl = `${projectUrl}${endpoint.path}`
              const copyId = `endpoint-${idx}`
              
              return (
                <div
                  key={idx}
                  className="group flex items-center gap-2 p-2 bg-slate-900/50 border border-slate-800 rounded-lg hover:border-slate-700 transition-colors"
                >
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                    endpoint.method === 'GET' ? 'bg-green-500/20 text-green-400' :
                    endpoint.method === 'POST' ? 'bg-blue-500/20 text-blue-400' :
                    endpoint.method === 'PUT' ? 'bg-amber-500/20 text-amber-500' :
                    endpoint.method === 'DELETE' ? 'bg-red-500/20 text-red-400' :
                    'bg-slate-700 text-slate-400'
                  }}`}>
                    {endpoint.method}
                  </span>
                  <span className="text-xs text-slate-300 flex-1 truncate">
                    {endpoint.path}
                  </span>
                  <button
                    onClick={() => copyToClipboard(fullUrl, copyId)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-slate-600 hover:text-slate-400 transition-all"
                    title="Copy URL"
                  >
                    {copiedEndpoint === copyId ? (
                      <Check className="w-3.5 h-3.5 text-green-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              )
            })}
            {endpoints.length > 5 && (
              <p className="text-[10px] text-slate-600 text-center">
                +{endpoints.length - 5} more endpoints
              </p>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="curl"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-2"
          >
            {endpoints.slice(0, 3).map((endpoint, idx) => {
              const curlExample = getCurlExample(endpoint)
              const copyId = `curl-${idx}`
              
              return (
                <div key={idx} className="relative">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                      endpoint.method === 'GET' ? 'bg-green-500/20 text-green-400' :
                      endpoint.method === 'POST' ? 'bg-blue-500/20 text-blue-400' :
                      'bg-slate-700 text-slate-400'
                    }`}>
                      {endpoint.method}
                    </span>
                    <span className="text-[10px] text-slate-500">{endpoint.path}</span>
                  </div>
                  <div className="relative group">
                    <pre className="p-2 bg-slate-950 border border-slate-800 rounded-lg text-[10px] text-slate-400 overflow-x-auto">
                      <code>{curlExample}</code>
                    </pre>
                    <button
                      onClick={() => copyToClipboard(curlExample, copyId)}
                      className="absolute top-1.5 right-1.5 p-1 bg-slate-800 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Copy cURL"
                    >
                      {copiedEndpoint === copyId ? (
                        <Check className="w-3 h-3 text-green-400" />
                      ) : (
                        <Copy className="w-3 h-3 text-slate-400" />
                      )}
                    </button>
                  </div>
                </div>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
