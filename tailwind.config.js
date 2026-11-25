/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#dbe6fe',
          200: '#bfd3fe',
          300: '#93b4fd',
          400: '#6090fa',
          500: '#3b6ef6',
          600: '#2551eb',
          700: '#1d3ed8',
          800: '#1e35af',
          900: '#1e328a',
        },
        ink: {
          50: '#f7f8fa',
          100: '#eff1f5',
          200: '#e2e6ed',
          300: '#cbd2dd',
          400: '#98a2b3',
          500: '#667085',
          600: '#4a5568',
          700: '#344054',
          800: '#1d2939',
          900: '#101828',
        },
        amazon: '#ff9900',
        tiktok: '#161823',
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Segoe UI"',
          'sans-serif',
        ],
        num: ['"DIN Alternate"', 'Inter', '"Segoe UI"', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.04)',
        pop: '0 12px 32px -8px rgba(16,24,40,.18), 0 4px 8px -4px rgba(16,24,40,.08)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-up': 'fade-up .28s ease-out both',
        'scale-in': 'scale-in .18s ease-out both',
      },
    },
  },
  plugins: [],
}
