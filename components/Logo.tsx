'use client'

import React from 'react'

export function Logo() {
  return (
    <svg 
      width="32" 
      height="32" 
      viewBox="0 0 32 32" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
      className="rounded-lg"
    >
      {/* Dark background for infrastructure feel */}
      <rect width="32" height="32" rx="8" fill="#0F1419" />
      
      {/* Backend server stack representation */}
      <g opacity="0.95">
        {/* Bottom layer - database */}
        <rect x="8" y="20" width="16" height="3" rx="1" fill="#8B5CF6" />
        
        {/* Middle layer - API */}
        <rect x="8" y="14.5" width="16" height="3" rx="1" fill="#A78BFA" />
        
        {/* Top layer - interface */}
        <rect x="8" y="9" width="16" height="3" rx="1" fill="white" opacity="0.9" />
        
        {/* Connection lines showing data flow */}
        <line x1="12" y1="12" x2="12" y2="14.5" stroke="#8B5CF6" strokeWidth="1" opacity="0.6" />
        <line x1="16" y1="12" x2="16" y2="14.5" stroke="#8B5CF6" strokeWidth="1" opacity="0.6" />
        <line x1="20" y1="12" x2="20" y2="14.5" stroke="#8B5CF6" strokeWidth="1" opacity="0.6" />
        
        <line x1="12" y1="17.5" x2="12" y2="20" stroke="#8B5CF6" strokeWidth="1" opacity="0.6" />
        <line x1="16" y1="17.5" x2="16" y2="20" stroke="#8B5CF6" strokeWidth="1" opacity="0.6" />
        <line x1="20" y1="17.5" x2="20" y2="20" stroke="#8B5CF6" strokeWidth="1" opacity="0.6" />
      </g>
    </svg>
  )
}