/**
 * GOAL UNDERSTANDING ENGINE (GUE)
 * ================================
 * Converts a high-level product description into a comprehensive ProductBlueprint
 * covering ALL backend dimensions BEFORE execution starts.
 *
 * This is the layer that makes Backenly feel like an autonomous backend product
 * engineer rather than a CRUD generator. When the user says:
 *
 *   "Build me a marketplace for handmade products"
 *
 * ...the GUE infers — without being asked — schema, auth, storage, integrations,
 * realtime channels, serverless functions, permission policies, and production
 * requirements.
 *
 * Two paths:
 *   Fast  : Template match → blueprint in < 5ms  (covers ~90% of use cases)
 *   LLM   : Novel products → blueprint in < 3s   (fallback for unknown domains)
 */

import { getOpenAIClient } from './openai-service'
import { getModel } from './model-router'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BlueprintEntity {
  name: string
  purpose: string
  keyFields: string[]
  ownerScoped: boolean
  stateColumn?: string
  states?: string[]
}

export interface BlueprintBucket {
  name: string
  purpose: string
  isPublic: boolean
}

export interface BlueprintIntegration {
  name: string
  purpose: string
  required: boolean
  credentialKey: string
}

export interface BlueprintFunction {
  name: string
  trigger: string
  table?: string
  purpose: string
}

export interface ProductBlueprint {
  productType: string
  oneLiner: string
  actors: string[]
  coreValueExchange: string
  entities: BlueprintEntity[]
  authRoles: string[]
  authProviders: string[]
  storageBuckets: BlueprintBucket[]
  integrations: BlueprintIntegration[]
  realtimeChannels: string[]
  functions: BlueprintFunction[]
  permissions: string[]
  productionChecks: string[]
  planSummary: string
}

// ── Domain Profiles (fast-path templates) ────────────────────────────────────

interface DomainProfile {
  productType: string
  oneLiner: string
  actors: string[]
  coreValueExchange: string
  entities: Array<{ name: string; purpose: string; keyFields: string[]; ownerScoped: boolean; stateColumn?: string; states?: string[] }>
  authRoles: string[]
  authProviders: string[]
  storageBuckets: Array<{ name: string; purpose: string; isPublic: boolean }>
  integrations: Array<{ name: string; purpose: string; required: boolean; credentialKey: string }>
  realtimeChannels: string[]
  functions: Array<{ name: string; trigger: string; table?: string; purpose: string }>
  permissions: string[]
  productionChecks: string[]
}

const DOMAIN_PROFILES: Record<string, DomainProfile> = {
  marketplace: {
    productType: 'marketplace',
    oneLiner: 'Two-sided marketplace connecting buyers and sellers',
    actors: ['buyers', 'sellers', 'admin'],
    coreValueExchange: 'Sellers list products or services; buyers discover and purchase them',
    entities: [
      { name: 'users', purpose: 'Platform accounts for all user types', keyFields: ['email', 'role', 'name', 'avatar_url'], ownerScoped: false },
      { name: 'stores', purpose: 'Seller storefronts with branding and profile', keyFields: ['seller_id', 'name', 'description', 'banner_url', 'is_verified'], ownerScoped: true },
      { name: 'categories', purpose: 'Product taxonomy for discovery', keyFields: ['name', 'slug', 'parent_id', 'icon'], ownerScoped: false },
      { name: 'products', purpose: 'Items listed for sale', keyFields: ['store_id', 'category_id', 'title', 'description', 'price', 'stock', 'status'], ownerScoped: true, stateColumn: 'status', states: ['draft', 'active', 'sold_out', 'archived'] },
      { name: 'product_images', purpose: 'Product photo gallery', keyFields: ['product_id', 'url', 'position', 'is_primary'], ownerScoped: true },
      { name: 'carts', purpose: 'Buyer shopping cart', keyFields: ['buyer_id', 'updated_at'], ownerScoped: true },
      { name: 'cart_items', purpose: 'Items in buyer cart', keyFields: ['cart_id', 'product_id', 'quantity', 'price_at_add'], ownerScoped: true },
      { name: 'orders', purpose: 'Purchase transactions', keyFields: ['buyer_id', 'store_id', 'total', 'status', 'stripe_payment_intent_id'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'] },
      { name: 'order_items', purpose: 'Line items within an order', keyFields: ['order_id', 'product_id', 'quantity', 'unit_price', 'subtotal'], ownerScoped: true },
      { name: 'reviews', purpose: 'Post-purchase buyer reviews', keyFields: ['order_id', 'product_id', 'reviewer_id', 'rating', 'body'], ownerScoped: true },
      { name: 'messages', purpose: 'Buyer-seller direct messaging', keyFields: ['sender_id', 'recipient_id', 'order_id', 'body', 'read_at'], ownerScoped: true },
      { name: 'payouts', purpose: 'Seller earnings and payout schedule', keyFields: ['seller_id', 'amount', 'status', 'stripe_transfer_id', 'paid_at'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'processing', 'completed', 'failed'] },
      { name: 'notifications', purpose: 'In-app alerts for all events', keyFields: ['user_id', 'type', 'title', 'body', 'read_at', 'reference_id'], ownerScoped: true },
    ],
    authRoles: ['buyer', 'seller', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'product-images', purpose: 'Product listing photos', isPublic: true },
      { name: 'store-banners', purpose: 'Seller storefront banners and logos', isPublic: true },
      { name: 'user-avatars', purpose: 'User profile photos', isPublic: true },
      { name: 'delivery-files', purpose: 'Digital product downloads (private)', isPublic: false },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Payment processing and seller payouts via Stripe Connect', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Order confirmations, shipping updates, seller notifications', required: false, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['messages', 'orders', 'notifications'],
    functions: [
      { name: 'checkout_flow', trigger: 'webhook', table: 'orders', purpose: 'Handle Stripe payment confirmation and update order status' },
      { name: 'seller_payout', trigger: 'cron', purpose: 'Weekly payout calculation and Stripe Connect transfer initiation' },
      { name: 'order_notification', trigger: 'on_insert', table: 'orders', purpose: 'Notify seller of new order and buyer of confirmation' },
      { name: 'inventory_sync', trigger: 'on_update', table: 'order_items', purpose: 'Decrement product stock on order paid' },
    ],
    permissions: [
      'Sellers can only read/write their own stores and products',
      'Buyers can only read/write their own cart, orders, and reviews',
      'Reviews can only be created after a completed order by that buyer',
      'Public can browse products and stores without authentication',
      'Admins can access and moderate all resources',
    ],
    productionChecks: [
      'Indexes on products.store_id, orders.buyer_id, orders.store_id, order_items.order_id',
      'Webhook idempotency via stripe_payment_intent_id uniqueness check',
      'Inventory cannot go below zero (check constraint)',
      'Order total must equal sum of order_items.subtotal (trigger validation)',
      'Rate limit on checkout: 5 per user per minute',
    ],
  },

  freelance_marketplace: {
    productType: 'freelance_marketplace',
    oneLiner: 'Freelancer platform where clients hire skilled professionals',
    actors: ['freelancers', 'clients', 'admin'],
    coreValueExchange: 'Freelancers list their services; clients hire and pay via milestone-based escrow',
    entities: [
      { name: 'users', purpose: 'All platform accounts', keyFields: ['email', 'role', 'name', 'avatar_url', 'bio'], ownerScoped: false },
      { name: 'freelancer_profiles', purpose: 'Detailed freelancer skill profiles', keyFields: ['user_id', 'hourly_rate', 'title', 'skills', 'portfolio_urls', 'is_verified'], ownerScoped: true },
      { name: 'categories', purpose: 'Skill and service categories', keyFields: ['name', 'slug', 'parent_id'], ownerScoped: false },
      { name: 'gig_listings', purpose: 'Services offered by freelancers', keyFields: ['freelancer_id', 'category_id', 'title', 'description', 'starting_price', 'status'], ownerScoped: true, stateColumn: 'status', states: ['draft', 'active', 'paused', 'archived'] },
      { name: 'gig_packages', purpose: 'Pricing tiers for a gig (basic/standard/premium)', keyFields: ['gig_id', 'tier', 'name', 'description', 'price', 'delivery_days', 'revisions'], ownerScoped: true },
      { name: 'orders', purpose: 'Contracted work between client and freelancer', keyFields: ['client_id', 'freelancer_id', 'gig_id', 'package_id', 'total', 'status', 'due_date'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'active', 'delivered', 'revision_requested', 'completed', 'cancelled', 'disputed'] },
      { name: 'deliverables', purpose: 'Work files submitted by freelancer', keyFields: ['order_id', 'title', 'file_url', 'message', 'submitted_at'], ownerScoped: true },
      { name: 'reviews', purpose: 'Mutual reviews after order completion', keyFields: ['order_id', 'reviewer_id', 'reviewee_id', 'rating', 'body', 'is_public'], ownerScoped: true },
      { name: 'messages', purpose: 'Negotiation and project communication', keyFields: ['sender_id', 'recipient_id', 'order_id', 'body', 'read_at', 'attachment_url'], ownerScoped: true },
      { name: 'withdrawals', purpose: 'Freelancer earnings withdrawal requests', keyFields: ['freelancer_id', 'amount', 'method', 'status', 'processed_at'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'processing', 'completed', 'failed'] },
      { name: 'dispute_cases', purpose: 'Order dispute resolution', keyFields: ['order_id', 'raised_by', 'reason', 'status', 'resolution'], ownerScoped: true },
      { name: 'notifications', purpose: 'Platform alerts', keyFields: ['user_id', 'type', 'title', 'body', 'read_at'], ownerScoped: true },
    ],
    authRoles: ['freelancer', 'client', 'admin'],
    authProviders: ['email', 'google', 'github'],
    storageBuckets: [
      { name: 'gig-images', purpose: 'Gig listing cover images and portfolio', isPublic: true },
      { name: 'deliverables', purpose: 'Work files submitted by freelancers', isPublic: false },
      { name: 'user-avatars', purpose: 'Profile photos', isPublic: true },
      { name: 'portfolio-files', purpose: 'Freelancer portfolio attachments', isPublic: false },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Escrow payment hold and freelancer payouts', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Order updates, dispute notifications, weekly earnings reports', required: false, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['messages', 'orders', 'notifications'],
    functions: [
      { name: 'escrow_release', trigger: 'webhook', table: 'orders', purpose: 'Release held funds to freelancer on order completion' },
      { name: 'order_reminder', trigger: 'cron', purpose: 'Remind freelancer of approaching deadlines' },
      { name: 'review_request', trigger: 'on_update', table: 'orders', purpose: 'Prompt both parties to review after completion' },
    ],
    permissions: [
      'Freelancers own their gig listings and profile',
      'Clients own their orders and can see order deliverables',
      'Reviews visible publicly after both parties review',
      'Admins can moderate all content and resolve disputes',
      'Earnings locked until 14 days after order completion (auto-release)',
    ],
    productionChecks: [
      'Indexes on gig_listings.freelancer_id, orders.client_id, orders.freelancer_id',
      'Webhook idempotency for Stripe events',
      'Order total immutable after payment (trigger lock)',
      'Rate limit message sending: 30 per minute per user',
    ],
  },

  rental_platform: {
    productType: 'rental_platform',
    oneLiner: 'Short-term rental platform connecting property hosts with guests',
    actors: ['guests', 'hosts', 'admin'],
    coreValueExchange: 'Hosts list spaces; guests discover, book, and pay for short-term stays',
    entities: [
      { name: 'users', purpose: 'All platform accounts', keyFields: ['email', 'role', 'name', 'avatar_url', 'phone', 'is_verified'], ownerScoped: false },
      { name: 'listings', purpose: 'Properties or spaces available to rent', keyFields: ['host_id', 'title', 'description', 'property_type', 'address', 'city', 'price_per_night', 'max_guests', 'status'], ownerScoped: true, stateColumn: 'status', states: ['draft', 'active', 'paused', 'archived'] },
      { name: 'listing_photos', purpose: 'Listing image gallery', keyFields: ['listing_id', 'url', 'position', 'caption'], ownerScoped: true },
      { name: 'amenities', purpose: 'Available facility tags (WiFi, pool, etc.)', keyFields: ['name', 'icon', 'category'], ownerScoped: false },
      { name: 'listing_amenities', purpose: 'M2M: which amenities each listing has', keyFields: ['listing_id', 'amenity_id'], ownerScoped: true },
      { name: 'availability', purpose: 'Host-controlled calendar open dates', keyFields: ['listing_id', 'date', 'is_available', 'price_override'], ownerScoped: true },
      { name: 'bookings', purpose: 'Guest reservation for a listing', keyFields: ['guest_id', 'listing_id', 'check_in', 'check_out', 'guests_count', 'total', 'status', 'stripe_payment_intent_id'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'refunded'] },
      { name: 'reviews', purpose: 'Mutual post-stay reviews', keyFields: ['booking_id', 'reviewer_id', 'reviewee_id', 'listing_id', 'rating', 'body'], ownerScoped: true },
      { name: 'messages', purpose: 'Guest-host messaging thread', keyFields: ['sender_id', 'recipient_id', 'booking_id', 'body', 'read_at'], ownerScoped: true },
      { name: 'payouts', purpose: 'Host earnings per booking', keyFields: ['host_id', 'booking_id', 'amount', 'platform_fee', 'status', 'paid_at'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'processing', 'paid', 'failed'] },
      { name: 'wishlists', purpose: 'Guest saved listings', keyFields: ['guest_id', 'listing_id', 'note'], ownerScoped: true },
    ],
    authRoles: ['guest', 'host', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'listing-photos', purpose: 'Property listing images', isPublic: true },
      { name: 'user-avatars', purpose: 'Host and guest profile photos', isPublic: true },
      { name: 'verification-docs', purpose: 'ID verification documents for hosts', isPublic: false },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Guest payment capture and host payout scheduling', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Booking confirmations, check-in instructions, review requests', required: false, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['messages', 'bookings'],
    functions: [
      { name: 'booking_confirmation', trigger: 'webhook', table: 'bookings', purpose: 'Confirm booking and send check-in details on payment success' },
      { name: 'host_payout', trigger: 'cron', purpose: 'Initiate host payouts 24h after guest check-out' },
      { name: 'availability_block', trigger: 'on_insert', table: 'bookings', purpose: 'Mark booked dates as unavailable to prevent double-booking' },
      { name: 'review_invite', trigger: 'on_update', table: 'bookings', purpose: 'Email both parties after check-out to leave reviews' },
    ],
    permissions: [
      'Hosts own their listings, photos, and availability calendar',
      'Guests own their bookings and can message the host',
      'Reviews only possible after a completed booking',
      'Public can browse listings and photos without authentication',
      'No double-booking: availability check enforced before payment',
    ],
    productionChecks: [
      'Indexes on listings.host_id, bookings.guest_id, bookings.listing_id, availability.listing_id+date',
      'Double-booking prevention: unique constraint on listing_id + date range in bookings',
      'Webhook idempotency via stripe_payment_intent_id',
      'Availability check inside a DB transaction with SELECT FOR UPDATE',
      'Rate limit on booking requests: 10 per user per hour',
    ],
  },

  food_delivery: {
    productType: 'food_delivery',
    oneLiner: 'On-demand food delivery platform connecting customers, restaurants, and drivers',
    actors: ['customers', 'restaurants', 'drivers', 'admin'],
    coreValueExchange: 'Customers order from restaurant menus; drivers pick up and deliver; restaurants earn revenue',
    entities: [
      { name: 'users', purpose: 'All accounts (customers, restaurants, drivers)', keyFields: ['email', 'role', 'name', 'phone', 'avatar_url'], ownerScoped: false },
      { name: 'restaurants', purpose: 'Restaurant profiles and settings', keyFields: ['owner_id', 'name', 'address', 'city', 'cuisine_type', 'is_open', 'rating', 'delivery_fee', 'min_order'], ownerScoped: true },
      { name: 'menu_categories', purpose: 'Food category sections per restaurant', keyFields: ['restaurant_id', 'name', 'position', 'is_available'], ownerScoped: true },
      { name: 'menu_items', purpose: 'Individual dishes with pricing', keyFields: ['restaurant_id', 'category_id', 'name', 'description', 'price', 'image_url', 'is_available'], ownerScoped: true },
      { name: 'item_options', purpose: 'Customization choices (size, toppings)', keyFields: ['item_id', 'name', 'choices', 'is_required', 'max_selections'], ownerScoped: true },
      { name: 'driver_profiles', purpose: 'Driver vehicle and availability info', keyFields: ['user_id', 'vehicle_type', 'vehicle_plate', 'is_online', 'current_lat', 'current_lng', 'rating'], ownerScoped: true },
      { name: 'addresses', purpose: 'Saved customer delivery addresses', keyFields: ['user_id', 'label', 'address_line', 'city', 'lat', 'lng', 'is_default'], ownerScoped: true },
      { name: 'orders', purpose: 'Customer food orders', keyFields: ['customer_id', 'restaurant_id', 'driver_id', 'address_id', 'subtotal', 'delivery_fee', 'total', 'status', 'stripe_payment_intent_id'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'accepted', 'preparing', 'ready_for_pickup', 'picked_up', 'delivered', 'cancelled'] },
      { name: 'order_items', purpose: 'Line items per order', keyFields: ['order_id', 'menu_item_id', 'quantity', 'unit_price', 'customizations', 'subtotal'], ownerScoped: true },
      { name: 'ratings', purpose: 'Customer ratings for restaurant and driver', keyFields: ['order_id', 'customer_id', 'restaurant_id', 'driver_id', 'food_rating', 'delivery_rating', 'comment'], ownerScoped: true },
      { name: 'promotions', purpose: 'Discount codes and promotional campaigns', keyFields: ['code', 'discount_type', 'discount_value', 'min_order', 'expires_at', 'max_uses', 'used_count'], ownerScoped: false },
    ],
    authRoles: ['customer', 'restaurant', 'driver', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'food-images', purpose: 'Menu item and restaurant photos', isPublic: true },
      { name: 'restaurant-banners', purpose: 'Restaurant cover images', isPublic: true },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Customer payment processing and restaurant payouts', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Order confirmation and delivery status emails', required: false, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['orders', 'driver_location'],
    functions: [
      { name: 'order_dispatch', trigger: 'on_insert', table: 'orders', purpose: 'Notify restaurant of new order and find available driver' },
      { name: 'driver_assignment', trigger: 'on_update', table: 'orders', purpose: 'Assign nearest available driver when order is ready' },
      { name: 'delivery_complete', trigger: 'on_update', table: 'orders', purpose: 'Release payment to restaurant and driver on delivery' },
      { name: 'restaurant_payout', trigger: 'cron', purpose: 'Weekly payout to restaurant accounts' },
    ],
    permissions: [
      'Restaurants own their menus and see their orders',
      'Customers own their orders, addresses, and ratings',
      'Drivers own their profile and see assigned deliveries',
      'Menu items browsable publicly without auth',
      'Admin can manage all restaurants and resolve disputes',
    ],
    productionChecks: [
      'Indexes on orders.customer_id, orders.restaurant_id, orders.driver_id, orders.status',
      'Webhook idempotency for Stripe payment events',
      'Order status machine enforced (cannot skip states)',
      'Driver availability check before assignment',
      'Rate limit order placement: 5 per customer per 10 minutes',
    ],
  },

  ride_sharing: {
    productType: 'ride_sharing',
    oneLiner: 'On-demand ride sharing platform matching riders with drivers',
    actors: ['riders', 'drivers', 'admin'],
    coreValueExchange: 'Riders request rides; nearby drivers accept and complete trips for payment',
    entities: [
      { name: 'users', purpose: 'All user accounts', keyFields: ['email', 'role', 'name', 'phone', 'avatar_url'], ownerScoped: false },
      { name: 'driver_profiles', purpose: 'Driver onboarding info and status', keyFields: ['user_id', 'license_number', 'is_verified', 'is_online', 'current_lat', 'current_lng', 'rating', 'total_rides'], ownerScoped: true },
      { name: 'vehicles', purpose: 'Driver vehicle registration', keyFields: ['driver_id', 'make', 'model', 'year', 'color', 'plate', 'type'], ownerScoped: true },
      { name: 'rides', purpose: 'Individual trip records', keyFields: ['rider_id', 'driver_id', 'pickup_address', 'pickup_lat', 'pickup_lng', 'dropoff_address', 'dropoff_lat', 'dropoff_lng', 'status', 'fare', 'distance_km', 'duration_sec', 'stripe_payment_intent_id'], ownerScoped: true, stateColumn: 'status', states: ['requested', 'accepted', 'driver_arriving', 'in_progress', 'completed', 'cancelled'] },
      { name: 'ride_ratings', purpose: 'Mutual rider/driver ratings', keyFields: ['ride_id', 'rated_by', 'rated_user_id', 'score', 'comment'], ownerScoped: true },
      { name: 'payment_methods', purpose: 'Rider saved payment cards', keyFields: ['user_id', 'stripe_payment_method_id', 'card_last4', 'card_brand', 'is_default'], ownerScoped: true },
      { name: 'driver_earnings', purpose: 'Per-trip driver earnings ledger', keyFields: ['driver_id', 'ride_id', 'gross_fare', 'platform_fee', 'net_earnings', 'paid_at'], ownerScoped: true },
      { name: 'promo_codes', purpose: 'Discount codes for riders', keyFields: ['code', 'discount_type', 'discount_value', 'expires_at', 'max_uses', 'used_count'], ownerScoped: false },
    ],
    authRoles: ['rider', 'driver', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'driver-documents', purpose: 'License and insurance uploads for verification', isPublic: false },
      { name: 'profile-photos', purpose: 'Driver and rider profile photos', isPublic: true },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Ride fare charging and driver earnings payouts', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Trip receipts and driver earnings summaries', required: false, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['rides', 'driver_location'],
    functions: [
      { name: 'match_driver', trigger: 'on_insert', table: 'rides', purpose: 'Find nearest available driver and send ride request' },
      { name: 'fare_calculation', trigger: 'on_update', table: 'rides', purpose: 'Calculate final fare based on distance and duration on trip complete' },
      { name: 'earnings_payout', trigger: 'cron', purpose: 'Weekly driver earnings transfer to bank account' },
      { name: 'surge_pricing', trigger: 'cron', purpose: 'Recalculate surge multiplier based on demand/supply ratio every 5 minutes' },
    ],
    permissions: [
      'Drivers control their own availability and see only their rides',
      'Riders own their payment methods and ride history',
      'Ratings are mutual and only after trip completion',
      'Driver documents are private and only accessible by admin',
      'Admin can see all rides and manage driver verification',
    ],
    productionChecks: [
      'Indexes on rides.rider_id, rides.driver_id, rides.status, driver_profiles.is_online',
      'Ride status machine enforced — no skipping states',
      'Webhook idempotency for Stripe charge events',
      'Geospatial index on driver_profiles for nearest-driver queries',
      'Rate limit ride requests: 3 per rider per 5 minutes',
    ],
  },

  social_app: {
    productType: 'social_app',
    oneLiner: 'Social platform with posts, follows, and real-time engagement',
    actors: ['users', 'admin'],
    coreValueExchange: 'Users share content, build audiences, and engage with others via likes, comments, and follows',
    entities: [
      { name: 'users', purpose: 'User profiles and settings', keyFields: ['email', 'username', 'name', 'bio', 'avatar_url', 'is_verified', 'is_private'], ownerScoped: false },
      { name: 'posts', purpose: 'User-created content', keyFields: ['author_id', 'content', 'media_urls', 'type', 'status', 'likes_count', 'comments_count'], ownerScoped: true, stateColumn: 'status', states: ['published', 'draft', 'archived', 'reported'] },
      { name: 'comments', purpose: 'Replies to posts', keyFields: ['post_id', 'author_id', 'body', 'parent_comment_id', 'likes_count'], ownerScoped: true },
      { name: 'likes', purpose: 'Post and comment reactions', keyFields: ['user_id', 'post_id', 'comment_id', 'type'], ownerScoped: true },
      { name: 'follows', purpose: 'Follower/following relationships', keyFields: ['follower_id', 'following_id', 'status'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'accepted'] },
      { name: 'stories', purpose: 'Ephemeral 24-hour content', keyFields: ['author_id', 'media_url', 'media_type', 'expires_at', 'view_count'], ownerScoped: true },
      { name: 'story_views', purpose: 'Who viewed each story', keyFields: ['story_id', 'viewer_id', 'viewed_at'], ownerScoped: true },
      { name: 'messages', purpose: 'Direct messages between users', keyFields: ['sender_id', 'recipient_id', 'body', 'media_url', 'read_at', 'conversation_id'], ownerScoped: true },
      { name: 'notifications', purpose: 'Likes, comments, follows, mentions alerts', keyFields: ['user_id', 'actor_id', 'type', 'reference_id', 'read_at'], ownerScoped: true },
      { name: 'hashtags', purpose: 'Content discovery tags', keyFields: ['name', 'post_count'], ownerScoped: false },
      { name: 'post_hashtags', purpose: 'M2M: posts tagged with hashtags', keyFields: ['post_id', 'hashtag_id'], ownerScoped: true },
      { name: 'blocked_users', purpose: 'User blocking for safety', keyFields: ['blocker_id', 'blocked_id', 'created_at'], ownerScoped: true },
    ],
    authRoles: ['user', 'verified_creator', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'post-media', purpose: 'Photos and videos in posts', isPublic: true },
      { name: 'story-media', purpose: 'Story images and videos (auto-deleted after 24h)', isPublic: false },
      { name: 'profile-photos', purpose: 'User avatar and cover images', isPublic: true },
      { name: 'message-media', purpose: 'Images and files in direct messages', isPublic: false },
    ],
    integrations: [
      { name: 'resend', purpose: 'Email notifications for follows, messages, and mentions', required: false, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['messages', 'notifications', 'feed', 'stories'],
    functions: [
      { name: 'notification_fanout', trigger: 'on_insert', table: 'likes', purpose: 'Create notification for post author when liked' },
      { name: 'follow_notification', trigger: 'on_insert', table: 'follows', purpose: 'Notify user of new follower' },
      { name: 'story_expiry', trigger: 'cron', purpose: 'Delete expired stories every hour and clean up media' },
      { name: 'feed_cache_invalidate', trigger: 'on_insert', table: 'posts', purpose: 'Invalidate cached feeds for followers' },
    ],
    permissions: [
      'Users can only edit and delete their own posts, comments, and stories',
      'Private accounts: only followers can see posts (enforce with RLS)',
      'Blocked users cannot see each other\'s content',
      'Direct messages are visible only to sender and recipient',
      'Admin can moderate all public content',
    ],
    productionChecks: [
      'Indexes on posts.author_id, follows.follower_id+following_id, likes.user_id+post_id',
      'Unique constraint on follows (follower_id, following_id)',
      'Unique constraint on likes (user_id, post_id) — one like per user',
      'Feed pagination with cursor-based approach for large follow counts',
      'Rate limit: 60 posts per day, 10 messages per minute',
    ],
  },

  saas_platform: {
    productType: 'saas_platform',
    oneLiner: 'Multi-tenant B2B SaaS with organizations, RBAC, and subscription billing',
    actors: ['workspace_owners', 'admins', 'members', 'viewers'],
    coreValueExchange: 'Teams collaborate within isolated workspaces; organizations subscribe to access the platform',
    entities: [
      { name: 'users', purpose: 'All platform accounts', keyFields: ['email', 'name', 'avatar_url', 'last_active_at'], ownerScoped: false },
      { name: 'organizations', purpose: 'Top-level tenant account', keyFields: ['name', 'slug', 'plan', 'stripe_customer_id', 'owner_id'], ownerScoped: false },
      { name: 'memberships', purpose: 'User-organization membership with role', keyFields: ['user_id', 'organization_id', 'role', 'joined_at', 'invited_by'], ownerScoped: false },
      { name: 'invitations', purpose: 'Pending team invites via email', keyFields: ['organization_id', 'email', 'role', 'token', 'expires_at', 'accepted_at'], ownerScoped: false },
      { name: 'projects', purpose: 'Work units within an organization', keyFields: ['organization_id', 'name', 'description', 'status', 'owner_id'], ownerScoped: false, stateColumn: 'status', states: ['active', 'archived', 'completed'] },
      { name: 'tasks', purpose: 'Actionable items within projects', keyFields: ['project_id', 'organization_id', 'title', 'description', 'assignee_id', 'status', 'priority', 'due_date'], ownerScoped: false, stateColumn: 'status', states: ['todo', 'in_progress', 'review', 'done', 'cancelled'] },
      { name: 'comments', purpose: 'Discussion on tasks', keyFields: ['task_id', 'author_id', 'body', 'parent_id'], ownerScoped: false },
      { name: 'activity_logs', purpose: 'Audit trail for all actions', keyFields: ['organization_id', 'actor_id', 'action', 'resource_type', 'resource_id', 'metadata'], ownerScoped: false },
      { name: 'notifications', purpose: 'User-specific alerts', keyFields: ['user_id', 'organization_id', 'type', 'title', 'body', 'read_at', 'reference_id'], ownerScoped: true },
      { name: 'api_keys', purpose: 'Programmatic API access', keyFields: ['organization_id', 'name', 'key_hash', 'last_used_at', 'expires_at', 'scopes'], ownerScoped: false },
      { name: 'usage_metrics', purpose: 'Feature usage tracking for billing', keyFields: ['organization_id', 'metric_type', 'value', 'period_start', 'period_end'], ownerScoped: false },
    ],
    authRoles: ['owner', 'admin', 'member', 'viewer'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'file-uploads', purpose: 'Task attachments and project assets', isPublic: false },
      { name: 'org-assets', purpose: 'Organization logos and brand assets', isPublic: true },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Subscription management and billing', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Team invitations, task assignments, digest emails', required: false, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['tasks', 'comments', 'notifications'],
    functions: [
      { name: 'activity_logger', trigger: 'on_update', table: 'tasks', purpose: 'Auto-log all task mutations to activity_logs' },
      { name: 'invite_expiry', trigger: 'cron', purpose: 'Mark expired invitations as expired every day' },
      { name: 'usage_report', trigger: 'cron', purpose: 'Aggregate monthly usage metrics for billing sync' },
      { name: 'billing_sync', trigger: 'webhook', purpose: 'Update organization plan on Stripe subscription events' },
    ],
    permissions: [
      'All resources must be scoped to organization_id — cross-org access is impossible',
      'Owner: full access including billing and member management',
      'Admin: create/edit all resources, manage members (not billing)',
      'Member: create and edit their own tasks and comments',
      'Viewer: read-only across the organization',
    ],
    productionChecks: [
      'organization_id on ALL tables — never store cross-tenant data',
      'Indexes on tasks.project_id, tasks.assignee_id, memberships.user_id+organization_id',
      'Soft deletes on tasks, projects, and users (deleted_at column)',
      'Webhook idempotency for Stripe subscription events',
      'Activity log is append-only — no updates or deletes',
    ],
  },

  ecommerce_store: {
    productType: 'ecommerce_store',
    oneLiner: 'Full-featured online store with products, cart, checkout, and order management',
    actors: ['customers', 'admin'],
    coreValueExchange: 'Customers browse and purchase products; the store manages inventory and fulfillment',
    entities: [
      { name: 'users', purpose: 'Customer accounts', keyFields: ['email', 'name', 'phone', 'avatar_url'], ownerScoped: false },
      { name: 'categories', purpose: 'Product taxonomy', keyFields: ['name', 'slug', 'parent_id', 'image_url'], ownerScoped: false },
      { name: 'products', purpose: 'Items for sale', keyFields: ['category_id', 'name', 'slug', 'description', 'price', 'compare_price', 'stock', 'sku', 'status'], ownerScoped: false, stateColumn: 'status', states: ['draft', 'active', 'out_of_stock', 'archived'] },
      { name: 'product_variants', purpose: 'Size/color options for a product', keyFields: ['product_id', 'name', 'sku', 'price', 'stock', 'attributes'], ownerScoped: false },
      { name: 'product_images', purpose: 'Product photo gallery', keyFields: ['product_id', 'url', 'alt_text', 'position', 'is_primary'], ownerScoped: false },
      { name: 'carts', purpose: 'Active shopping carts', keyFields: ['user_id', 'session_id', 'expires_at'], ownerScoped: true },
      { name: 'cart_items', purpose: 'Products in cart', keyFields: ['cart_id', 'product_id', 'variant_id', 'quantity', 'price_snapshot'], ownerScoped: true },
      { name: 'addresses', purpose: 'Saved shipping addresses', keyFields: ['user_id', 'label', 'full_name', 'address_line', 'city', 'country', 'postal_code', 'is_default'], ownerScoped: true },
      { name: 'coupons', purpose: 'Discount codes', keyFields: ['code', 'discount_type', 'discount_value', 'min_order', 'expires_at', 'max_uses', 'used_count'], ownerScoped: false },
      { name: 'orders', purpose: 'Purchase records', keyFields: ['user_id', 'address_id', 'coupon_id', 'subtotal', 'discount', 'total', 'status', 'stripe_payment_intent_id'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'] },
      { name: 'order_items', purpose: 'Line items in an order', keyFields: ['order_id', 'product_id', 'variant_id', 'quantity', 'unit_price', 'subtotal'], ownerScoped: true },
      { name: 'reviews', purpose: 'Post-purchase customer reviews', keyFields: ['product_id', 'user_id', 'order_id', 'rating', 'title', 'body', 'is_verified'], ownerScoped: true },
    ],
    authRoles: ['customer', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'product-images', purpose: 'Product listing photos', isPublic: true },
      { name: 'category-images', purpose: 'Category cover images', isPublic: true },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Checkout session, payment, and refund processing', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Order confirmation, shipping notification, review request', required: false, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['orders'],
    functions: [
      { name: 'checkout_session', trigger: 'webhook', table: 'orders', purpose: 'Create Stripe checkout session; update order to paid on success' },
      { name: 'inventory_decrement', trigger: 'on_update', table: 'orders', purpose: 'Decrement stock when order status changes to paid' },
      { name: 'order_shipped_email', trigger: 'on_update', table: 'orders', purpose: 'Send tracking info email when status changes to shipped' },
    ],
    permissions: [
      'Customers see only their own cart, orders, and addresses',
      'Reviews only after a verified purchase (check order_id)',
      'Product catalog and categories are publicly readable',
      'Admin has full access to all resources',
    ],
    productionChecks: [
      'Indexes on products.category_id, orders.user_id, order_items.order_id, reviews.product_id',
      'Stock cannot go below zero (check constraint + trigger)',
      'Coupon max_uses enforced (atomic increment + check)',
      'Webhook idempotency via stripe_payment_intent_id uniqueness',
    ],
  },

  digital_products: {
    productType: 'digital_products',
    oneLiner: 'Digital product marketplace where creators sell downloadable files',
    actors: ['creators', 'buyers', 'admin'],
    coreValueExchange: 'Creators publish digital products (ebooks, templates, tools); buyers purchase and download',
    entities: [
      { name: 'users', purpose: 'Creator and buyer accounts', keyFields: ['email', 'username', 'name', 'bio', 'avatar_url', 'role', 'stripe_account_id'], ownerScoped: false },
      { name: 'products', purpose: 'Digital items for sale', keyFields: ['creator_id', 'title', 'description', 'price', 'cover_image_url', 'file_url', 'file_type', 'status', 'sales_count'], ownerScoped: true, stateColumn: 'status', states: ['draft', 'published', 'archived'] },
      { name: 'product_files', purpose: 'Multiple files per product', keyFields: ['product_id', 'filename', 'file_url', 'file_size', 'position'], ownerScoped: true },
      { name: 'licenses', purpose: 'Access grant after purchase', keyFields: ['user_id', 'product_id', 'order_id', 'license_key', 'download_count', 'max_downloads', 'expires_at'], ownerScoped: true },
      { name: 'orders', purpose: 'Purchase record', keyFields: ['buyer_id', 'product_id', 'price_paid', 'stripe_payment_intent_id', 'status'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'completed', 'refunded'] },
      { name: 'reviews', purpose: 'Buyer product reviews', keyFields: ['product_id', 'buyer_id', 'order_id', 'rating', 'body'], ownerScoped: true },
      { name: 'follows', purpose: 'Creator follow relationships', keyFields: ['follower_id', 'creator_id'], ownerScoped: true },
      { name: 'discount_codes', purpose: 'Promo codes per creator', keyFields: ['creator_id', 'product_id', 'code', 'discount_pct', 'uses', 'max_uses', 'expires_at'], ownerScoped: true },
      { name: 'payouts', purpose: 'Creator earnings from sales', keyFields: ['creator_id', 'amount', 'platform_fee', 'net', 'stripe_transfer_id', 'period_start', 'period_end', 'status'], ownerScoped: true },
    ],
    authRoles: ['creator', 'buyer', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'product-files', purpose: 'The actual digital files for sale (private, signed URL access)', isPublic: false },
      { name: 'cover-images', purpose: 'Product cover/preview images', isPublic: true },
      { name: 'profile-photos', purpose: 'Creator profile photos', isPublic: true },
    ],
    integrations: [
      { name: 'stripe', purpose: 'One-time purchases and creator payouts', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Purchase receipt and download link delivery', required: true, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['sales_notifications'],
    functions: [
      { name: 'license_generate', trigger: 'on_insert', table: 'orders', purpose: 'Create license key and generate signed download URL on purchase' },
      { name: 'download_limit_check', trigger: 'on_update', table: 'licenses', purpose: 'Reject download if max_downloads exceeded' },
      { name: 'creator_payout', trigger: 'cron', purpose: 'Weekly earnings calculation and payout to creator Stripe accounts' },
    ],
    permissions: [
      'Creators own their products and files',
      'Buyers can only download products they have a valid license for',
      'Download URLs are signed and expire after 15 minutes',
      'Reviews only after verified purchase',
      'Admin can manage all products and process refunds',
    ],
    productionChecks: [
      'Signed URLs for all private product file downloads',
      'License key uniqueness enforced',
      'Download count enforced (concurrent-safe increment)',
      'Webhook idempotency for Stripe purchase events',
      'Indexes on products.creator_id, licenses.user_id+product_id, orders.buyer_id',
    ],
  },

  job_board: {
    productType: 'job_board',
    oneLiner: 'Job marketplace connecting employers with job seekers',
    actors: ['job_seekers', 'employers', 'admin'],
    coreValueExchange: 'Employers post job listings; job seekers apply with resumes and portfolios',
    entities: [
      { name: 'users', purpose: 'All accounts', keyFields: ['email', 'role', 'name', 'avatar_url'], ownerScoped: false },
      { name: 'companies', purpose: 'Employer profiles', keyFields: ['owner_id', 'name', 'website', 'logo_url', 'description', 'industry', 'size', 'location'], ownerScoped: true },
      { name: 'job_listings', purpose: 'Open positions', keyFields: ['company_id', 'title', 'description', 'type', 'location', 'remote_ok', 'salary_min', 'salary_max', 'skills', 'status', 'expires_at'], ownerScoped: true, stateColumn: 'status', states: ['draft', 'active', 'closed', 'filled'] },
      { name: 'categories', purpose: 'Job function taxonomy', keyFields: ['name', 'slug'], ownerScoped: false },
      { name: 'seeker_profiles', purpose: 'Job seeker public profile', keyFields: ['user_id', 'headline', 'summary', 'location', 'open_to_work', 'experience_years', 'skills', 'resume_url'], ownerScoped: true },
      { name: 'applications', purpose: 'Job application submissions', keyFields: ['job_id', 'applicant_id', 'status', 'cover_letter', 'resume_url', 'applied_at'], ownerScoped: true, stateColumn: 'status', states: ['submitted', 'reviewing', 'shortlisted', 'interviewed', 'offered', 'rejected', 'withdrawn'] },
      { name: 'saved_jobs', purpose: 'Bookmarked listings', keyFields: ['user_id', 'job_id', 'saved_at'], ownerScoped: true },
      { name: 'email_alerts', purpose: 'Job alert subscriptions', keyFields: ['user_id', 'keywords', 'location', 'frequency', 'last_sent_at'], ownerScoped: true },
    ],
    authRoles: ['seeker', 'employer', 'admin'],
    authProviders: ['email', 'google', 'github'],
    storageBuckets: [
      { name: 'resumes', purpose: 'Applicant resume PDFs', isPublic: false },
      { name: 'company-logos', purpose: 'Employer brand logos', isPublic: true },
      { name: 'profile-photos', purpose: 'Job seeker profile photos', isPublic: true },
    ],
    integrations: [
      { name: 'resend', purpose: 'Application status updates, interview invites, job alerts', required: true, credentialKey: 'RESEND_API_KEY' },
      { name: 'stripe', purpose: 'Employer job posting fees (optional)', required: false, credentialKey: 'STRIPE_SECRET_KEY' },
    ],
    realtimeChannels: ['application_updates'],
    functions: [
      { name: 'application_notify', trigger: 'on_insert', table: 'applications', purpose: 'Notify employer of new application' },
      { name: 'job_expiry', trigger: 'cron', purpose: 'Close expired job listings automatically' },
      { name: 'job_alert_send', trigger: 'cron', purpose: 'Send matching job emails to alert subscribers daily' },
    ],
    permissions: [
      'Employers see only applications for their own job listings',
      'Job seekers see only their own applications and resumes',
      'Resumes are private — only the hiring employer can view them',
      'Company profiles and job listings are publicly readable',
    ],
    productionChecks: [
      'Indexes on job_listings.company_id, applications.job_id+applicant_id, job_listings.status+expires_at',
      'Full-text search index on job_listings (title, description, skills)',
      'Unique constraint on saved_jobs (user_id, job_id)',
    ],
  },

  event_platform: {
    productType: 'event_platform',
    oneLiner: 'Event ticketing and management platform for organizers and attendees',
    actors: ['organizers', 'attendees', 'admin'],
    coreValueExchange: 'Organizers create events and sell tickets; attendees register and attend',
    entities: [
      { name: 'users', purpose: 'All accounts', keyFields: ['email', 'name', 'avatar_url', 'role'], ownerScoped: false },
      { name: 'organizer_profiles', purpose: 'Event organizer branding', keyFields: ['user_id', 'name', 'bio', 'logo_url', 'website'], ownerScoped: true },
      { name: 'events', purpose: 'Event listings', keyFields: ['organizer_id', 'title', 'description', 'start_at', 'end_at', 'venue', 'address', 'is_online', 'stream_url', 'cover_image_url', 'status', 'capacity'], ownerScoped: true, stateColumn: 'status', states: ['draft', 'published', 'sold_out', 'cancelled', 'completed'] },
      { name: 'ticket_types', purpose: 'Ticket tiers per event (General, VIP, etc.)', keyFields: ['event_id', 'name', 'price', 'quantity', 'sold', 'description'], ownerScoped: true },
      { name: 'orders', purpose: 'Ticket purchase record', keyFields: ['buyer_id', 'event_id', 'total', 'status', 'stripe_payment_intent_id'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'paid', 'cancelled', 'refunded'] },
      { name: 'tickets', purpose: 'Individual attendee tickets with QR code', keyFields: ['order_id', 'ticket_type_id', 'attendee_name', 'attendee_email', 'qr_code', 'checked_in_at'], ownerScoped: true },
      { name: 'waitlist', purpose: 'Waitlist for sold-out events', keyFields: ['event_id', 'user_id', 'ticket_type_id', 'position', 'notified_at'], ownerScoped: true },
      { name: 'promo_codes', purpose: 'Discount codes for events', keyFields: ['event_id', 'code', 'discount_pct', 'uses', 'max_uses', 'expires_at'], ownerScoped: true },
    ],
    authRoles: ['attendee', 'organizer', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'event-covers', purpose: 'Event banner and cover photos', isPublic: true },
      { name: 'organizer-logos', purpose: 'Organizer brand logos', isPublic: true },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Ticket purchase processing and organizer payouts', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'E-ticket delivery, event reminders, updates', required: true, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['waitlist_notifications'],
    functions: [
      { name: 'ticket_generate', trigger: 'webhook', table: 'tickets', purpose: 'Generate QR code and email e-ticket on payment success' },
      { name: 'waitlist_notify', trigger: 'on_update', table: 'ticket_types', purpose: 'Notify waitlist when tickets become available (cancellation)' },
      { name: 'event_reminder', trigger: 'cron', purpose: 'Email attendees 24h and 1h before event starts' },
    ],
    permissions: [
      'Organizers own their events and ticket types',
      'Attendees own their orders and tickets',
      'QR code check-in only visible to event organizer',
      'Events are publicly browsable',
      'Organizer payout processed after event completion',
    ],
    productionChecks: [
      'Ticket oversell prevention: atomic sold_count increment with capacity check',
      'QR code uniqueness enforced',
      'Webhook idempotency for Stripe ticket purchases',
      'Indexes on events.organizer_id, tickets.order_id, orders.buyer_id',
    ],
  },

  edtech_lms: {
    productType: 'edtech_lms',
    oneLiner: 'Online learning platform where instructors create and sell courses',
    actors: ['instructors', 'students', 'admin'],
    coreValueExchange: 'Instructors create video courses; students enroll and learn at their own pace',
    entities: [
      { name: 'users', purpose: 'All platform accounts', keyFields: ['email', 'name', 'avatar_url', 'role', 'bio'], ownerScoped: false },
      { name: 'courses', purpose: 'Instructor-created courses', keyFields: ['instructor_id', 'title', 'description', 'thumbnail_url', 'price', 'level', 'category', 'status', 'student_count'], ownerScoped: true, stateColumn: 'status', states: ['draft', 'published', 'archived'] },
      { name: 'sections', purpose: 'Chapter groups within a course', keyFields: ['course_id', 'title', 'position'], ownerScoped: true },
      { name: 'lessons', purpose: 'Individual video or text lessons', keyFields: ['section_id', 'course_id', 'title', 'type', 'video_url', 'duration_sec', 'position', 'is_free_preview'], ownerScoped: true },
      { name: 'enrollments', purpose: 'Student course registrations', keyFields: ['student_id', 'course_id', 'order_id', 'enrolled_at', 'completed_at', 'progress_pct'], ownerScoped: true },
      { name: 'progress', purpose: 'Per-lesson completion tracking', keyFields: ['enrollment_id', 'lesson_id', 'completed_at', 'last_position_sec'], ownerScoped: true },
      { name: 'quizzes', purpose: 'Knowledge checks per lesson', keyFields: ['lesson_id', 'title', 'pass_score'], ownerScoped: true },
      { name: 'quiz_attempts', purpose: 'Student quiz submission records', keyFields: ['quiz_id', 'student_id', 'answers', 'score', 'passed', 'attempted_at'], ownerScoped: true },
      { name: 'certificates', purpose: 'Completion certificates', keyFields: ['enrollment_id', 'student_id', 'course_id', 'certificate_url', 'issued_at'], ownerScoped: true },
      { name: 'reviews', purpose: 'Student course reviews', keyFields: ['course_id', 'student_id', 'enrollment_id', 'rating', 'body'], ownerScoped: true },
      { name: 'orders', purpose: 'Course purchase records', keyFields: ['student_id', 'course_id', 'amount', 'coupon_id', 'stripe_payment_intent_id', 'status'], ownerScoped: true },
    ],
    authRoles: ['student', 'instructor', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'course-videos', purpose: 'Lesson videos (private — only enrolled students)', isPublic: false },
      { name: 'course-thumbnails', purpose: 'Course cover images', isPublic: true },
      { name: 'lesson-attachments', purpose: 'PDFs, slides, resources per lesson', isPublic: false },
      { name: 'certificates', purpose: 'Generated completion certificate PDFs', isPublic: false },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Course purchase processing and instructor payouts', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Enrollment confirmation, certificate delivery, new course alerts', required: false, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['lesson_progress', 'notifications'],
    functions: [
      { name: 'certificate_issue', trigger: 'on_update', table: 'enrollments', purpose: 'Generate and deliver certificate when course is 100% complete' },
      { name: 'enrollment_email', trigger: 'on_insert', table: 'enrollments', purpose: 'Send welcome and first-lesson email on enrollment' },
      { name: 'progress_update', trigger: 'on_insert', table: 'progress', purpose: 'Recalculate enrollment.progress_pct when lesson is completed' },
      { name: 'video_access_check', trigger: 'on_insert', table: 'progress', purpose: 'Verify enrollment exists before serving video URL' },
    ],
    permissions: [
      'Students can only access lessons of courses they are enrolled in',
      'Video URLs are signed and expire — no unauthenticated downloads',
      'Instructors own and manage their own courses and lessons',
      'Course browsing is public; lesson content is gated by enrollment',
      'Admin can manage all instructors and handle refund disputes',
    ],
    productionChecks: [
      'Indexes on enrollments.student_id+course_id, progress.enrollment_id+lesson_id',
      'Signed URLs for video and file access with 1-hour expiry',
      'Course purchase idempotency via stripe_payment_intent_id',
      'Certificate uniqueness per enrollment (one cert per course per student)',
    ],
  },

  subscription_newsletter: {
    productType: 'subscription_newsletter',
    oneLiner: 'Creator newsletter platform with free and paid subscriber tiers',
    actors: ['writers', 'subscribers', 'admin'],
    coreValueExchange: 'Writers publish newsletters; readers subscribe (free or paid) to receive them',
    entities: [
      { name: 'users', purpose: 'Writers and subscriber accounts', keyFields: ['email', 'name', 'avatar_url', 'role'], ownerScoped: false },
      { name: 'publications', purpose: 'Writer-owned newsletter brands', keyFields: ['owner_id', 'name', 'description', 'logo_url', 'custom_domain', 'subscriber_count'], ownerScoped: true },
      { name: 'subscription_tiers', purpose: 'Free/paid tiers defined by writer', keyFields: ['publication_id', 'name', 'price', 'billing_period', 'stripe_price_id', 'perks'], ownerScoped: true },
      { name: 'subscriptions', purpose: 'Reader subscription record', keyFields: ['subscriber_id', 'publication_id', 'tier_id', 'status', 'stripe_subscription_id', 'current_period_end'], ownerScoped: true, stateColumn: 'status', states: ['active', 'cancelled', 'past_due', 'trialing'] },
      { name: 'posts', purpose: 'Newsletter content', keyFields: ['publication_id', 'title', 'subtitle', 'content', 'cover_image_url', 'access_level', 'status', 'published_at'], ownerScoped: true, stateColumn: 'status', states: ['draft', 'scheduled', 'published', 'archived'] },
      { name: 'comments', purpose: 'Reader comments on posts', keyFields: ['post_id', 'author_id', 'body', 'parent_id', 'likes_count'], ownerScoped: true },
      { name: 'reactions', purpose: 'Post reactions', keyFields: ['post_id', 'user_id', 'type'], ownerScoped: true },
      { name: 'email_sends', purpose: 'Email delivery tracking per post', keyFields: ['post_id', 'recipient_id', 'sent_at', 'opened_at', 'clicked_at'], ownerScoped: true },
      { name: 'referrals', purpose: 'Referral tracking for growth', keyFields: ['referrer_id', 'publication_id', 'referred_email', 'converted_at'], ownerScoped: true },
      { name: 'payouts', purpose: 'Writer earnings from subscriptions', keyFields: ['writer_id', 'amount', 'period_start', 'period_end', 'stripe_transfer_id', 'status'], ownerScoped: true },
    ],
    authRoles: ['writer', 'paid_subscriber', 'free_subscriber', 'admin'],
    authProviders: ['email'],
    storageBuckets: [
      { name: 'post-images', purpose: 'Inline images for newsletter posts', isPublic: true },
      { name: 'profile-photos', purpose: 'Writer and subscriber profile photos', isPublic: true },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Recurring subscription billing and writer payouts', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Email newsletter delivery — the core product feature', required: true, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['comments', 'notifications'],
    functions: [
      { name: 'post_email_blast', trigger: 'on_update', table: 'posts', purpose: 'Send newsletter email to all eligible subscribers when post is published' },
      { name: 'subscription_renewal', trigger: 'webhook', table: 'subscriptions', purpose: 'Update subscription status on Stripe billing events' },
      { name: 'trial_conversion', trigger: 'cron', purpose: 'Email trial subscribers on day 5 before trial expiry' },
      { name: 'writer_payout', trigger: 'cron', purpose: 'Monthly writer earnings calculation and Stripe transfer' },
    ],
    permissions: [
      'Free posts are publicly readable; paid posts require active paid subscription',
      'Writers own their publications and all posts',
      'Email tracking data is writer-private (readers cannot see open/click data)',
      'Subscribers can only see their own subscription status',
      'Admin can manage all publications and handle subscription disputes',
    ],
    productionChecks: [
      'Paywalled content check before post content delivery',
      'Email delivery idempotency (track sent per post+recipient)',
      'Subscription access check on every paid post read',
      'Indexes on posts.publication_id+status, subscriptions.subscriber_id+publication_id',
      'Stripe webhook idempotency for subscription events',
    ],
  },

  service_booking: {
    productType: 'service_booking',
    oneLiner: 'Appointment booking platform for service providers and their clients',
    actors: ['service_providers', 'clients', 'admin'],
    coreValueExchange: 'Providers publish their services and availability; clients book appointments and pay',
    entities: [
      { name: 'users', purpose: 'All accounts', keyFields: ['email', 'name', 'avatar_url', 'role', 'phone'], ownerScoped: false },
      { name: 'provider_profiles', purpose: 'Service provider public profile', keyFields: ['user_id', 'bio', 'title', 'timezone', 'location', 'is_accepting_bookings', 'rating'], ownerScoped: true },
      { name: 'services', purpose: 'Service offerings with pricing', keyFields: ['provider_id', 'name', 'description', 'duration_min', 'price', 'is_active'], ownerScoped: true },
      { name: 'availability_slots', purpose: 'Provider working hours and slots', keyFields: ['provider_id', 'day_of_week', 'start_time', 'end_time', 'is_active'], ownerScoped: true },
      { name: 'blocked_dates', purpose: 'Provider-defined unavailable dates', keyFields: ['provider_id', 'date', 'reason'], ownerScoped: true },
      { name: 'bookings', purpose: 'Confirmed appointments', keyFields: ['client_id', 'provider_id', 'service_id', 'start_at', 'end_at', 'status', 'notes', 'stripe_payment_intent_id'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'] },
      { name: 'reviews', purpose: 'Client reviews after appointments', keyFields: ['booking_id', 'client_id', 'provider_id', 'rating', 'body'], ownerScoped: true },
      { name: 'reminders', purpose: 'Scheduled booking reminders', keyFields: ['booking_id', 'type', 'send_at', 'sent_at'], ownerScoped: true },
    ],
    authRoles: ['client', 'provider', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'provider-photos', purpose: 'Provider profile and service images', isPublic: true },
      { name: 'portfolio', purpose: 'Provider work portfolio', isPublic: true },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Advance booking deposit or full payment', required: false, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Booking confirmation, reminder, and follow-up emails', required: true, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['booking_notifications'],
    functions: [
      { name: 'booking_confirm', trigger: 'on_insert', table: 'bookings', purpose: 'Send confirmation email to client and provider on new booking' },
      { name: 'reminder_send', trigger: 'cron', purpose: 'Send 24h and 1h reminders for upcoming appointments' },
      { name: 'no_show_mark', trigger: 'cron', purpose: 'Auto-mark past bookings as no_show if not completed' },
      { name: 'availability_check', trigger: 'on_insert', table: 'bookings', purpose: 'Verify slot is still available before confirming booking' },
    ],
    permissions: [
      'Providers control their own availability, services, and see their own bookings',
      'Clients can only see their own booking history',
      'No double-booking: slot check enforced transactionally',
      'Reviews only after a completed booking',
      'Provider profile is publicly browsable',
    ],
    productionChecks: [
      'No double-booking: lock slot before insert (SELECT FOR UPDATE)',
      'Indexes on bookings.provider_id+start_at, bookings.client_id, availability_slots.provider_id',
      'Reminder job runs every 15 minutes (cron idempotency via sent_at check)',
      'Timezone handling: all times stored in UTC',
    ],
  },

  healthcare_booking: {
    productType: 'healthcare_booking',
    oneLiner: 'Healthcare appointment platform connecting patients with doctors and clinics',
    actors: ['patients', 'doctors', 'admin'],
    coreValueExchange: 'Patients find and book medical appointments; doctors manage their schedule and patient records',
    entities: [
      { name: 'users', purpose: 'Patient and doctor accounts', keyFields: ['email', 'name', 'avatar_url', 'role', 'phone'], ownerScoped: false },
      { name: 'doctor_profiles', purpose: 'Doctor specialization and credentials', keyFields: ['user_id', 'specialization', 'license_number', 'clinic_name', 'consultation_fee', 'bio', 'is_verified', 'rating'], ownerScoped: true },
      { name: 'specializations', purpose: 'Medical specialties taxonomy', keyFields: ['name', 'icon', 'description'], ownerScoped: false },
      { name: 'availability_slots', purpose: 'Doctor working hours', keyFields: ['doctor_id', 'day_of_week', 'start_time', 'end_time', 'slot_duration_min'], ownerScoped: true },
      { name: 'appointments', purpose: 'Patient-doctor consultations', keyFields: ['patient_id', 'doctor_id', 'start_at', 'end_at', 'type', 'status', 'notes', 'stripe_payment_intent_id'], ownerScoped: true, stateColumn: 'status', states: ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'] },
      { name: 'medical_records', purpose: 'Patient consultation notes (private)', keyFields: ['patient_id', 'doctor_id', 'appointment_id', 'diagnosis', 'notes', 'prescriptions'], ownerScoped: true },
      { name: 'prescriptions', purpose: 'Medication prescriptions from doctors', keyFields: ['record_id', 'patient_id', 'doctor_id', 'medications', 'issued_at', 'expires_at'], ownerScoped: true },
      { name: 'reviews', purpose: 'Patient doctor reviews (public)', keyFields: ['appointment_id', 'patient_id', 'doctor_id', 'rating', 'body'], ownerScoped: true },
      { name: 'notifications', purpose: 'Appointment reminders and alerts', keyFields: ['user_id', 'type', 'title', 'body', 'read_at'], ownerScoped: true },
    ],
    authRoles: ['patient', 'doctor', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'medical-documents', purpose: 'Patient uploaded medical history (private)', isPublic: false },
      { name: 'profile-photos', purpose: 'Doctor and patient profile photos', isPublic: true },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Consultation fee payment', required: false, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Appointment confirmation and reminder emails', required: true, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['appointments', 'notifications'],
    functions: [
      { name: 'appointment_reminder', trigger: 'cron', purpose: 'Send reminder 24h and 1h before appointments' },
      { name: 'slot_release', trigger: 'on_update', table: 'appointments', purpose: 'Restore availability slot when appointment is cancelled' },
      { name: 'access_log', trigger: 'on_insert', table: 'medical_records', purpose: 'Log every access to medical records for audit compliance' },
    ],
    permissions: [
      'Medical records strictly patient-private: only the patient and their treating doctor can read',
      'Prescriptions are doctor-write / patient-read only',
      'Appointment notes visible to both patient and doctor',
      'Doctor profiles and specializations are publicly browsable',
      'Access log is append-only and admin-auditable',
    ],
    productionChecks: [
      'Medical records encryption at rest (sensitive data)',
      'Access log for every medical record read and write',
      'No double-booking: slot lock enforced transactionally',
      'Indexes on appointments.doctor_id+start_at, appointments.patient_id',
      'Soft deletes for all sensitive records (never hard-delete medical data)',
    ],
  },

  crm_platform: {
    productType: 'crm_platform',
    oneLiner: 'CRM platform for managing leads, deals, and customer relationships',
    actors: ['sales_reps', 'managers', 'admin'],
    coreValueExchange: 'Sales teams track contacts and deals through pipelines to close more revenue',
    entities: [
      { name: 'users', purpose: 'Sales team accounts', keyFields: ['email', 'name', 'avatar_url', 'role', 'team_id'], ownerScoped: false },
      { name: 'organizations', purpose: 'Company-level CRM instance', keyFields: ['name', 'plan', 'owner_id'], ownerScoped: false },
      { name: 'pipelines', purpose: 'Sales pipelines (e.g. Inbound, Enterprise)', keyFields: ['organization_id', 'name', 'is_default'], ownerScoped: false },
      { name: 'deal_stages', purpose: 'Pipeline stages (Lead, Qualified, Demo, etc.)', keyFields: ['pipeline_id', 'name', 'position', 'win_probability'], ownerScoped: false },
      { name: 'contacts', purpose: 'Individual leads and customers', keyFields: ['organization_id', 'owner_id', 'name', 'email', 'phone', 'company', 'title', 'status', 'lead_score'], ownerScoped: false },
      { name: 'deals', purpose: 'Active sales opportunities', keyFields: ['organization_id', 'contact_id', 'owner_id', 'stage_id', 'title', 'value', 'status', 'expected_close_date', 'probability'], ownerScoped: false, stateColumn: 'status', states: ['open', 'won', 'lost'] },
      { name: 'activities', purpose: 'Calls, emails, meetings log', keyFields: ['organization_id', 'contact_id', 'deal_id', 'user_id', 'type', 'title', 'notes', 'due_at', 'completed_at'], ownerScoped: false },
      { name: 'notes', purpose: 'Free-form notes on contacts/deals', keyFields: ['organization_id', 'contact_id', 'deal_id', 'author_id', 'body'], ownerScoped: false },
      { name: 'tasks', purpose: 'Follow-up tasks', keyFields: ['organization_id', 'contact_id', 'deal_id', 'assignee_id', 'title', 'due_at', 'completed_at'], ownerScoped: false },
      { name: 'email_logs', purpose: 'Email sent tracking', keyFields: ['contact_id', 'user_id', 'subject', 'opened_at', 'clicked_at', 'replied_at'], ownerScoped: false },
    ],
    authRoles: ['rep', 'manager', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'attachments', purpose: 'Deal and contact document attachments', isPublic: false },
    ],
    integrations: [
      { name: 'resend', purpose: 'Automated deal stage emails and task reminders', required: false, credentialKey: 'RESEND_API_KEY' },
      { name: 'stripe', purpose: 'Deal won → invoice generation (optional)', required: false, credentialKey: 'STRIPE_SECRET_KEY' },
    ],
    realtimeChannels: ['deal_updates', 'notifications'],
    functions: [
      { name: 'deal_stage_notify', trigger: 'on_update', table: 'deals', purpose: 'Notify manager when deal moves to Won or Lost' },
      { name: 'activity_reminder', trigger: 'cron', purpose: 'Remind reps of overdue tasks every morning' },
      { name: 'lead_score_update', trigger: 'on_insert', table: 'activities', purpose: 'Increment lead score on new activity logged' },
    ],
    permissions: [
      'All data scoped to organization_id',
      'Reps see only contacts and deals assigned to them',
      'Managers see all team contacts and deals',
      'Soft deletes on contacts and deals (never hard-delete customer history)',
    ],
    productionChecks: [
      'organization_id on ALL tables (multi-tenant isolation)',
      'Indexes on deals.owner_id+stage_id, contacts.organization_id+status, activities.deal_id',
      'Soft deletes via deleted_at on contacts, deals',
      'Full-text search index on contacts (name, email, company)',
    ],
  },

  ai_saas: {
    productType: 'ai_saas',
    oneLiner: 'Credit-based AI generation platform with async job processing',
    actors: ['users', 'admin'],
    coreValueExchange: 'Users spend credits to submit AI generation requests; the platform processes jobs asynchronously and delivers outputs',
    entities: [
      { name: 'users', purpose: 'Platform user accounts', keyFields: ['email', 'name', 'avatar_url', 'plan'], ownerScoped: false },
      { name: 'organizations', purpose: 'Multi-user workspace (optional)', keyFields: ['name', 'owner_id', 'plan', 'stripe_customer_id'], ownerScoped: false },
      { name: 'api_keys', purpose: 'Programmatic API access keys', keyFields: ['user_id', 'organization_id', 'name', 'key_hash', 'last_used_at', 'credits_used'], ownerScoped: true },
      { name: 'credit_wallets', purpose: 'Current credit balance per user/org', keyFields: ['user_id', 'organization_id', 'balance', 'lifetime_purchased', 'lifetime_used'], ownerScoped: true },
      { name: 'credit_transactions', purpose: 'Immutable credit debit/credit ledger', keyFields: ['wallet_id', 'type', 'amount', 'balance_after', 'reference_id', 'description'], ownerScoped: true },
      { name: 'generation_jobs', purpose: 'AI generation requests queue', keyFields: ['user_id', 'type', 'status', 'prompt', 'model', 'credits_cost', 'result_url', 'error', 'started_at', 'completed_at'], ownerScoped: true, stateColumn: 'status', states: ['queued', 'processing', 'completed', 'failed', 'cancelled'] },
      { name: 'models_config', purpose: 'Available AI models and their credit costs', keyFields: ['provider', 'model_id', 'display_name', 'credits_per_unit', 'is_active', 'capabilities'], ownerScoped: false },
      { name: 'templates', purpose: 'Reusable prompt templates', keyFields: ['user_id', 'name', 'prompt', 'model', 'parameters', 'is_public'], ownerScoped: true },
      { name: 'saved_outputs', purpose: 'User-saved generation results', keyFields: ['user_id', 'job_id', 'title', 'tags', 'is_favorite'], ownerScoped: true },
      { name: 'usage_logs', purpose: 'API usage tracking per key', keyFields: ['api_key_id', 'user_id', 'endpoint', 'model', 'credits_used', 'latency_ms'], ownerScoped: true },
    ],
    authRoles: ['free_user', 'pro_user', 'admin'],
    authProviders: ['email', 'google', 'github'],
    storageBuckets: [
      { name: 'generated-outputs', purpose: 'AI-generated images, files, and documents (private)', isPublic: false },
      { name: 'user-uploads', purpose: 'Input files for AI processing', isPublic: false },
      { name: 'templates-assets', purpose: 'Template preview images', isPublic: true },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Credit bundle purchases and subscription billing', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Job completion notifications and low credit alerts', required: false, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['generation_jobs'],
    functions: [
      { name: 'credit_deduct', trigger: 'on_insert', table: 'generation_jobs', purpose: 'Atomically deduct credits from wallet when job is submitted (reject if insufficient)' },
      { name: 'job_complete_notify', trigger: 'on_update', table: 'generation_jobs', purpose: 'Notify user when their generation job completes or fails' },
      { name: 'credit_purchase', trigger: 'webhook', purpose: 'Add credits to wallet on successful Stripe purchase' },
      { name: 'low_credit_alert', trigger: 'cron', purpose: 'Email users when their credit balance drops below threshold' },
    ],
    permissions: [
      'Users can only see their own jobs, credits, and outputs',
      'Credit deduction is atomic — concurrent jobs cannot overdraft',
      'API keys are hashed — plaintext never stored after creation',
      'Generated outputs accessed via signed URLs only',
      'Admin can view all users, manage credits, and monitor jobs',
    ],
    productionChecks: [
      'Credit deduction in a DB transaction (no overdraft possible)',
      'Signed URLs for all generated output access',
      'API key rate limiting: 60 requests per minute per key',
      'Job queue concurrency control (max concurrent jobs per user)',
      'credit_transactions is append-only (no updates or deletes)',
    ],
  },

  invoicing_saas: {
    productType: 'invoicing_saas',
    oneLiner: 'Invoicing and billing SaaS for freelancers and small businesses',
    actors: ['business_owners', 'clients', 'admin'],
    coreValueExchange: 'Business owners create and send invoices; clients view and pay online',
    entities: [
      { name: 'users', purpose: 'Business owner accounts', keyFields: ['email', 'name', 'avatar_url', 'stripe_account_id'], ownerScoped: false },
      { name: 'organizations', purpose: 'Business profile with branding', keyFields: ['owner_id', 'name', 'logo_url', 'address', 'tax_id', 'currency', 'payment_terms_days'], ownerScoped: true },
      { name: 'clients', purpose: 'Customer/client contacts', keyFields: ['organization_id', 'name', 'email', 'phone', 'company', 'address', 'notes'], ownerScoped: true },
      { name: 'products_services', purpose: 'Reusable catalog items for invoices', keyFields: ['organization_id', 'name', 'description', 'price', 'unit', 'tax_rate'], ownerScoped: true },
      { name: 'invoices', purpose: 'Invoice documents', keyFields: ['organization_id', 'client_id', 'invoice_number', 'issue_date', 'due_date', 'subtotal', 'tax', 'total', 'status', 'stripe_payment_link'], ownerScoped: true, stateColumn: 'status', states: ['draft', 'sent', 'viewed', 'paid', 'overdue', 'cancelled'] },
      { name: 'invoice_items', purpose: 'Line items on an invoice', keyFields: ['invoice_id', 'description', 'quantity', 'unit_price', 'tax_rate', 'subtotal'], ownerScoped: true },
      { name: 'payments', purpose: 'Payment records for invoices', keyFields: ['invoice_id', 'amount', 'method', 'stripe_payment_intent_id', 'paid_at', 'notes'], ownerScoped: true },
      { name: 'expenses', purpose: 'Business expense tracking', keyFields: ['organization_id', 'category', 'amount', 'description', 'receipt_url', 'date', 'is_billable', 'client_id'], ownerScoped: true },
      { name: 'recurring_invoices', purpose: 'Auto-invoice schedule', keyFields: ['organization_id', 'client_id', 'frequency', 'next_send_date', 'template_data', 'is_active'], ownerScoped: true },
    ],
    authRoles: ['owner', 'accountant', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'receipts', purpose: 'Expense receipt uploads', isPublic: false },
      { name: 'invoice-pdfs', purpose: 'Generated invoice PDFs', isPublic: false },
      { name: 'org-logos', purpose: 'Company logos for invoice branding', isPublic: true },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Online invoice payment links and payment processing', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Invoice delivery, payment reminders, receipts', required: true, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['payment_notifications'],
    functions: [
      { name: 'invoice_pdf', trigger: 'on_update', table: 'invoices', purpose: 'Generate PDF and upload to storage when invoice is sent' },
      { name: 'payment_received', trigger: 'webhook', purpose: 'Mark invoice paid and send receipt on Stripe payment success' },
      { name: 'overdue_reminder', trigger: 'cron', purpose: 'Send payment reminder email for invoices past due date' },
      { name: 'recurring_invoice_create', trigger: 'cron', purpose: 'Auto-create next invoice for active recurring schedules' },
    ],
    permissions: [
      'All data scoped to organization_id (multi-business isolation)',
      'Clients can view and pay their own invoices via a public payment link (no auth required)',
      'Only organization owner/accountant can create and manage invoices',
      'Expenses and financial data private to the organization',
    ],
    productionChecks: [
      'organization_id on all records',
      'Invoice number uniqueness per organization (auto-increment or custom format)',
      'Payment idempotency via stripe_payment_intent_id',
      'Overdue cron idempotency (track last_reminder_sent_at)',
      'Indexes on invoices.organization_id+status, invoices.client_id, invoices.due_date',
    ],
  },

  pet_services: {
    productType: 'pet_services',
    oneLiner: 'Pet care marketplace connecting pet owners with sitters, walkers, and groomers',
    actors: ['pet_owners', 'sitters', 'admin'],
    coreValueExchange: 'Pet owners find trusted care for their pets; sitters earn income from pet care services',
    entities: [
      { name: 'users', purpose: 'All accounts', keyFields: ['email', 'name', 'avatar_url', 'role', 'phone'], ownerScoped: false },
      { name: 'sitter_profiles', purpose: 'Sitter service profile', keyFields: ['user_id', 'bio', 'experience_years', 'services_offered', 'location', 'is_verified', 'background_check_at', 'rating', 'total_bookings'], ownerScoped: true },
      { name: 'pets', purpose: 'Pet profiles owned by clients', keyFields: ['owner_id', 'name', 'type', 'breed', 'age', 'weight', 'medical_notes', 'photo_url'], ownerScoped: true },
      { name: 'services', purpose: 'Services a sitter offers with pricing', keyFields: ['sitter_id', 'type', 'name', 'description', 'price_per_unit', 'unit', 'is_active'], ownerScoped: true },
      { name: 'availability', purpose: 'Sitter calendar availability', keyFields: ['sitter_id', 'date', 'start_time', 'end_time', 'is_available', 'max_pets'], ownerScoped: true },
      { name: 'bookings', purpose: 'Pet care appointments', keyFields: ['owner_id', 'sitter_id', 'pet_id', 'service_id', 'start_at', 'end_at', 'total', 'status', 'stripe_payment_intent_id'], ownerScoped: true, stateColumn: 'status', states: ['requested', 'accepted', 'active', 'completed', 'cancelled'] },
      { name: 'check_ins', purpose: 'Sitter updates during care session', keyFields: ['booking_id', 'sitter_id', 'notes', 'photo_url', 'checked_in_at'], ownerScoped: true },
      { name: 'reviews', purpose: 'Post-booking reviews', keyFields: ['booking_id', 'reviewer_id', 'sitter_id', 'pet_id', 'rating', 'body'], ownerScoped: true },
      { name: 'messages', purpose: 'Owner-sitter messaging', keyFields: ['sender_id', 'recipient_id', 'booking_id', 'body', 'read_at'], ownerScoped: true },
      { name: 'payouts', purpose: 'Sitter earnings', keyFields: ['sitter_id', 'booking_id', 'gross', 'platform_fee', 'net', 'status', 'paid_at'], ownerScoped: true },
    ],
    authRoles: ['pet_owner', 'sitter', 'admin'],
    authProviders: ['email', 'google'],
    storageBuckets: [
      { name: 'pet-photos', purpose: 'Pet profile photos', isPublic: true },
      { name: 'sitter-profiles', purpose: 'Sitter profile and portfolio photos', isPublic: true },
      { name: 'check-in-photos', purpose: 'Photo updates sent during care sessions', isPublic: false },
      { name: 'verification-docs', purpose: 'Sitter ID and background check documents', isPublic: false },
    ],
    integrations: [
      { name: 'stripe', purpose: 'Booking payment hold and sitter payout', required: true, credentialKey: 'STRIPE_SECRET_KEY' },
      { name: 'resend', purpose: 'Booking confirmations, check-in photo emails, care reports', required: false, credentialKey: 'RESEND_API_KEY' },
    ],
    realtimeChannels: ['messages', 'check_ins', 'bookings'],
    functions: [
      { name: 'booking_confirm', trigger: 'on_update', table: 'bookings', purpose: 'Send confirmation and sitter details on booking accepted' },
      { name: 'check_in_notify', trigger: 'on_insert', table: 'check_ins', purpose: 'Email photo update to pet owner immediately' },
      { name: 'payout_release', trigger: 'on_update', table: 'bookings', purpose: 'Release held payment to sitter 24h after booking completion' },
    ],
    permissions: [
      'Sitters own their profiles and availability calendar',
      'Pet owners own their pets and can see all bookings for their pets',
      'Check-in photos are owner-private (not publicly accessible)',
      'Background check documents are admin-only',
      'Reviews are public after completion',
    ],
    productionChecks: [
      'Indexes on bookings.sitter_id+start_at, bookings.owner_id, availability.sitter_id+date',
      'No double-booking constraint on sitter availability',
      'Webhook idempotency for Stripe payout events',
      'Check-in photos served via signed URLs (private bucket)',
      'Rate limit booking requests: 5 per owner per hour',
    ],
  },
}

// ── Domain Detection ──────────────────────────────────────────────────────────

const DOMAIN_MATCHERS: Array<{ domain: string; patterns: RegExp[] }> = [
  { domain: 'rental_platform',        patterns: [/\bairbnb\b/i, /\bvrbo\b/i, /\bvacation.?rental\b/i, /\bhome.?sharing\b/i, /\brent.?out.*(home|room|property|space|car|vehicle)/i, /\bshort.?term.?rental\b/i] },
  { domain: 'food_delivery',          patterns: [/\bdoordash\b/i, /\bubereats\b/i, /\bgrubhub\b/i, /\bfood.?delivery\b/i, /\brestaurant.*(delivery|ordering)/i, /\bdelivery.*(food|meal|restaurant)/i] },
  { domain: 'ride_sharing',           patterns: [/\buber\b/i, /\blyft\b/i, /\bride.?(sharing|hailing|app)\b/i, /\bdriver.*rider\b/i, /\bcar.?hailing\b/i] },
  { domain: 'freelance_marketplace',  patterns: [/\bupwork\b/i, /\bfiverr\b/i, /\bfreelance.*(platform|marketplace|app)\b/i, /\bgig.*(platform|economy|marketplace)\b/i, /\bfreelancer.*(hire|market)/i] },
  { domain: 'digital_products',       patterns: [/\bgumroad\b/i, /\bsellfy\b/i, /\bdigital.?product\b/i, /\bdownloadable\b/i, /\bsell.*(ebook|template|course|file|download)/i] },
  { domain: 'edtech_lms',             patterns: [/\bteachable\b/i, /\budemy\b/i, /\bcoursera\b/i, /\blms\b/i, /\b(e.?learning|online.?course|course.?platform|learning.?management)\b/i] },
  { domain: 'subscription_newsletter',patterns: [/\bsubstack\b/i, /\bnewsletter.*(platform|app)\b/i, /\bsubscription.*newsletter\b/i, /\bwriter.*subscriber\b/i, /\bpaid.?newsletter\b/i] },
  { domain: 'event_platform',         patterns: [/\beventbrite\b/i, /\bevent.*(platform|ticketing|management)\b/i, /\bticket.*(sale|system|event)\b/i, /\bconference.*ticket\b/i] },
  { domain: 'pet_services',           patterns: [/\brover\b/i, /\bwag\b/i, /\bpet.*(service|sitter|care|sitting|walking|grooming)\b/i, /\bdog.*(walking|sitting|grooming)\b/i] },
  { domain: 'invoicing_saas',         patterns: [/\bfreshbooks\b/i, /\bquickbooks\b/i, /\binvoic.*(software|app|saas|platform|tool)\b/i, /\bbilling.*software\b/i, /\baccounting.*app\b/i] },
  { domain: 'service_booking',        patterns: [/\bcalendly\b/i, /\bbooksy\b/i, /\bappointment.*(booking|scheduling)\b/i, /\bservice.?(booking|scheduling)\b/i, /\bbooking.*(platform|system|app)\b/i] },
  { domain: 'healthcare_booking',     patterns: [/\bteladoc\b/i, /\bdoctor.*(booking|appointment)\b/i, /\bpatient.*(doctor|clinic|appointment)\b/i, /\bhealth.?care.*(platform|app|booking)\b/i, /\bclinic.?(management|booking|system)\b/i] },
  { domain: 'crm_platform',           patterns: [/\bsalesforce\b/i, /\bhubspot\b/i, /\bpipedrive\b/i, /\bcrm\b/i, /\bcustomer.?relationship/i, /\bsales.?(pipeline|crm|management)\b/i] },
  { domain: 'ai_saas',                patterns: [/\bai.?(saas|tool|platform|app|product)\b/i, /\bgpt.?wrapper\b/i, /\bimage.?generation.*platform\b/i, /\bai.?credit\b/i, /\bcredit.?based.*ai\b/i, /\bai.?api.?platform\b/i] },
  { domain: 'job_board',              patterns: [/\bjob.?(board|listing|portal|site)\b/i, /\bjob.?market(place)?\b/i, /\brecruit(ment|ing).*(platform|app)\b/i, /\bhiring.?(platform|portal|board)\b/i] },
  { domain: 'social_app',             patterns: [/\binstagram\b/i, /\btwitter\b/i, /\bsocial.?(app|network|media|platform)\b/i, /\bfeed.*(follower|post)\b/i, /\blike.*comment.*follow\b/i] },
  { domain: 'saas_platform',          patterns: [/\bsaas\b.*\b(b2b|team|organization|workspace)\b/i, /\bmulti.?tenant\b/i, /\bteam.?(workspace|collaboration|management)\b/i, /\bb2b.?saas\b/i] },
  { domain: 'marketplace',            patterns: [/\betsy\b/i, /\bebay\b/i, /\bmarketplace\b/i, /\bhandmade.*(sell|market|store)\b/i, /\btwo.?sided.*(platform|market)\b/i, /\bseller.*buyer\b/i] },
  { domain: 'ecommerce_store',        patterns: [/\bshopify\b/i, /\bwoocommerce\b/i, /\becommerce\b/i, /\be.?commerce\b/i, /\bonline.?store\b/i, /\bcart.*checkout\b/i, /\bproduct.*store.*buy\b/i] },
  { domain: 'invoicing_saas',         patterns: [/\binvoic/i, /\bbillin.*tool\b/i] },
]

function detectProductDomain(prompt: string): string | null {
  const lower = prompt.toLowerCase()

  for (const { domain, patterns } of DOMAIN_MATCHERS) {
    for (const pattern of patterns) {
      if (pattern.test(lower)) return domain
    }
  }
  return null
}

// ── Autonomous goal detection ─────────────────────────────────────────────────

const AUTONOMOUS_GOAL_STARTERS = /^(build|create|make|set up|setup|develop|generate|give me|i want|i need|i'm building|we need|we want|help me build|help me create|scaffold|bootstrap)\s+(me\s+)?(a|an|the|my|our)\s+/i

const AUTONOMOUS_GOAL_KEYWORDS = [
  'marketplace', 'platform', 'saas', 'backend for', 'backend like', 'app like',
  'system like', 'delivery app', 'social app', 'booking platform', 'ecommerce',
  'invoicing app', 'crm', 'lms', 'job board', 'clone',
]

const PRIMITIVE_KEYWORDS = /^(add|create|delete|remove|list|show|fix|update|drop|alter|rotate|scan|deploy)\s+(a\s+)?(column|table|field|bucket|trigger|function|key|index|api|route|permission)/i

export function isAutonomousGoal(message: string): boolean {
  if (!message || message.length < 20 || message.length > 600) return false

  const trimmed = message.trim()
  const lower = trimmed.toLowerCase()

  // Skip questions
  if (trimmed.endsWith('?')) return false

  // Skip direct primitive commands (short, specific)
  if (trimmed.length < 80 && PRIMITIVE_KEYWORDS.test(lower)) return false

  // Starts with a product-building verb phrase
  if (AUTONOMOUS_GOAL_STARTERS.test(lower)) return true

  // Contains domain-level keywords
  for (const kw of AUTONOMOUS_GOAL_KEYWORDS) {
    if (lower.includes(kw)) return true
  }

  // Brand-name clones
  if (/\b(airbnb|uber|etsy|upwork|gumroad|shopify|substack|teachable|eventbrite|fiverr|rover|doordash|freshbooks|salesforce|hubspot)\b.*(for|but|like|style|clone|inspired)\b/i.test(lower)) return true
  if (/\blike\s+(airbnb|uber|etsy|upwork|gumroad|shopify|substack|teachable|eventbrite|fiverr|rover|doordash)\b/i.test(lower)) return true

  return false
}

// ── Blueprint Generation ──────────────────────────────────────────────────────

function buildBlueprintFromProfile(profile: DomainProfile): ProductBlueprint {
  return {
    productType: profile.productType,
    oneLiner: profile.oneLiner,
    actors: profile.actors,
    coreValueExchange: profile.coreValueExchange,
    entities: profile.entities,
    authRoles: profile.authRoles,
    authProviders: profile.authProviders,
    storageBuckets: profile.storageBuckets,
    integrations: profile.integrations,
    realtimeChannels: profile.realtimeChannels,
    functions: profile.functions,
    permissions: profile.permissions,
    productionChecks: profile.productionChecks,
    planSummary: '',
  }
}

function buildPlanSummary(blueprint: ProductBlueprint, productName: string): string {
  const lines: string[] = []
  lines.push(`Building: ${productName}`)
  lines.push(`Type: ${blueprint.productType} — ${blueprint.oneLiner}`)
  lines.push(`Actors: ${blueprint.actors.join(', ')}`)
  lines.push('')
  lines.push(`SCHEMA (${blueprint.entities.length} tables): ${blueprint.entities.map(e => e.name).join(', ')}`)
  lines.push('')
  lines.push(`AUTH: roles [${blueprint.authRoles.join(', ')}] | providers [${blueprint.authProviders.join(', ')}]`)
  lines.push('')
  if (blueprint.storageBuckets.length > 0) {
    lines.push(`STORAGE:`)
    for (const b of blueprint.storageBuckets) lines.push(`  • ${b.name} (${b.isPublic ? 'public' : 'private'}) — ${b.purpose}`)
    lines.push('')
  }
  if (blueprint.integrations.length > 0) {
    lines.push(`INTEGRATIONS:`)
    for (const i of blueprint.integrations) lines.push(`  • ${i.name.toUpperCase()} (${i.required ? 'required' : 'optional'}) — ${i.purpose}`)
    lines.push('')
  }
  if (blueprint.realtimeChannels.length > 0) {
    lines.push(`REALTIME channels: ${blueprint.realtimeChannels.join(', ')}`)
    lines.push('')
  }
  if (blueprint.functions.length > 0) {
    lines.push(`FUNCTIONS:`)
    for (const f of blueprint.functions) lines.push(`  • ${f.name}(${f.trigger}${f.table ? ':' + f.table : ''}) — ${f.purpose}`)
    lines.push('')
  }
  if (blueprint.permissions.length > 0) {
    lines.push(`PERMISSIONS:`)
    for (const p of blueprint.permissions) lines.push(`  • ${p}`)
    lines.push('')
  }
  if (blueprint.productionChecks.length > 0) {
    lines.push(`PRODUCTION:`)
    for (const c of blueprint.productionChecks) lines.push(`  • ${c}`)
  }
  return lines.join('\n')
}

function extractProductName(prompt: string, blueprint: ProductBlueprint): string {
  // Try to extract a meaningful product name from the prompt
  const lower = prompt.toLowerCase()

  // "build me an Airbnb for pets" → "Pet Care Platform"
  // "create a marketplace for handmade goods" → "Handmade Goods Marketplace"
  const forPattern = /(?:for|about|around)\s+([a-z\s]+?)(?:\s+(?:and|with|where|that|which)|$)/i
  const forMatch = prompt.match(forPattern)
  if (forMatch) {
    const qualifier = forMatch[1].trim()
    const typeName = blueprint.productType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    if (qualifier.length < 40) {
      return `${qualifier.replace(/\b\w/g, c => c.toUpperCase())} ${typeName}`
    }
  }

  // Generic: "build me a food delivery app" → "Food Delivery Platform"
  const genericMatch = prompt.match(/(?:build|create|make)\s+(?:me\s+)?(?:a|an)\s+([a-z\s]+?)(?:\s+(?:app|platform|system|backend|service|tool)|$)/i)
  if (genericMatch) {
    const name = genericMatch[1].trim()
    if (name.length > 3 && name.length < 40) {
      return name.replace(/\b\w/g, c => c.toUpperCase()) + ' Platform'
    }
  }

  return blueprint.oneLiner
}

async function generateBlueprintWithLLM(
  prompt: string,
  context: { existingTables?: string[] },
): Promise<ProductBlueprint> {
  const openai = getOpenAIClient()

  const response = await openai.chat.completions.create({
    model: getModel('plan'),
    messages: [
      {
        role: 'system',
        content: `You are a senior backend architect. Analyze this product description and output a comprehensive backend blueprint.

Output ONLY valid JSON with this exact structure:
{
  "productType": string,
  "oneLiner": string,
  "actors": string[],
  "coreValueExchange": string,
  "entities": [{ "name": string, "purpose": string, "keyFields": string[], "ownerScoped": boolean, "stateColumn": string|null, "states": string[]|null }],
  "authRoles": string[],
  "authProviders": string[],
  "storageBuckets": [{ "name": string, "purpose": string, "isPublic": boolean }],
  "integrations": [{ "name": string, "purpose": string, "required": boolean, "credentialKey": string }],
  "realtimeChannels": string[],
  "functions": [{ "name": string, "trigger": string, "table": string|null, "purpose": string }],
  "permissions": string[],
  "productionChecks": string[]
}

Rules:
- entities: include ALL tables a real production version needs (10-15 tables minimum for complex apps)
- authRoles: match the actual user types in the product
- storageBuckets: only include if product genuinely needs file storage
- integrations: stripe if payments involved, resend if emails involved
- realtimeChannels: only tables that need live updates (messages, orders, jobs)
- functions: serverless triggers that handle key business events
- permissions: plain text rules enforcing data ownership
- productionChecks: specific index, constraint, and rate limiting requirements`,
      },
      {
        role: 'user',
        content: `Design a comprehensive backend blueprint for: "${prompt}"`,
      },
    ],
    temperature: 0.1,
    max_tokens: 3000,
    response_format: { type: 'json_object' },
  })

  const raw = response.choices[0].message.content || '{}'
  const parsed = JSON.parse(raw)

  const blueprint: ProductBlueprint = {
    productType: parsed.productType || 'custom',
    oneLiner: parsed.oneLiner || prompt,
    actors: Array.isArray(parsed.actors) ? parsed.actors : ['users'],
    coreValueExchange: parsed.coreValueExchange || '',
    entities: Array.isArray(parsed.entities) ? parsed.entities.map((e: any) => ({
      name: String(e.name || '').toLowerCase(),
      purpose: String(e.purpose || ''),
      keyFields: Array.isArray(e.keyFields) ? e.keyFields : [],
      ownerScoped: Boolean(e.ownerScoped),
      stateColumn: e.stateColumn || undefined,
      states: Array.isArray(e.states) ? e.states : undefined,
    })) : [],
    authRoles: Array.isArray(parsed.authRoles) ? parsed.authRoles : ['user'],
    authProviders: Array.isArray(parsed.authProviders) ? parsed.authProviders : ['email'],
    storageBuckets: Array.isArray(parsed.storageBuckets) ? parsed.storageBuckets : [],
    integrations: Array.isArray(parsed.integrations) ? parsed.integrations : [],
    realtimeChannels: Array.isArray(parsed.realtimeChannels) ? parsed.realtimeChannels : [],
    functions: Array.isArray(parsed.functions) ? parsed.functions : [],
    permissions: Array.isArray(parsed.permissions) ? parsed.permissions : [],
    productionChecks: Array.isArray(parsed.productionChecks) ? parsed.productionChecks : [],
    planSummary: '',
  }

  blueprint.planSummary = buildPlanSummary(blueprint, extractProductName(prompt, blueprint))
  return blueprint
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a comprehensive ProductBlueprint from a high-level product description.
 * Fast path: < 5ms (template match). Slow path: < 3s (LLM reasoning).
 */
export async function understandGoal(
  prompt: string,
  context: { existingTables?: string[] } = {},
): Promise<ProductBlueprint> {
  const domain = detectProductDomain(prompt)

  if (domain && DOMAIN_PROFILES[domain]) {
    const profile = DOMAIN_PROFILES[domain]
    const blueprint = buildBlueprintFromProfile(profile)
    const productName = extractProductName(prompt, blueprint)
    blueprint.planSummary = buildPlanSummary(blueprint, productName)
    return blueprint
  }

  // LLM fallback for novel products
  return generateBlueprintWithLLM(prompt, context)
}

/**
 * Format a blueprint as a rich context string for LLM prompts.
 * Injected into the effective goal so the build runtime uses it.
 */
export function blueprintToContextString(blueprint: ProductBlueprint): string {
  const lines: string[] = [
    `[Product Blueprint: ${blueprint.productType}]`,
    `One-liner: ${blueprint.oneLiner}`,
    `Actors: ${blueprint.actors.join(', ')}`,
    `Core value: ${blueprint.coreValueExchange}`,
    '',
    `Tables to build: ${blueprint.entities.map(e => e.name).join(', ')}`,
    '',
    `Auth roles: ${blueprint.authRoles.join(', ')}`,
    `Auth providers: ${blueprint.authProviders.join(', ')}`,
  ]

  if (blueprint.storageBuckets.length > 0) {
    lines.push(`Storage buckets: ${blueprint.storageBuckets.map(b => `${b.name}(${b.isPublic ? 'public' : 'private'})`).join(', ')}`)
  }

  if (blueprint.integrations.length > 0) {
    lines.push(`Integrations: ${blueprint.integrations.map(i => `${i.name}(${i.required ? 'required' : 'optional'})`).join(', ')}`)
  }

  if (blueprint.realtimeChannels.length > 0) {
    lines.push(`Realtime channels: ${blueprint.realtimeChannels.join(', ')}`)
  }

  if (blueprint.functions.length > 0) {
    lines.push(`Functions: ${blueprint.functions.map(f => `${f.name}(trigger:${f.trigger})`).join(', ')}`)
  }

  if (blueprint.permissions.length > 0) {
    lines.push('Permissions:')
    blueprint.permissions.forEach(p => lines.push(`  - ${p}`))
  }

  if (blueprint.productionChecks.length > 0) {
    lines.push('Production requirements:')
    blueprint.productionChecks.forEach(c => lines.push(`  - ${c}`))
  }

  return lines.join('\n')
}
