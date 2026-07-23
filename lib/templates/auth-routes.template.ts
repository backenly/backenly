/**
 * Auto-generated Auth Routes
 * 
 * POST /auth/register - Register new user
 * POST /auth/login - Login existing user
 * 
 * These routes are automatically created when Auth is enabled.
 */

import { Request, Response } from 'express';

interface RegisterBody {
  email: string;
  password: string;
  name?: string;
}

interface LoginBody {
  email: string;
  password: string;
}

/**
 * Register endpoint - POST /auth/register
 * 
 * 🚨 SECURITY: Rate limited to prevent abuse
 */
export async function register(req: Request, res: Response) {
  try {
    const { email, password, name } = req.body as RegisterBody;
    
    // Validation
    if (!email || !password) {
      return res.status(400).json({
        error: 'EMAIL_AND_PASSWORD_REQUIRED',
        message: 'Email and password are required'
      });
    }
    
    // 🚨 RATE LIMITING: Check email-based rate limit
    const { checkRateLimit, getEmailRateLimitKey, RATE_LIMITS } = require('@/lib/middleware/authRateLimit');
    const emailKey = getEmailRateLimitKey(email, 'register');
    const emailLimit = checkRateLimit(emailKey, RATE_LIMITS.auth.maxRequests, RATE_LIMITS.auth.windowMs);
    
    if (!emailLimit.allowed) {
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: `Too many registration attempts. Try again in ${emailLimit.retryAfter} seconds`,
        retryAfter: emailLimit.retryAfter
      });
    }
    
    // 🚨 RATE LIMITING: Check IP-based rate limit
    const clientIP = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const ipKey = require('@/lib/middleware/authRateLimit').getIPRateLimitKey(clientIP, 'register');
    const ipLimit = checkRateLimit(ipKey, RATE_LIMITS.authPerIP.maxRequests, RATE_LIMITS.authPerIP.windowMs);
    
    if (!ipLimit.allowed) {
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: `Too many requests from this IP. Try again in ${ipLimit.retryAfter} seconds`,
        retryAfter: ipLimit.retryAfter
      });
    }
    
    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'INVALID_EMAIL',
        message: 'Invalid email format'
      });
    }
    
    // Password strength validation is handled by workspaceAuth service
    
    // Import auth service
    const { registerUser } = require('@/lib/services/workspaceAuth');
    const projectId = process.env.PROJECT_ID || req.headers['x-project-id'];
    
    if (!projectId) {
      return res.status(500).json({
        error: 'PROJECT_ID_MISSING',
        message: 'Project ID not configured'
      });
    }
    
    // Register user
    const result = await registerUser(projectId as string, {
      email,
      password,
      name
    });
    
    if (!result.success) {
      return res.status(400).json({
        error: 'REGISTRATION_FAILED',
        message: result.error || 'Registration failed'
      });
    }
    
    return res.status(201).json({
      message: 'User registered successfully',
      token: result.token,
      user: result.user
    });
  } catch (error: any) {
    console.error('Register error:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An error occurred during registration'
    });
  }
}

/**
 * Login endpoint - POST /auth/login
 * 
 * 🚨 SECURITY: Rate limited to prevent brute-force attacks
 */
export async function login(req: Request, res: Response) {
  try {
    const { email, password } = req.body as LoginBody;
    
    // Validation
    if (!email || !password) {
      return res.status(400).json({
        error: 'EMAIL_AND_PASSWORD_REQUIRED',
        message: 'Email and password are required'
      });
    }
    
    // 🚨 RATE LIMITING: Check email-based rate limit (stricter for login)
    const { checkRateLimit, getEmailRateLimitKey, RATE_LIMITS } = require('@/lib/middleware/authRateLimit');
    const emailKey = getEmailRateLimitKey(email, 'login');
    const emailLimit = checkRateLimit(emailKey, RATE_LIMITS.auth.maxRequests, RATE_LIMITS.auth.windowMs);
    
    if (!emailLimit.allowed) {
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: `Too many login attempts. Try again in ${emailLimit.retryAfter} seconds`,
        retryAfter: emailLimit.retryAfter
      });
    }
    
    // 🚨 RATE LIMITING: Check IP-based rate limit
    const clientIP = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const ipKey = require('@/lib/middleware/authRateLimit').getIPRateLimitKey(clientIP, 'login');
    const ipLimit = checkRateLimit(ipKey, RATE_LIMITS.authPerIP.maxRequests, RATE_LIMITS.authPerIP.windowMs);
    
    if (!ipLimit.allowed) {
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: `Too many requests from this IP. Try again in ${ipLimit.retryAfter} seconds`,
        retryAfter: ipLimit.retryAfter
      });
    }
    
    // Import auth service
    const { loginUser } = require('@/lib/services/workspaceAuth');
    const projectId = process.env.PROJECT_ID || req.headers['x-project-id'];
    
    if (!projectId) {
      return res.status(500).json({
        error: 'PROJECT_ID_MISSING',
        message: 'Project ID not configured'
      });
    }
    
    // Login user
    const result = await loginUser(projectId as string, {
      email,
      password
    });
    
    if (!result.success) {
      return res.status(401).json({
        error: 'AUTHENTICATION_FAILED',
        message: result.error || 'Invalid credentials'
      });
    }
    
    return res.status(200).json({
      message: 'Login successful',
      token: result.token,
      user: result.user
    });
  } catch (error: any) {
    console.error('Login error:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An error occurred during login'
    });
  }
}

// Export handlers for Express
export default {
  register,
  login
};
