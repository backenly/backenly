import winston from 'winston'
import path from 'path'

const LOG_LEVEL = process.env.LOG_LEVEL || 'info'
const LOG_FILE_PATH = process.env.LOG_FILE_PATH || './logs/backenly.log'

// Ensure logs directory exists
const logDir = path.dirname(LOG_FILE_PATH)
if (typeof window === 'undefined') {
  const fs = require('fs')
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
}

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
)

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`
    }
    return msg
  })
)

// Create logger instance
export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: logFormat,
  defaultMeta: { service: 'backenly' },
  transports: [
    // Write all logs to file
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: LOG_FILE_PATH,
    }),
  ],
  // Don't exit on handled exceptions
  exceptionHandlers: [
    new winston.transports.File({ filename: path.join(logDir, 'exceptions.log') }),
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: path.join(logDir, 'rejections.log') }),
  ],
})

// Add console transport in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: consoleFormat,
    })
  )
}

// Helper functions for structured logging
export const log = {
  info: (message: string, meta?: Record<string, any>) => {
    logger.info(message, meta)
  },
  error: (message: string, error?: Error | any, meta?: Record<string, any>) => {
    logger.error(message, { error: error?.message, stack: error?.stack, ...meta })
  },
  warn: (message: string, meta?: Record<string, any>) => {
    logger.warn(message, meta)
  },
  debug: (message: string, meta?: Record<string, any>) => {
    logger.debug(message, meta)
  },
  http: (message: string, meta?: Record<string, any>) => {
    logger.http(message, meta)
  },
}

