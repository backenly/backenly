/**
 * MARKETPLACE / E-COMMERCE BLUEPRINT
 * ==================================
 * Full backend for any marketplace-class app (Shopify / Etsy / Amazon /
 * StockX). Buyer + seller surfaces, payments, reviews, wishlists, refunds.
 *
 * Tables (15): users, addresses, sellers, categories, products,
 *   product_variants, product_images, cart_items, wishlist, orders,
 *   order_items, payments, refunds, reviews, shipping_methods
 * Storage: product-images bucket (public-read)
 * Realtime: orders, payments, cart_items
 * Triggers: notify on new order, payment captured, refund
 */

import type { Blueprint, BlueprintColumn } from './types'

const col = (n: string, t: BlueprintColumn['type'], o: Partial<BlueprintColumn> = {}): BlueprintColumn => ({ name: n, type: t, ...o })
const createTable = (label: string, tableName: string, columns: BlueprintColumn[]) => ({ label, tool: 'create_table', args: { tableName, columns } })
const generateApi = (tableName: string) => ({ label: `Generate REST API for ${tableName}`, tool: 'generate_api', args: { tableName } })
const addRls = (tableName: string, policy: string, label?: string) => ({ label: label ?? `Lock down ${tableName} with ${policy} RLS`, tool: 'add_rls', args: { tableName, policy } })
const enableRealtime = (tableName: string) => ({ label: `Stream realtime changes on ${tableName}`, tool: 'enable_realtime', args: { tableName } })
const createTrigger = (tableName: string, on: 'insert' | 'update' | 'delete') => ({ label: `Add ${on} trigger on ${tableName}`, tool: 'create_trigger', args: { tableName, on, kind: 'notify' } })

export const MARKETPLACE_BLUEPRINT: Blueprint = {
  domain: 'marketplace',
  title: 'Marketplace Backend',
  summary:
    '15 tables (products, variants, images, cart, wishlist, orders, payments, ' +
    'refunds, reviews, sellers, addresses, shipping), product image storage, ' +
    'realtime on orders + payments + cart, notify-on-order triggers.',
  steps: [
    { label: 'Enable end-user authentication (email + password)', tool: 'enable_auth', args: {} },

    createTable('Create addresses (shipping + billing)', 'addresses', [
      col('user_id', 'uuid'),
      col('line1', 'text'),
      col('line2', 'text', { nullable: true }),
      col('city', 'text'),
      col('state', 'text', { nullable: true }),
      col('postal_code', 'text'),
      col('country', 'text'),
      col('is_default', 'boolean', { nullable: true }),
      col('kind', 'text'),               // shipping | billing
    ]),

    createTable('Create sellers (storefront entities)', 'sellers', [
      col('user_id', 'uuid', { unique: true }),
      col('store_name', 'text', { unique: true }),
      col('description', 'text', { nullable: true }),
      col('logo_url', 'text', { nullable: true }),
      col('rating', 'numeric', { nullable: true }),
      col('payout_method', 'text', { nullable: true }),
    ]),

    createTable('Create categories (nested via parent)', 'categories', [
      col('name', 'text'),
      col('slug', 'text', { unique: true }),
      col('parent_id', 'uuid', { fkTo: 'categories', nullable: true }),
      col('image_url', 'text', { nullable: true }),
    ]),

    createTable('Create products', 'products', [
      col('seller_id', 'uuid', { fkTo: 'sellers' }),
      col('category_id', 'uuid', { fkTo: 'categories', nullable: true }),
      col('title', 'text'),
      col('description', 'text', { nullable: true }),
      col('price', 'numeric'),
      col('currency', 'text'),
      col('stock', 'int'),
      col('sku', 'text', { unique: true, nullable: true }),
      col('is_active', 'boolean', { nullable: true }),
      col('avg_rating', 'numeric', { nullable: true }),
      col('review_count', 'int', { nullable: true }),
    ]),

    createTable('Create product_variants (size/color/etc.)', 'product_variants', [
      col('product_id', 'uuid', { fkTo: 'products' }),
      col('name', 'text'),
      col('value', 'text'),
      col('price_delta', 'numeric', { nullable: true }),
      col('stock', 'int', { nullable: true }),
      col('sku', 'text', { unique: true, nullable: true }),
    ]),

    createTable('Create product_images (gallery)', 'product_images', [
      col('product_id', 'uuid', { fkTo: 'products' }),
      col('url', 'text'),
      col('alt_text', 'text', { nullable: true }),
      col('position', 'int', { nullable: true }),
    ]),

    createTable('Create cart_items (per-user)', 'cart_items', [
      col('user_id', 'uuid'),
      col('product_id', 'uuid', { fkTo: 'products' }),
      col('variant_id', 'uuid', { fkTo: 'product_variants', nullable: true }),
      col('quantity', 'int'),
      col('price_at_add', 'numeric'),
    ]),

    createTable('Create wishlist', 'wishlist', [
      col('user_id', 'uuid'),
      col('product_id', 'uuid', { fkTo: 'products' }),
    ]),

    createTable('Create shipping_methods', 'shipping_methods', [
      col('name', 'text'),
      col('description', 'text', { nullable: true }),
      col('price', 'numeric'),
      col('estimated_days', 'int', { nullable: true }),
      col('is_active', 'boolean', { nullable: true }),
    ]),

    createTable('Create orders', 'orders', [
      col('user_id', 'uuid'),
      col('status', 'text'),              // pending | paid | shipped | delivered | cancelled
      col('subtotal', 'numeric'),
      col('shipping_total', 'numeric', { nullable: true }),
      col('tax_total', 'numeric', { nullable: true }),
      col('total', 'numeric'),
      col('currency', 'text'),
      col('shipping_address_id', 'uuid', { fkTo: 'addresses', nullable: true }),
      col('billing_address_id', 'uuid', { fkTo: 'addresses', nullable: true }),
      col('shipping_method_id', 'uuid', { fkTo: 'shipping_methods', nullable: true }),
      col('tracking_number', 'text', { nullable: true }),
      col('placed_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create order_items', 'order_items', [
      col('order_id', 'uuid', { fkTo: 'orders' }),
      col('product_id', 'uuid', { fkTo: 'products' }),
      col('variant_id', 'uuid', { fkTo: 'product_variants', nullable: true }),
      col('seller_id', 'uuid', { fkTo: 'sellers' }),
      col('quantity', 'int'),
      col('unit_price', 'numeric'),
      col('line_total', 'numeric'),
    ]),

    createTable('Create payments', 'payments', [
      col('order_id', 'uuid', { fkTo: 'orders', unique: true }),
      col('user_id', 'uuid'),
      col('provider', 'text'),            // stripe | paddle | razorpay
      col('provider_payment_id', 'text', { nullable: true }),
      col('amount', 'numeric'),
      col('currency', 'text'),
      col('status', 'text'),              // pending | succeeded | failed | refunded
      col('captured_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create refunds', 'refunds', [
      col('payment_id', 'uuid', { fkTo: 'payments' }),
      col('order_id', 'uuid', { fkTo: 'orders' }),
      col('amount', 'numeric'),
      col('reason', 'text', { nullable: true }),
      col('status', 'text'),              // requested | approved | issued | denied
      col('issued_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create reviews', 'reviews', [
      col('product_id', 'uuid', { fkTo: 'products' }),
      col('user_id', 'uuid'),
      col('order_item_id', 'uuid', { fkTo: 'order_items', nullable: true }),
      col('rating', 'int'),
      col('title', 'text', { nullable: true }),
      col('body', 'text', { nullable: true }),
    ]),

    generateApi('addresses'),
    generateApi('sellers'),
    generateApi('categories'),
    generateApi('products'),
    generateApi('product_variants'),
    generateApi('product_images'),
    generateApi('cart_items'),
    generateApi('wishlist'),
    generateApi('shipping_methods'),
    generateApi('orders'),
    generateApi('order_items'),
    generateApi('payments'),
    generateApi('refunds'),
    generateApi('reviews'),

    addRls('sellers', 'public_read', 'Sellers are public-read, owner-only write'),
    addRls('categories', 'public_read', 'Categories are public-read'),
    addRls('products', 'public_read', 'Products are public-read, seller-only write'),
    addRls('product_variants', 'public_read'),
    addRls('product_images', 'public_read'),
    addRls('shipping_methods', 'public_read'),
    addRls('reviews', 'public_read', 'Reviews are public-read, owner-only write'),
    addRls('addresses', 'owner_read_write'),
    addRls('cart_items', 'owner_read_write'),
    addRls('wishlist', 'owner_read_write'),
    addRls('orders', 'owner_read_write'),
    addRls('order_items', 'owner_read_write'),
    addRls('payments', 'owner_read_write'),
    addRls('refunds', 'owner_read_write'),

    enableRealtime('orders'),
    enableRealtime('payments'),
    enableRealtime('cart_items'),
    enableRealtime('order_items'),

    createTrigger('orders', 'insert'),
    createTrigger('payments', 'insert'),
    createTrigger('payments', 'update'),
    createTrigger('refunds', 'insert'),

    {
      label: 'Create product-images bucket (public-read, seller-only write)',
      tool: 'create_bucket',
      args: { bucketName: 'product-images', isPublic: true },
    },

    {
      label: 'Generate aggregate /stats/summary endpoint (revenue, orders, top products)',
      tool: 'generate_aggregate_api',
      args: { name: 'summary' },
    },
  ],
  warnings: [
    'RLS is on. Unauthenticated tests against owner-only tables will return permission denied. That is correct.',
    'Payment provider integration (Stripe / Paddle / Razorpay) requires a separate Connect step in the IAM tab once you have keys.',
  ],
}
