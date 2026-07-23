# Golden Environment Dockerfile
# Solution 5: Internal Build Environment
# 
# This is the ONLY environment where backends are built.
# If it doesn't build here, it doesn't ship.

FROM node:18.19.0-alpine3.19

# Install build essentials
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    openssl

# Set working directory
WORKDIR /workspace

# Install global tools with EXACT versions
RUN npm install -g \
    prisma@5.22.0 \
    typescript@5.3.3 \
    ts-node@10.9.2

# Copy workspace files
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY routes ./routes
COPY utils ./utils

# Install dependencies (all, including dev)
RUN npm ci --include=dev

# Generate Prisma Client
RUN npx prisma generate

# Compile TypeScript
RUN npx tsc

# Remove dev dependencies
RUN npm prune --production

# Create production bundle
RUN mkdir -p /app && \
    cp -r dist /app/ && \
    cp -r node_modules /app/ && \
    cp -r prisma /app/ && \
    cp package.json /app/

# Verification stage
FROM node:18.19.0-alpine3.19 AS verify

WORKDIR /app

# Copy built application
COPY --from=0 /app /app

# Verify structure
RUN test -d /app/dist || (echo "❌ Missing dist/" && exit 1)
RUN test -d /app/node_modules || (echo "❌ Missing node_modules/" && exit 1)
RUN test -f /app/dist/src/server.js || (echo "❌ Missing server.js" && exit 1)
RUN test -d /app/node_modules/@prisma/client || (echo "❌ Missing Prisma Client" && exit 1)

# Verify Node can load the app
RUN node -e "require('./dist/src/server.js')" || (echo "❌ Server doesn't load" && exit 1)

# Production stage
FROM node:18.19.0-alpine3.19 AS production

# Add non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy verified application
COPY --from=verify --chown=nodejs:nodejs /app /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 10000

# Health check
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s \
  CMD node -e "require('http').get('http://localhost:10000/api/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1))"

# Start command
CMD ["node", "dist/src/server.js"]
