# Per-Project Worker Container Template
# This Dockerfile is used to create isolated worker containers for each project
# Each project gets its own container with resource limits

FROM node:20-alpine AS base

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache dumb-init wget

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001 -G nodejs

# Copy worker code
COPY --chown=worker:nodejs worker/package*.json ./
RUN npm ci --only=production

# Install ts-node for .ts file execution
RUN npm install ts-node typescript @types/node --save

# Copy worker dist
COPY --chown=worker:nodejs worker/dist ./dist

# Create workspace directory for this project
RUN mkdir -p /workspace && chown -R worker:nodejs /workspace

# Switch to non-root user
USER worker

# Environment variables (will be overridden per project)
ENV NODE_ENV=production
ENV WORKER_MODE=db
ENV WORKSPACE_ROOT=/workspace

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${WORKER_PORT:-5173}/health || exit 1

# Start the worker
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
