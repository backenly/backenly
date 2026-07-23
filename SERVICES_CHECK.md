# Services Status Check

This document helps you verify that PostgreSQL, MongoDB, and OpenAI API are properly configured and working.

## Quick Test

Visit this endpoint to check all services:
```
http://localhost:3000/api/test-services
```

This will show you:
- ✅ PostgreSQL connection status
- ✅ MongoDB connection status (optional)
- ✅ OpenAI API status
- Environment variable validation
- Detailed error messages if something fails

## Prerequisites

### 1. Generate Prisma Client

**Important:** Before testing PostgreSQL, you must generate Prisma Client:

```bash
# Stop your dev server first (Ctrl+C)
npm run db:generate
```

If you get a permission error, close your dev server completely and try again.

### 2. Environment Variables

Make sure your `.env` file has the correct format:

#### PostgreSQL (Required)
```env
DATABASE_URL="postgresql://username:password@host:port/database?sslmode=require"
```

**Common Issues:**
- ❌ Missing `postgresql://` prefix
- ❌ Missing quotes around the string
- ❌ Wrong password or expired credentials
- ❌ Missing `?sslmode=require` when the database requires TLS

**Example (Postgres on the same host as the app):**
```env
DATABASE_URL="postgresql://backenly_user:<password>@localhost:5432/backenly"
```

> Never paste a real connection string into a tracked file. `scripts/preflight-oss.ts`
> fails the build if one appears.

#### MongoDB (Optional)
```env
MONGODB_URI="mongodb://localhost:27017/backenly"
# OR for MongoDB Atlas:
MONGODB_URI="mongodb+srv://username:password@cluster.mongodb.net/backenly"
```

**Common Issues:**
- ❌ Missing `mongodb://` or `mongodb+srv://` prefix
- ❌ Invalid connection string format

#### OpenAI API (Optional)
```env
OPENAI_API_KEY="sk-your-api-key-here"
ENABLE_AI_FEATURES=true
```

**Common Issues:**
- ❌ API key not set
- ❌ `ENABLE_AI_FEATURES` not set to `"true"`

## Testing Each Service

### Test PostgreSQL

1. **Check Prisma Client is generated:**
   ```bash
   npm run db:generate
   ```

2. **Test connection:**
   ```bash
   npx prisma db pull
   ```
   This will show your database schema if connected, or an error if not.

3. **Check via API:**
   Visit: `http://localhost:3000/api/test-services`

### Test MongoDB

1. **If using local MongoDB:**
   Make sure MongoDB is running:
   ```bash
   # Check if MongoDB is running (Windows)
   # Or use Docker:
   docker run -p 27017:27017 mongo:6
   ```

2. **Check via API:**
   Visit: `http://localhost:3000/api/test-services`

### Test OpenAI

1. **Get API key:**
   - Visit: https://platform.openai.com/api-keys
   - Create a new API key
   - Add it to your `.env` file

2. **Enable AI features:**
   ```env
   ENABLE_AI_FEATURES=true
   ```

3. **Check via API:**
   Visit: `http://localhost:3000/api/test-services`

## Troubleshooting

### PostgreSQL Issues

**Error: "the URL must start with the protocol 'postgresql://'"**
- ✅ Make sure your `DATABASE_URL` starts with `postgresql://` (not just `postgres://`)
- ✅ Check for extra spaces or missing quotes

**Error: "Cannot reach database server"**
- ✅ Check your internet connection
- ✅ Verify the host/port in your connection string
- ✅ Check if your Neon database is active (not paused)

**Error: "Authentication failed"**
- ✅ Verify your password is correct
- ✅ Reset password in Neon.tech dashboard if needed
- ✅ URL-encode special characters in password

### MongoDB Issues

**Error: "Invalid scheme, expected connection string to start with 'mongodb://'"**
- ✅ Make sure `MONGODB_URI` starts with `mongodb://` or `mongodb+srv://`
- ✅ Check for typos in the connection string

**Error: "Connection refused"**
- ✅ Make sure MongoDB is running (if local)
- ✅ Check firewall settings
- ✅ Verify the host/port

### OpenAI Issues

**Error: "OPENAI_API_KEY is not set"**
- ✅ Add `OPENAI_API_KEY` to your `.env` file
- ✅ Make sure `ENABLE_AI_FEATURES=true`

**Error: "API key invalid"**
- ✅ Verify your API key is correct
- ✅ Check if you have credits in your OpenAI account
- ✅ Make sure the key hasn't been revoked

## Health Check Endpoint

The basic health check endpoint:
```
http://localhost:3000/api/health
```

Shows simple connection status.

## Comprehensive Test Endpoint

The detailed test endpoint:
```
http://localhost:3000/api/test-services
```

Shows:
- Detailed connection status for each service
- Environment variable validation
- Specific error messages
- Summary of what's working

## Next Steps

Once all services are working:

1. **Push Prisma schema to database:**
   ```bash
   npm run db:push
   ```

2. **View your database:**
   ```bash
   npm run db:studio
   ```

3. **Start building features!** 🚀

