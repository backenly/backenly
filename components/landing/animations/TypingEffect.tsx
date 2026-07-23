'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'

interface TypingEffectProps {
  text: string
  speed?: number
  className?: string
}

export function TypingEffect({ text, speed = 50, className = '' }: TypingEffectProps) {
  const [displayedText, setDisplayedText] = useState('')
  const [showCursor, setShowCursor] = useState(true)

  useEffect(() => {
    let currentIndex = 0
    const interval = setInterval(() => {
      if (currentIndex < text.length) {
        setDisplayedText(text.slice(0, currentIndex + 1))
        currentIndex++
      } else {
        clearInterval(interval)
      }
    }, speed)

    return () => clearInterval(interval)
  }, [text, speed])

  // Blinking cursor
  useEffect(() => {
    const cursorInterval = setInterval(() => {
      setShowCursor((prev) => !prev)
    }, 530)

    return () => clearInterval(cursorInterval)
  }, [])

  return (
    <span className={className}>
      {displayedText}
      {showCursor && <motion.span animate={{ opacity: [1, 0] }} transition={{ duration: 0.5, repeat: Infinity }}>|</motion.span>}
    </span>
  )
}

