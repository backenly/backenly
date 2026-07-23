import { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline'
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
}

export function Button({ 
  variant = 'primary', 
  size = 'md', 
  className, 
  children, 
  ...props 
}: ButtonProps) {
  const baseStyles = 'font-medium rounded-lg transition-all duration-200 inline-flex items-center justify-center'
  
  const variants = {
    primary: 'bg-purple-500 text-white hover:bg-purple-600 active:bg-purple-700',
    secondary: 'bg-dark-surface text-white hover:bg-dark-elevated',
    ghost: 'text-text-muted hover:bg-dark-surface hover:text-white',
    outline: 'border border-dark-border text-text-muted hover:border-purple-500 hover:text-purple-500',
  }
  
  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-base',
    lg: 'px-6 py-3 text-lg',
  }
  
  return (
    <button
      className={cn(baseStyles, variants[variant], sizes[size], className)}
      {...props}
    >
      {children}
    </button>
  )
}

