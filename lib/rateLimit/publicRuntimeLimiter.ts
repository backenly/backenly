/**
 * Rate Limiting for Public Runtime
 * 
 * Simple in-memory rate limiter to protect the worker from abuse
 * This prevents someone from destroying the shared infrastructure
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

class PublicRuntimeLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private readonly maxRequestsPerMinute = 60; // 60 requests per minute per project
  private readonly cleanupInterval = 60000; // Clean up every minute

  constructor() {
    // Cleanup expired entries periodically
    setInterval(() => this.cleanup(), this.cleanupInterval);
  }

  /**
   * Check if request is within rate limit
   * Returns true if allowed, false if rate limit exceeded
   */
  async checkLimit(projectId: string): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
  }> {
    const now = Date.now();
    const key = `project:${projectId}`;
    const entry = this.limits.get(key);

    // No entry or expired entry - allow and create new
    if (!entry || entry.resetAt < now) {
      const resetAt = now + 60000; // Reset in 1 minute
      this.limits.set(key, {
        count: 1,
        resetAt,
      });

      return {
        allowed: true,
        remaining: this.maxRequestsPerMinute - 1,
        resetAt,
      };
    }

    // Entry exists and not expired
    if (entry.count >= this.maxRequestsPerMinute) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetAt,
      };
    }

    // Increment count
    entry.count++;
    this.limits.set(key, entry);

    return {
      allowed: true,
      remaining: this.maxRequestsPerMinute - entry.count,
      resetAt: entry.resetAt,
    };
  }

  /**
   * Clean up expired entries to prevent memory leaks
   */
  private cleanup() {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    this.limits.forEach((entry, key) => {
      if (entry.resetAt < now) {
        keysToDelete.push(key);
      }
    });
    
    keysToDelete.forEach(key => this.limits.delete(key));
  }

  /**
   * Get current stats (for monitoring)
   */
  getStats(): {
    totalProjects: number;
    activeProjects: number;
  } {
    const now = Date.now();
    const active = Array.from(this.limits.values()).filter(
      (entry) => entry.resetAt >= now
    ).length;

    return {
      totalProjects: this.limits.size,
      activeProjects: active,
    };
  }
}

// Singleton instance
export const publicRuntimeLimiter = new PublicRuntimeLimiter();
