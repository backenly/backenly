import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import crypto from 'crypto'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Generate a unique trace ID for request tracking and error correlation
 */
export function generateTraceId(): string {
  return `trace_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`
}
