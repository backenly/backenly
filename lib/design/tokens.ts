/**
 * Unified Design System for Backenly
 * All pages should reference these tokens for consistency
 */

export const designTokens = {
  // Colors
  colors: {
    // Backgrounds
    bg: {
      base: '#000000',        // Pure black for hero/primary
      surface: '#0A0E1A',     // Darkest surfaces
      elevated: '#111827',    // Elevated surfaces (cards, modals)
      secondary: '#0F1419',   // Secondary sections
      hover: '#1A1F2E',       // Hover states
    },

    // Text
    text: {
      primary: '#FFFFFF',       // White - primary text
      secondary: '#E6E8EF',     // Light gray - secondary text
      tertiary: '#9AA3B2',      // Medium gray - muted text
      muted: '#6B7280',         // Dark gray - hints
    },

    // Accents - Primary is purple/blue
    accent: {
      primary: '#7C3AED',       // Purple-600
      primaryHover: '#6D28D9',  // Purple-700
      light: '#A78BFA',         // Purple-400
      lighter: '#DDD6FE',       // Purple-200
    },

    // Secondary accent (blue for variety)
    secondary: {
      primary: '#3B82F6',       // Blue-500
      hover: '#2563EB',         // Blue-600
      light: '#60A5FA',         // Blue-400
    },

    // Status colors
    success: '#10B981',         // Emerald-500
    warning: '#F59E0B',         // Amber-500
    danger: '#EF4444',          // Red-500
    info: '#06B6D4',            // Cyan-500

    // Borders
    border: {
      subtle: 'rgba(255, 255, 255, 0.05)',  // Subtle borders
      default: 'rgba(255, 255, 255, 0.1)',  // Standard borders
      hover: 'rgba(255, 255, 255, 0.15)',   // Hover borders
    },
  },

  // Spacing (consistent with Tailwind)
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    '2xl': '32px',
    '3xl': '48px',
  },

  // Border radius
  radius: {
    sm: '6px',
    md: '8px',
    lg: '12px',
    xl: '16px',
  },

  // Shadows
  shadows: {
    sm: '0 1px 2px rgba(0, 0, 0, 0.05)',
    md: '0 4px 6px rgba(0, 0, 0, 0.1)',
    lg: '0 10px 15px rgba(0, 0, 0, 0.1)',
    xl: '0 20px 25px rgba(0, 0, 0, 0.15)',
  },

  // Typography
  typography: {
    // Headings
    'heading-lg': {
      fontSize: '32px',
      fontWeight: '700',
      lineHeight: '1.2',
    },
    'heading-md': {
      fontSize: '24px',
      fontWeight: '700',
      lineHeight: '1.3',
    },
    'heading-sm': {
      fontSize: '18px',
      fontWeight: '600',
      lineHeight: '1.4',
    },

    // Body
    'body-lg': {
      fontSize: '16px',
      fontWeight: '400',
      lineHeight: '1.6',
    },
    'body-md': {
      fontSize: '14px',
      fontWeight: '400',
      lineHeight: '1.5',
    },
    'body-sm': {
      fontSize: '12px',
      fontWeight: '400',
      lineHeight: '1.4',
    },

    // Labels
    'label': {
      fontSize: '12px',
      fontWeight: '500',
      lineHeight: '1.4',
    },
  },
}
