'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { ReactNode } from 'react'

interface AnimatedButtonProps {
  children: ReactNode
  href: string
  variant?: 'primary' | 'secondary'
  className?: string
}

export function AnimatedButton({ children, href, variant = 'primary', className = '' }: AnimatedButtonProps) {
  const baseClasses = 'px-6 py-3 text-base font-medium rounded-xl transition-all'
  const variantClasses = {
    primary: 'text-white bg-[#3B82F6] hover:bg-[#2563EB] shadow-lg shadow-blue-500/20 hover:shadow-xl hover:shadow-blue-500/30',
    secondary: 'text-white border border-gray-700 hover:border-gray-600 hover:bg-white/5',
  }

  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      transition={{ duration: 0.2 }}
    >
      <Link
        href={href}
        className={`${baseClasses} ${variantClasses[variant]} ${className}`}
      >
        {children}
      </Link>
    </motion.div>
  )
}

