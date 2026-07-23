# One-Click Replit Connection

Connect your Replit project to Backenly in seconds. No SDKs, no environment variables, no technical setup.

## For Users (Non-Technical)

### How to Connect

1. **Click "Connect Replit"** on your Backenly project page
2. **Approve access** when Replit asks (one time only)
3. **Done!** Your frontend is now connected to Backenly

That's it. Your backend is now managed by Backenly.

### What Happens Automatically

- ✅ Your frontend automatically talks to Backenly backend
- ✅ User authentication works instantly
- ✅ Database queries work without setup
- ✅ File uploads work automatically

### Safety

- You can revoke access anytime
- Your Replit code stays under your control
- Nothing breaks if you disconnect

---

## For Developers (Technical Details)

### OAuth Flow

1. User clicks "Connect Replit"
2. Redirects to `/api/auth/replit?projectId=xxx`
3. Redirects to Replit OAuth authorize page
4. User approves once
5. Replit redirects to `/api/auth/replit/callback`
6. Backend exchanges code for access token
7. Auto-injects Backenly configuration into Replit project

### Auto-Injected Configuration

When you connect, Backenly automatically adds these environment variables to your Replit project:

```bash
NEXT_PUBLIC_BACKENLY_PROJECT_ID=your-project-id
NEXT_PUBLIC_BACKENLY_API_URL=https://backenly.app
BACKENLY_DELEGATION_TOKEN=del_xxxxxxxxxxxxx
```

### Using Backenly in Your Replit App

The Backenly SDK is automatically available. Just use it:

```javascript
// Sign up a new user
await backenly.signUp('user@example.com', 'password123')

// Sign in
await backenly.signIn('user@example.com', 'password123')

// Query data
const posts = await backenly.query('posts', {
  where: { published: true },
  orderBy: { createdAt: 'desc' },
  limit: 10
})

// Create data
const newPost = await backenly.create('posts', {
  title: 'My First Post',
  content: 'Hello world!',
  published: true
})

// Update data
await backenly.update('posts', postId, {
  title: 'Updated Title'
})

// Delete data
await backenly.delete('posts', postId)

// Upload file
const file = document.querySelector('input[type="file"]').files[0]
const result = await backenly.uploadFile(file, 'uploads/')
```

### Manual SDK Installation (Optional)

If auto-injection doesn't work, you can manually include the SDK:

```html
<script src="https://backenly.app/backenly-sdk.js"></script>
<script>
  // SDK is automatically available as window.backenly
  backenly.signIn('user@example.com', 'password')
</script>
```

Or with npm/yarn:

```bash
npm install @backenly/sdk
# or
yarn add @backenly/sdk
```

```javascript
import backenly from '@backenly/sdk'

// Use it anywhere
await backenly.query('users')
```

### API Reference

See full API documentation at: https://backenly.app/docs

### Security

- OAuth tokens are encrypted at rest
- Delegation tokens expire after 30 days
- All API requests use HTTPS
- Rate limiting prevents abuse
- Tokens can be revoked instantly

### Troubleshooting

**SDK not found?**
- Refresh your Replit page
- Check environment variables are set
- Manually include SDK script tag

**Connection expired?**
- Reconnect on Backenly dashboard
- Tokens expire after 30 days

**Permission errors?**
- Check you're signed in: `await backenly.getCurrentUser()`
- Make sure user has permission to access resource

### Support

Questions? Email support@backenly.app
