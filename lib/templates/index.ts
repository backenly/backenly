/**
 * Pre-built Backend Templates
 * 
 * 10 ready-to-use templates designed for common SaaS use cases
 */

export interface BackendTemplate {
  id: string
  name: string
  description: string
  category: 'saas' | 'marketplace' | 'social' | 'content' | 'analytics'
  prompt: string
  icon: string
  tags: string[]
}

export const BACKEND_TEMPLATES: BackendTemplate[] = [
  {
    id: 'saas-billing',
    name: 'SaaS with Billing',
    description: 'User accounts, subscription plans, payment tracking, and usage limits',
    category: 'saas',
    prompt: 'Build a SaaS backend with users, subscription plans (free/pro/enterprise), payment tracking with Stripe, usage quotas, and billing history. Include auth with email/password and OAuth.',
    icon: '💳',
    tags: ['users', 'billing', 'subscriptions', 'stripe', 'auth'],
  },
  {
    id: 'marketplace',
    name: 'Marketplace Platform',
    description: 'Sellers, products, orders, reviews, and search functionality',
    category: 'marketplace',
    prompt: 'Create a marketplace backend like Airbnb with sellers, products, bookings/orders, reviews, search with filters, messaging between buyers and sellers, and payment escrow tracking.',
    icon: '🏪',
    tags: ['marketplace', 'products', 'orders', 'reviews', 'search'],
  },
  {
    id: 'social-feed',
    name: 'Social Platform',
    description: 'User profiles, posts, likes, comments, and followers',
    category: 'social',
    prompt: 'Build a social media backend with user profiles, posts/feed, likes, comments, followers/following relationships, notifications, and hashtag search.',
    icon: '📱',
    tags: ['social', 'posts', 'likes', 'comments', 'followers'],
  },
  {
    id: 'video-platform',
    name: 'Video Generation SaaS',
    description: 'AI video creation with credits, uploads, and render queue',
    category: 'saas',
    prompt: 'Build a SaaS for AI video generation with users, credit system, video uploads to storage, render queue/jobs, video library with metadata, and webhook notifications when renders complete.',
    icon: '🎬',
    tags: ['video', 'ai', 'credits', 'storage', 'queue'],
  },
  {
    id: 'fitness-tracker',
    name: 'Fitness Tracker',
    description: 'Workouts, exercises, progress tracking, and social features',
    category: 'social',
    prompt: 'Create a fitness app backend with users, workouts, exercises, progress tracking with charts, personal records, social feed for sharing workouts, and challenges/leaderboards.',
    icon: '💪',
    tags: ['fitness', 'workouts', 'tracking', 'social', 'leaderboard'],
  },
  {
    id: 'blog-cms',
    name: 'Blog & CMS',
    description: 'Articles, categories, tags, comments, and media management',
    category: 'content',
    prompt: 'Build a blogging platform backend with posts/articles, categories, tags, comments with moderation, media library for images, SEO metadata, and draft/published status.',
    icon: '📝',
    tags: ['blog', 'cms', 'articles', 'comments', 'media'],
  },
  {
    id: 'ecommerce',
    name: 'E-Commerce Store',
    description: 'Products, cart, checkout, orders, and inventory management',
    category: 'marketplace',
    prompt: 'Create an e-commerce backend with products, variants (size/color), cart management, checkout flow, orders, payment tracking, shipping info, and inventory management with low-stock alerts.',
    icon: '🛒',
    tags: ['ecommerce', 'products', 'cart', 'orders', 'inventory'],
  },
  {
    id: 'team-todo',
    name: 'Team Task Manager',
    description: 'Projects, tasks, assignments, comments, and team collaboration',
    category: 'saas',
    prompt: 'Build a team task management backend with workspaces, projects, tasks with status/priority, assignments to team members, comments, file attachments, and activity logs.',
    icon: '✅',
    tags: ['tasks', 'projects', 'teams', 'collaboration'],
  },
  {
    id: 'chat-app',
    name: 'Chat Application',
    description: 'Real-time messaging, channels, direct messages, and presence',
    category: 'social',
    prompt: 'Create a chat app backend with users, channels/groups, direct messages, message history, read receipts, typing indicators, file sharing, and user presence (online/offline).',
    icon: '💬',
    tags: ['chat', 'messaging', 'real-time', 'channels'],
  },
  {
    id: 'analytics',
    name: 'Analytics Dashboard',
    description: 'Event tracking, metrics, charts, and reporting',
    category: 'analytics',
    prompt: 'Build an analytics backend with event tracking, custom metrics, time-series data storage, aggregations by day/week/month, user segments, funnels, and exportable reports.',
    icon: '📊',
    tags: ['analytics', 'events', 'metrics', 'reporting', 'charts'],
  },
]

/**
 * Get template by ID
 */
export function getTemplateById(id: string): BackendTemplate | undefined {
  return BACKEND_TEMPLATES.find(t => t.id === id)
}

/**
 * Get templates by category
 */
export function getTemplatesByCategory(category: BackendTemplate['category']): BackendTemplate[] {
  return BACKEND_TEMPLATES.filter(t => t.category === category)
}

/**
 * Search templates by keyword
 */
export function searchTemplates(query: string): BackendTemplate[] {
  const lowerQuery = query.toLowerCase()
  return BACKEND_TEMPLATES.filter(t =>
    t.name.toLowerCase().includes(lowerQuery) ||
    t.description.toLowerCase().includes(lowerQuery) ||
    t.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
  )
}
