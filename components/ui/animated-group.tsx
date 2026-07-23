'use client'

import { motion } from 'framer-motion'
import React from 'react'

type AnimationVariant = {
  hidden: Record<string, unknown>
  visible: Record<string, unknown>
}

const presets = {
  'blur-slide': {
    container: {
      hidden: { opacity: 0 },
      visible: {
        opacity: 1,
        transition: { staggerChildren: 0.07 },
      },
    },
    item: {
      hidden: { opacity: 0, y: 16, filter: 'blur(6px)' },
      visible: {
        opacity: 1,
        y: 0,
        filter: 'blur(0px)',
        transition: { type: 'spring', bounce: 0.35, duration: 0.65 },
      },
    },
  },
  'fade-up': {
    container: {
      hidden: { opacity: 0 },
      visible: {
        opacity: 1,
        transition: { staggerChildren: 0.08 },
      },
    },
    item: {
      hidden: { opacity: 0, y: 20 },
      visible: {
        opacity: 1,
        y: 0,
        transition: { type: 'spring', bounce: 0.3, duration: 0.6 },
      },
    },
  },
}

type Preset = keyof typeof presets

interface AnimatedGroupProps {
  children: React.ReactNode
  className?: string
  preset?: Preset
  variants?: {
    container?: AnimationVariant
    item?: AnimationVariant
  }
}

export function AnimatedGroup({
  children,
  className,
  preset = 'blur-slide',
  variants,
}: AnimatedGroupProps) {
  const base = presets[preset]
  const containerVars = variants?.container ?? base.container
  const itemVars = variants?.item ?? base.item

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={containerVars as Parameters<typeof motion.div>[0]['variants']}
      className={className}
    >
      {React.Children.map(children, (child, i) => (
        <motion.div
          key={i}
          variants={itemVars as Parameters<typeof motion.div>[0]['variants']}
        >
          {child}
        </motion.div>
      ))}
    </motion.div>
  )
}
