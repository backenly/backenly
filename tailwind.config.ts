import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Premium Dark Theme — Black + White + Emerald
        bg: {
          base: '#101116',
          surface: '#16171d',
          elevated: '#202129',
        },
        border: {
          default: 'rgba(255, 255, 255, 0.06)',
          subtle: 'rgba(255, 255, 255, 0.03)',
        },
        accent: {
          primary: '#fafafa',
          hover: '#e4e4e7',
        },
        semantic: {
          success: '#10b981',
          warning: '#a1a1aa',
          danger: '#EF4444',
        },
        text: {
          primary: '#fafafa',
          secondary: '#a1a1aa',
          muted: '#52525b',
        },
      },
      spacing: {
        '1': '4px',
        '2': '8px',
        '3': '12px',
        '4': '16px',
        '6': '24px',
        '8': '32px',
        '12': '48px',
      },
      fontSize: {
        'page-title': '24px',
        'section-title': '18px',
        'body': '14px',
        'label': '12px',
      },
      maxWidth: {
        'container': '1440px',
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'SF Mono', 'Monaco', 'Consolas', 'monospace'],
      },
      transitionTimingFunction: {
        'linear': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'lift': 'lift 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        lift: {
          '0%': { transform: 'translateY(0)' },
          '100%': { transform: 'translateY(-2px)' },
        },
      },
    },
  },
  plugins: [],
}
export default config
