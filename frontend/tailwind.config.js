/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"DM Serif Display"', 'Georgia', 'serif'],
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Menlo', 'monospace'],
      },
      colors: {
        civic: {
          bg: '#FAFAF7',
          surface: '#FFFFFF',
          elevated: '#F5F3EF',
          border: '#DBD6CD',
          'border-light': '#CCC6BB',
          text: '#1A1815',
          muted: '#4A453E',
          dim: '#7A756C',
          gold: '#A67C2E',
          'gold-light': '#BF9434',
          'gold-dim': '#C9AB5C',
          teal: '#1B7A6E',
          coral: '#C2453B',
          amber: '#B87D2E',
        },
      },
      animation: {
        'fade-up': 'fadeUp 0.6s ease-out both',
        'fade-in': 'fadeIn 0.5s ease-out both',
        'slide-right': 'slideRight 0.3s ease-out both',
      },
      keyframes: {
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(20px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideRight: {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
};
