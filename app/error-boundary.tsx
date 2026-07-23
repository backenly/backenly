'use client'

import { Component, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('Error caught by boundary:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '50px', color: 'white', background: '#0A0E1A', minHeight: '100vh' }}>
          <h1 style={{ fontSize: '24px', marginBottom: '20px' }}>Something went wrong</h1>
          <p style={{ marginBottom: '20px' }}>{this.state.error?.message}</p>
          <pre style={{ background: '#111', padding: '20px', borderRadius: '8px', overflow: 'auto', fontSize: '12px' }}>
            {this.state.error?.stack}
          </pre>
          <button 
            onClick={() => window.location.reload()}
            style={{ marginTop: '20px', padding: '10px 20px', background: '#3B82F6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            Reload Page
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

