# OAuth Setup Guide for Backenly

## ✅ Working OAuth Authentication

Backenly now supports **Google** and **GitHub** OAuth authentication!

---

## 🔧 Setup Instructions

### 1. Google OAuth Setup

#### Create OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable **Google+ API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Configure consent screen if prompted
6. Select **Web application**
7. Add authorized redirect URIs:
   - `http://localhost:3000/api/auth/google/callback` (development)
   - `https://yourdomain.com/api/auth/google/callback` (production)
8. Copy the **Client ID** and **Client Secret**

#### Add to .env

```bash
# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
```

---

### 2. GitHub OAuth Setup

#### Create OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **New OAuth App**
3. Fill in details:
   - **Application name**: Backenly
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/api/auth/github/callback`
4. Click **Register application**
5. Copy the **Client ID**
6. Click **Generate a new client secret** and copy it

#### Add to .env

```bash
# GitHub OAuth
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GITHUB_REDIRECT_URI=http://localhost:3000/api/auth/github/callback
```

---

### 3. General Configuration

Add these to your `.env` file:

```bash
# App URL (change in production)
NEXT_PUBLIC_APP_URL=http://localhost:3000

# JWT Secret (CHANGE THIS!)
JWT_SECRET=your-super-secret-jwt-key-change-me-in-production
```

---

## 📝 Database Schema Updates

The User table needs OAuth fields. Add these to your Prisma schema:

```prisma
model User {
  id            String    @id @default(cuid())
  email         String    @unique
  name          String?
  password      String?   // Optional for OAuth users
  emailVerified Boolean   @default(false)
  
  // OAuth fields
  provider      String?   // 'google', 'github', or 'email'
  providerId    String?   // OAuth provider's user ID
  
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  
  @@index([email])
  @@index([provider, providerId])
}
```

Run migration:
```bash
npx prisma migrate dev --name add-oauth-fields
```

---

## 🚀 Testing

1. Start your development server:
   ```bash
   npm run dev
   ```

2. Navigate to `http://localhost:3000/auth/login`

3. Click **"Continue with Google"** or **"Continue with GitHub"**

4. You should be redirected to the OAuth provider

5. After authorization, you'll be redirected back and logged in!

---

## 🔒 Security Notes

- **Never commit** OAuth secrets to version control
- Use different credentials for development and production
- Set `secure: true` for cookies in production
- Ensure HTTPS in production
- Rotate secrets regularly

---

## 🐛 Troubleshooting

### Redirect URI Mismatch
- Ensure the callback URL in your `.env` matches exactly what's configured in Google/GitHub

### "OAuth not configured" error
- Check that `GOOGLE_CLIENT_ID` and `GITHUB_CLIENT_ID` are set in `.env`
- Restart your dev server after changing `.env`

### User creation fails
- Ensure Prisma schema has `provider` and `providerId` fields
- Run `npx prisma generate` after schema changes

### Token issues
- Make sure `JWT_SECRET` is set
- Check cookie settings (httpOnly, secure, sameSite)

---

## ✨ Features

✅ **Google OAuth** - Fast, secure login with Google accounts  
✅ **GitHub OAuth** - Developer-friendly authentication  
✅ **Email/Password** - Traditional signup still available  
✅ **Automatic user creation** - OAuth users created on first login  
✅ **Email verification bypass** - OAuth emails are pre-verified  
✅ **Secure JWT tokens** - 7-day expiration with httpOnly cookies  

---

## 📚 API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/auth/google` | Initiate Google OAuth |
| `GET /api/auth/google/callback` | Google OAuth callback |
| `GET /api/auth/github` | Initiate GitHub OAuth |
| `GET /api/auth/github/callback` | GitHub OAuth callback |
| `POST /api/auth/register` | Email/password signup |
| `POST /api/auth/login` | Email/password login |
| `POST /api/auth/logout` | Logout (clear cookie) |
| `GET /api/auth/me` | Get current user |

---

Happy coding! 🎉
