/**
 * ARCHITECTURE TEMPLATES
 * ======================
 * Predefined patterns for common app types.
 * Reduces AI mistakes by providing well-tested starting points.
 */

export interface ArchitectureTemplate {
  id: string
  name: string
  description: string
  appType: 'saas' | 'marketplace' | 'social' | 'blog' | 'ecommerce' | 'custom'
  triggerKeywords: string[]
  entities: string[]
  coreRelations: Array<{ from: string; to: string; type: 'FK' | 'M2M'; description: string }>
  requiredFeatures: string[]
  optionalFeatures: string[]
  businessLogicHighlights: string[]
  nestedRoutes: string[]
  /**
   * Behavioral completion flows — what an end user must be able to DO for this
   * backend to be considered "done". Used as done-criteria for the build loop and
   * as verification assertions in the flow-verifier.
   *
   * These are flow-first, not schema-first. "orders table exists" is NOT a flow.
   * "customer can place an order and receive a confirmation" IS a flow.
   */
  completionFlows: string[]
}

export const ARCHITECTURE_TEMPLATES: ArchitectureTemplate[] = [
  {
    id: 'saas',
    name: 'SaaS Platform',
    description: 'Multi-tenant SaaS with organizations, RBAC, and billing',
    appType: 'saas',
    triggerKeywords: ['saas', 'b2b', 'organization', 'team', 'workspace', 'multi-tenant', 'subscription'],
    entities: ['users', 'organizations', 'projects', 'tasks', 'activity_logs', 'notifications', 'invitations'],
    coreRelations: [
      { from: 'users', to: 'organizations', type: 'M2M', description: 'Users belong to orgs with admin/member roles' },
      { from: 'projects', to: 'organizations', type: 'FK', description: 'Projects scoped to organization' },
      { from: 'tasks', to: 'projects', type: 'FK', description: 'Tasks belong to projects' },
      { from: 'tasks', to: 'users', type: 'FK', description: 'Tasks assigned to users' },
      { from: 'notifications', to: 'users', type: 'FK', description: 'Notifications are user-specific' },
      { from: 'activity_logs', to: 'users', type: 'FK', description: 'Activity attributed to actor' },
      { from: 'invitations', to: 'organizations', type: 'FK', description: 'Invites belong to org' },
    ],
    requiredFeatures: ['auth', 'rbac', 'multi-tenant isolation', 'activity logging'],
    optionalFeatures: ['billing', 'storage', 'realtime', 'notifications'],
    businessLogicHighlights: [
      'Users must be org members to access org resources',
      'Admins can invite/remove members, members can only create',
      'All entities scoped to organization_id',
    ],
    nestedRoutes: [
      'GET /organizations/:id/members',
      'POST /organizations/:id/invite',
      'POST /tasks/:id/assign',
      'POST /tasks/:id/complete',
    ],
    completionFlows: [
      'A new user can sign up and receive a JWT token',
      'An admin can create an organization and invite members',
      'A member can only access projects and tasks within their organization',
      'An admin can assign a task to a team member and it appears in their task list',
      'An activity log entry is created whenever a user performs an action',
      'A non-member cannot read or write any organization data (permissions enforced)',
    ],
  },
  {
    id: 'marketplace',
    name: 'Marketplace',
    description: 'Two-sided marketplace with sellers, buyers, listings, and orders',
    appType: 'marketplace',
    triggerKeywords: ['marketplace', 'sellers', 'buyers', 'listings', 'gig', 'freelance', 'etsy', 'airbnb'],
    entities: ['users', 'listings', 'categories', 'orders', 'order_items', 'reviews', 'messages', 'payments'],
    coreRelations: [
      { from: 'listings', to: 'users', type: 'FK', description: 'Listings created by sellers' },
      { from: 'listings', to: 'categories', type: 'FK', description: 'Listings in categories' },
      { from: 'orders', to: 'users', type: 'FK', description: 'Orders placed by buyers' },
      { from: 'order_items', to: 'orders', type: 'FK', description: 'Items in an order' },
      { from: 'order_items', to: 'listings', type: 'FK', description: 'Items reference listings' },
      { from: 'reviews', to: 'listings', type: 'FK', description: 'Reviews for listings' },
      { from: 'reviews', to: 'users', type: 'FK', description: 'Reviews authored by users' },
    ],
    requiredFeatures: ['auth', 'storage', 'payments'],
    optionalFeatures: ['realtime chat', 'notifications', 'search'],
    businessLogicHighlights: [
      'Sellers can only edit their own listings',
      'Orders have state machine: pending → confirmed → shipped → delivered',
      'Reviews only after completed order',
    ],
    nestedRoutes: [
      'POST /orders/:id/confirm',
      'POST /orders/:id/ship',
      'GET /listings/:id/reviews',
      'POST /listings/:id/favorite',
    ],
    completionFlows: [
      'A seller can sign up, create a listing, and it is publicly visible',
      'A buyer can sign up, browse listings, and place an order',
      'An order transitions from pending → confirmed → delivered via status endpoints',
      'A seller can only edit or delete their own listings (permissions enforced)',
      'A buyer can only leave a review after their order is completed',
      'Payment via Stripe updates the order status to paid and notifies the seller',
    ],
  },
  {
    id: 'social',
    name: 'Social Network',
    description: 'Social platform with users, posts, comments, follows, and likes',
    appType: 'social',
    triggerKeywords: ['social', 'network', 'feed', 'follow', 'like', 'instagram', 'twitter', 'community'],
    entities: ['users', 'posts', 'comments', 'likes', 'followers', 'notifications', 'messages'],
    coreRelations: [
      { from: 'posts', to: 'users', type: 'FK', description: 'Posts authored by users' },
      { from: 'comments', to: 'posts', type: 'FK', description: 'Comments on posts' },
      { from: 'comments', to: 'users', type: 'FK', description: 'Comments authored by users' },
      { from: 'users', to: 'users', type: 'M2M', description: 'Users follow each other (followers junction)' },
      { from: 'users', to: 'posts', type: 'M2M', description: 'Users like posts (likes junction)' },
      { from: 'notifications', to: 'users', type: 'FK', description: 'Notifications for users' },
    ],
    requiredFeatures: ['auth', 'storage', 'realtime', 'notifications'],
    optionalFeatures: ['search', 'hashtags', 'stories', 'direct messages'],
    businessLogicHighlights: [
      'Feed built from followed users\' posts',
      'Notifications on: like, comment, follow, mention',
      'Privacy: posts can be public/private',
    ],
    nestedRoutes: [
      'GET /posts/:id/comments',
      'POST /posts/:id/like',
      'GET /users/:id/followers',
      'GET /users/:id/following',
      'POST /users/:id/follow',
    ],
    completionFlows: [
      'A user can sign up, post content, and their post appears in their profile',
      'User A can follow User B and see User B\'s posts in their feed',
      'Liking a post creates a notification for the post author',
      'A user can only edit or delete their own posts (permissions enforced)',
      'New posts appear in followers\' feeds in real-time via SSE/realtime',
      'A user can upload a profile photo via storage',
    ],
  },
  {
    id: 'ecommerce',
    name: 'E-Commerce Platform',
    description: 'Full-featured online store with products, variants, inventory, orders, cart, wishlists, coupons, reviews, payments, shipping, and notifications',
    appType: 'ecommerce',
    triggerKeywords: ['ecommerce', 'e-commerce', 'store', 'shop', 'cart', 'product', 'checkout', 'inventory', 'retail', 'selling', 'buy', 'purchase'],
    entities: [
      'users', 'categories', 'products', 'product_variants', 'product_images',
      'inventory', 'carts', 'cart_items', 'wishlists', 'wishlist_items',
      'addresses', 'coupons', 'orders', 'order_items', 'payments',
      'shipping_methods', 'reviews', 'notifications', 'activity_logs',
    ],
    coreRelations: [
      { from: 'products', to: 'categories', type: 'FK', description: 'Products in categories' },
      { from: 'product_variants', to: 'products', type: 'FK', description: 'Variants of a product (size, color)' },
      { from: 'product_images', to: 'products', type: 'FK', description: 'Product image gallery' },
      { from: 'inventory', to: 'product_variants', type: 'FK', description: 'Stock levels per variant' },
      { from: 'carts', to: 'users', type: 'FK', description: 'Cart belongs to customer' },
      { from: 'cart_items', to: 'carts', type: 'FK', description: 'Items in cart' },
      { from: 'cart_items', to: 'product_variants', type: 'FK', description: 'Cart item references variant' },
      { from: 'wishlists', to: 'users', type: 'FK', description: 'Wishlist belongs to customer' },
      { from: 'wishlist_items', to: 'wishlists', type: 'FK', description: 'Items saved in wishlist' },
      { from: 'addresses', to: 'users', type: 'FK', description: 'Saved shipping addresses' },
      { from: 'orders', to: 'users', type: 'FK', description: 'Orders placed by customers' },
      { from: 'orders', to: 'addresses', type: 'FK', description: 'Shipping address for order' },
      { from: 'orders', to: 'coupons', type: 'FK', description: 'Applied coupon/discount' },
      { from: 'order_items', to: 'orders', type: 'FK', description: 'Line items in order' },
      { from: 'order_items', to: 'product_variants', type: 'FK', description: 'Ordered variant' },
      { from: 'payments', to: 'orders', type: 'FK', description: 'Payment record for order' },
      { from: 'reviews', to: 'products', type: 'FK', description: 'Customer reviews on products' },
      { from: 'reviews', to: 'users', type: 'FK', description: 'Review authored by customer' },
      { from: 'notifications', to: 'users', type: 'FK', description: 'User-specific notifications' },
    ],
    requiredFeatures: ['auth', 'storage', 'payments', 'realtime notifications'],
    optionalFeatures: ['search', 'recommendations', 'coupons', 'email', 'analytics'],
    businessLogicHighlights: [
      'Inventory reserved on add-to-cart, decremented on payment success',
      'Reviews only allowed after a completed order',
      'Coupon usage tracked and enforced (max_uses, expiry)',
      'Order total = sum(order_items.subtotal) − discount_amount',
      'Customers can only see their own orders and cart',
      'Activity log records all key user actions for audit trail',
    ],
    nestedRoutes: [
      'GET /products/:id/variants',
      'GET /products/:id/reviews',
      'GET /products/:id/images',
      'POST /cart/checkout',
      'GET /orders/:id/items',
      'POST /orders/:id/cancel',
      'POST /coupons/:code/validate',
    ],
    completionFlows: [
      'A customer can sign up, log in, and receive a JWT token',
      'An admin can create a product with variants, images, price, and stock',
      'A customer can browse products by category and add items to cart',
      'A customer can apply a coupon code and see the discounted total',
      'Checkout creates a Stripe session; payment success updates order status to "paid" and decrements inventory',
      'Overselling is prevented — stock cannot go below zero',
      'An order confirmation notification is sent after payment succeeds',
      'A customer can leave a review only after their order is completed',
      'Permissions are enforced: customers can only see their own orders, cart, and addresses',
      'A customer can save items to a wishlist and move them to cart',
    ],
  },
  {
    id: 'blog',
    name: 'Blog / CMS',
    description: 'Content management with posts, categories, tags, and comments',
    appType: 'blog',
    triggerKeywords: ['blog', 'cms', 'content', 'article', 'publish', 'editorial', 'wordpress'],
    entities: ['users', 'posts', 'categories', 'tags', 'comments', 'post_tags'],
    coreRelations: [
      { from: 'posts', to: 'users', type: 'FK', description: 'Posts authored by users' },
      { from: 'posts', to: 'categories', type: 'FK', description: 'Posts in categories' },
      { from: 'comments', to: 'posts', type: 'FK', description: 'Comments on posts' },
      { from: 'comments', to: 'users', type: 'FK', description: 'Comments by authors' },
      { from: 'posts', to: 'tags', type: 'M2M', description: 'Posts tagged with multiple tags' },
    ],
    requiredFeatures: ['auth', 'storage'],
    optionalFeatures: ['search', 'rss feed', 'newsletters', 'analytics'],
    businessLogicHighlights: [
      'Posts have draft → published state machine',
      'Slug must be unique per post',
      'Comment moderation optional',
    ],
    nestedRoutes: [
      'GET /posts/:id/comments',
      'POST /posts/:id/publish',
      'GET /categories/:id/posts',
      'GET /tags/:id/posts',
    ],
    completionFlows: [
      'An author can sign up, create a post in draft, and publish it',
      'A published post is publicly readable without authentication',
      'An author can only edit or delete their own posts',
      'A reader can comment on a published post and the comment is stored',
      'Posts can be filtered by category and by tag',
      'An unpublished draft is only visible to its author (permissions enforced)',
    ],
  },
]

export function detectTemplateMatch(userMessage: string): ArchitectureTemplate | null {
  const msg = userMessage.toLowerCase()

  let bestMatch: ArchitectureTemplate | null = null
  let bestScore = 0

  for (const template of ARCHITECTURE_TEMPLATES) {
    let score = 0
    for (const keyword of template.triggerKeywords) {
      if (msg.includes(keyword)) score++
    }
    if (score > bestScore) {
      bestScore = score
      bestMatch = template
    }
  }

  return bestScore >= 1 ? bestMatch : null
}

export function templateToIntentHints(template: ArchitectureTemplate): {
  suggestedEntities: string[]
  mandatoryRelations: string[]
  warnings: string[]
} {
  return {
    suggestedEntities: template.entities,
    mandatoryRelations: template.coreRelations.map(r => `${r.from} → ${r.to} (${r.type}): ${r.description}`),
    warnings: template.businessLogicHighlights.map(h => `⚠️ ${h}`),
  }
}

export function formatTemplateMatch(template: ArchitectureTemplate): string {
  return `Detected **${template.name}** pattern — using ${template.entities.length}-entity architecture with ${template.requiredFeatures.join(', ')}.`
}
