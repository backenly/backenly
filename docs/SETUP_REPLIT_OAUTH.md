# Setup Replit OAuth for One-Click Connection

This guide shows how to configure Replit OAuth so users can connect their Replit projects with one click.

## Prerequisites

- A Backenly account with admin access
- A Replit account

## Step 1: Create Replit OAuth Application

1. Go to https://replit.com/account/oauth-applications
2. Click **"Create OAuth App"**
3. Fill in the details:
   - **Name**: `Backenly`
   - **Description**: `Connect your Replit project to Backenly backend`
   - **Homepage URL**: `https://backenly.com` (or your domain)
   - **Callback URL**: `https://backenly.com/api/auth/replit/callback`
   - **Scopes**: Select:
     - ✅ `identity` (to identify the user)
     - ✅ `repl.read` (to read Repl information)
     - ✅ `repl.write` (to inject environment variables)

4. Click **"Create Application"**

5. You'll see:
   - **Client ID**: `xxxxxxxxxxxxxxxx`
   - **Client Secret**: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

⚠️ **Keep the Client Secret safe!** Never commit it to version control.

## Step 2: Add Credentials to Environment Variables

Add these to your `.env` file (NOT `.env.example`):

```bash
# Replit OAuth (for one-click Replit connection)
REPLIT_CLIENT_ID=your-actual-client-id-from-replit
REPLIT_CLIENT_SECRET=your-actual-client-secret-from-replit
```

Replace `your-actual-client-id-from-replit` and `your-actual-client-secret-from-replit` with the values from Step 1.

## Step 3: Update Database Schema

Run the Prisma migration to add the metadata field to delegated connections:

```bash
npx prisma generate
npx prisma db push
```

## Step 4: Restart Your Application

```bash
npm run dev
# or in production:
npm run build && npm start
```

## Step 5: Test the Connection

1. Create a test project in Backenly
2. Navigate to the project page
3. Click on "Use your backend in your app" or go to `/app/projects/{projectId}/connect`
4. Click **"Connect"** on the Replit card
5. You should be redirected to Replit OAuth approval page
6. Click **"Authorize"**
7. You should be redirected back to Backenly
8. Connection status should show **"Connected"**

## Production Deployment

### For Vercel

1. Go to your Vercel project settings
2. Navigate to **Environment Variables**
3. Add:
   - `REPLIT_CLIENT_ID` = `your-client-id`
   - `REPLIT_CLIENT_SECRET` = `your-client-secret`
4. Redeploy your application

### For Other Platforms

Set the environment variables according to your platform's documentation:

- **Railway**: Settings → Variables
- **Fly.io**: `fly secrets set REPLIT_CLIENT_ID=xxx`
- **Docker**: Pass via `-e` flag or env file
- **Heroku**: Settings → Config Vars

## Security Best Practices

✅ **DO:**
- Store Client Secret in environment variables only
- Use HTTPS in production
- Rotate Client Secret periodically (every 6-12 months)
- Monitor OAuth audit logs for suspicious activity
- Set token expiry to 30 days maximum

❌ **DON'T:**
- Commit Client Secret to git
- Expose Client Secret in client-side code
- Share Client Secret publicly
- Use the same credentials for dev and production

## Troubleshooting

### "Missing REPLIT_CLIENT_ID or REPLIT_CLIENT_SECRET"

**Problem**: Environment variables not set correctly.

**Solution**: 
1. Check `.env` file exists and has both variables
2. Restart your application
3. Verify with: `echo $REPLIT_CLIENT_ID` (should not be empty)

### "Redirect URI mismatch"

**Problem**: Callback URL in Replit OAuth app doesn't match your actual URL.

**Solution**:
1. Go to https://replit.com/account/oauth-applications
2. Edit your OAuth app
3. Update **Callback URL** to match exactly:
   - Dev: `http://localhost:3000/api/auth/replit/callback`
   - Prod: `https://yourdomain.com/api/auth/replit/callback`

### "State verification failed"

**Problem**: Cookie not being set or cleared.

**Solution**:
1. Clear browser cookies for your domain
2. Try in incognito mode
3. Check `sameSite` cookie settings if using different domains

### Connection shows "Expired"

**Problem**: Token expired after 30 days.

**Solution**: Users need to reconnect. This is by design for security.

## Need Help?

- **Documentation**: https://backenly.com/docs
- **Support**: support@backenly.com
- **Discord**: https://discord.gg/backenly
