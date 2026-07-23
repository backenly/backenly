/**
 * CANONICAL SERVER TEMPLATE
 * 
 * RULE #1: Hard-locked execution model
 * This file is NEVER modified by AI
 * Auto-overwrites any AI-generated server.ts
 */

export const EXPRESS_SERVER_TEMPLATE = `import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check (REQUIRED for deployment validation)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// DYNAMIC ROUTES INJECTION POINT
// Auto-fix will inject route imports here
__ROUTES_PLACEHOLDER__

// Error handling
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});

export default app;
`;

export const AUTH_MIDDLEWARE_TEMPLATE = `import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const PROJECT_ID = process.env.PROJECT_ID; // Cross-project isolation

export interface AuthRequest extends Request {
  user?: {
    id: number;
    email: string;
    tokenVersion: number;
  };
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    
    // CRITICAL: Cross-project isolation check
    if (PROJECT_ID && decoded.projectId !== PROJECT_ID) {
      return res.status(401).json({ error: 'Token not valid for this project' });
    }
    
    // CRITICAL: Token version validation against database
    const user = await prisma.user.findFirst({
      where: {
        id: decoded.id,
        deletedAt: null,
      },
      select: {
        tokenVersion: true,
        email: true,
      },
    });

    if (!user || user.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }
    
    req.user = {
      id: decoded.id,
      email: user.email,
      tokenVersion: user.tokenVersion
    };
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}
`;

// Enhanced auth routes template with all security features
export const AUTH_ROUTES_TEMPLATE = `import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const PROJECT_ID = process.env.PROJECT_ID; // For cross-project isolation
const JWT_EXPIRY = '30d'; // 30 days with sliding expiration

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 requests per minute
  message: 'Too many login attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3, // 3 requests per minute
  message: 'Too many registration attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const oauthLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: 'Too many OAuth requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Password policy validation
function validatePassword(password: string): { valid: boolean; message?: string } {
  if (password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long' };
  }
  if (!/[A-Za-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one letter' };
  }
  if (!/\\d/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number' };
  }
  return { valid: true };
}

// Generate JWT with security fields
function generateToken(user: any): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      tokenVersion: user.tokenVersion || 0,
      projectId: PROJECT_ID, // CRITICAL: Cross-project isolation
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

// Register endpoint
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Password policy enforcement
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.message });
    }

    // Check if user already exists (excluding soft-deleted users)
    const existingUser = await prisma.user.findFirst({
      where: {
        email,
        deletedAt: null, // Soft delete check
      },
    });

    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password — 12 rounds (OWASP 2026 floor). Was 10.
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        provider: 'email',
        tokenVersion: 0,
      },
    });

    // Generate token
    const token = generateToken(user);

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      token,
    });
  } catch (error: any) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// Login endpoint
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user (excluding soft-deleted)
    const user = await prisma.user.findFirst({
      where: {
        email,
        provider: 'email',
        deletedAt: null, // Soft delete check
      },
    });

    if (!user || !user.password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    // Generate token
    const token = generateToken(user);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      token,
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Logout endpoint (increment token version)
router.post('/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    
    // Increment tokenVersion to invalidate all existing tokens
    await prisma.user.update({
      where: { id: decoded.id },
      data: { tokenVersion: { increment: 1 } },
    });

    res.json({ message: 'Logged out successfully' });
  } catch (error: any) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

export { router };
`;

// GitHub OAuth routes template with security features
export const GITHUB_OAUTH_TEMPLATE = `import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const PROJECT_ID = process.env.PROJECT_ID;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL;

// OAuth scopes are LOCKED (never allow user to modify)
const GITHUB_SCOPES = ['user:email', 'read:user'];

const oauthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many OAuth requests',
});

function generateToken(user: any): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      tokenVersion: user.tokenVersion || 0,
      projectId: PROJECT_ID,
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// GitHub OAuth initiation
router.get('/github', oauthLimiter, (req, res) => {
  const state = Math.random().toString(36).substring(7);
  const githubAuthUrl = \`https://github.com/login/oauth/authorize?client_id=\${GITHUB_CLIENT_ID}&redirect_uri=\${GITHUB_CALLBACK_URL}&scope=\${GITHUB_SCOPES.join(' ')}&state=\${state}\`;
  
  res.redirect(githubAuthUrl);
});

// GitHub OAuth callback
router.get('/github/callback', oauthLimiter, async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'No code provided' });
    }

    // Exchange code for access token
    const tokenResponse = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      },
      {
        headers: { Accept: 'application/json' },
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // Get user info
    const userResponse = await axios.get('https://api.github.com/user', {
      headers: { Authorization: \`Bearer \${accessToken}\` },
    });

    const githubUser = userResponse.data;
    let email = githubUser.email;

    // CRITICAL: GitHub email can be NULL
    if (!email) {
      // Fallback: Fetch emails endpoint
      const emailsResponse = await axios.get('https://api.github.com/user/emails', {
        headers: { Authorization: \`Bearer \${accessToken}\` },
      });

      const emails = emailsResponse.data;
      // Find primary verified email
      const primaryEmail = emails.find((e: any) => e.primary && e.verified);
      
      if (primaryEmail) {
        email = primaryEmail.email;
      } else {
        // Fallback to any verified email
        const verifiedEmail = emails.find((e: any) => e.verified);
        if (verifiedEmail) {
          email = verifiedEmail.email;
        } else {
          return res.status(400).json({ 
            error: 'No verified email found. Please verify your email on GitHub.' 
          });
        }
      }
    }

    // Check if user exists with this providerId
    let user = await prisma.user.findFirst({
      where: {
        provider: 'github',
        providerId: String(githubUser.id),
        deletedAt: null,
      },
    });

    if (user) {
      // Update last login
      user = await prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() },
      });
    } else {
      // Check if email is already used by another provider
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
          deletedAt: null,
        },
      });

      if (existingUser) {
        // CRITICAL: Account linking safety - verify email before linking
        if (existingUser.provider !== 'github') {
          return res.status(400).json({
            error: \`Email already registered with \${existingUser.provider}. Please login with that method first.\`,
          });
        }
      }

      // Create new user
      user = await prisma.user.create({
        data: {
          email,
          name: githubUser.name || githubUser.login,
          provider: 'github',
          providerId: String(githubUser.id),
          emailVerified: true, // GitHub emails are verified
          tokenVersion: 0,
        },
      });
    }

    const token = generateToken(user);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      token,
    });
  } catch (error: any) {
    console.error('GitHub OAuth error:', error);
    res.status(500).json({ error: 'OAuth authentication failed' });
  }
});

export { router };
`;

// Google OAuth routes template with security features
export const GOOGLE_OAUTH_TEMPLATE = `import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const PROJECT_ID = process.env.PROJECT_ID;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL;

// OAuth scopes are LOCKED (never allow user to modify)
const GOOGLE_SCOPES = ['openid', 'email', 'profile'];

const oauthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many OAuth requests',
});

function generateToken(user: any): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      tokenVersion: user.tokenVersion || 0,
      projectId: PROJECT_ID,
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Google OAuth initiation
router.get('/google', oauthLimiter, (req, res) => {
  const state = Math.random().toString(36).substring(7);
  const googleAuthUrl = \`https://accounts.google.com/o/oauth2/v2/auth?client_id=\${GOOGLE_CLIENT_ID}&redirect_uri=\${GOOGLE_CALLBACK_URL}&response_type=code&scope=\${GOOGLE_SCOPES.join(' ')}&state=\${state}&access_type=offline&prompt=consent\`;
  
  res.redirect(googleAuthUrl);
});

// Google OAuth callback
router.get('/google/callback', oauthLimiter, async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'No code provided' });
    }

    // Exchange code for access token
    const tokenResponse = await axios.post(
      'https://oauth2.googleapis.com/token',
      {
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: GOOGLE_CALLBACK_URL,
      },
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // Get user info
    const userResponse = await axios.get(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: \`Bearer \${accessToken}\` },
      }
    );

    const googleUser = userResponse.data;
    const email = googleUser.email;

    // CRITICAL: Google always provides verified email
    if (!email) {
      return res.status(400).json({ 
        error: 'No email provided by Google' 
      });
    }

    // Google emails are always verified
    if (!googleUser.verified_email) {
      return res.status(400).json({ 
        error: 'Email not verified. Please verify your email with Google.' 
      });
    }

    // Check if user exists with this providerId
    let user = await prisma.user.findFirst({
      where: {
        provider: 'google',
        providerId: String(googleUser.id),
        deletedAt: null,
      },
    });

    if (user) {
      // Update last login
      user = await prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() },
      });
    } else {
      // Check if email is already used by another provider
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
          deletedAt: null,
        },
      });

      if (existingUser) {
        // CRITICAL: Account linking safety - verify email before linking
        if (existingUser.provider !== 'google') {
          return res.status(400).json({
            error: \`Email already registered with \${existingUser.provider}. Please login with that method first.\`,
          });
        }
      }

      // Create new user
      user = await prisma.user.create({
        data: {
          email,
          name: googleUser.name || googleUser.email.split('@')[0],
          provider: 'google',
          providerId: String(googleUser.id),
          emailVerified: true, // Google emails are always verified
          tokenVersion: 0,
        },
      });
    }

    const token = generateToken(user);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      token,
    });
  } catch (error: any) {
    console.error('Google OAuth error:', error);
    res.status(500).json({ error: 'OAuth authentication failed' });
  }
});

export { router };
`;

// File Upload Route Template with auto-bucket creation
export const FILE_UPLOAD_TEMPLATE = `import express, { Request, Response } from 'express';
import multer from 'multer';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = express.Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});

// Auto-create storage bucket helper
async function ensureBucketExists(bucketName: string, projectId: string) {
  try {
    // Check if bucket exists via API
    const response = await fetch(\`\${process.env.BACKENDO_API_URL || 'http://localhost:3000'}/api/storage/buckets\`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': \`Bearer \${process.env.BACKENDO_API_KEY}\`,
        'X-Project-ID': projectId,
      },
    });
    
    const { buckets } = await response.json();
    const bucketExists = buckets?.some((b: any) => b.name === bucketName);
    
    if (!bucketExists) {
      // Create bucket automatically
      const createResponse = await fetch(\`\${process.env.BACKENDO_API_URL || 'http://localhost:3000'}/api/storage/buckets\`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': \`Bearer \${process.env.BACKENDO_API_KEY}\`,
          'X-Project-ID': projectId,
        },
        body: JSON.stringify({
          name: bucketName,
          isPublic: true, // Allow public access for images
        }),
      });
      
      if (!createResponse.ok) {
        throw new Error('Failed to create storage bucket');
      }
      
      console.log(\`Created storage bucket: \${bucketName}\`);
    }
    
    return true;
  } catch (error) {
    console.error('Error ensuring bucket exists:', error);
    throw error;
  }
}

// Upload file endpoint (example: book cover upload)
router.post('/:id/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    // Validate file type
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type. Only images are allowed.' });
    }
    
    const projectId = process.env.PROJECT_ID!;
    const bucketName = 'book-covers'; // Auto-generated bucket name
    
    // Ensure bucket exists (creates automatically if needed)
    await ensureBucketExists(bucketName, projectId);
    
    // Upload file to storage
    const formData = new FormData();
    formData.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
    formData.append('bucketId', bucketName);
    
    const uploadResponse = await fetch(\`\${process.env.BACKENDO_API_URL || 'http://localhost:3000'}/api/storage/upload\`, {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${process.env.BACKENDO_API_KEY}\`,
        'X-Project-ID': projectId,
      },
      body: formData,
    });
    
    if (!uploadResponse.ok) {
      throw new Error('Failed to upload file');
    }
    
    const { file: uploadedFile } = await uploadResponse.json();
    
    // Update database record with file URL
    const updated = await prisma.book.update({
      where: { id: parseInt(id) },
      data: {
        coverImageUrl: uploadedFile.url,
      },
    });
    
    res.json({
      message: 'File uploaded successfully',
      fileUrl: uploadedFile.url,
      book: updated,
    });
  } catch (error: any) {
    console.error('File upload error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

export { router };
`;
