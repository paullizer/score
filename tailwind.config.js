/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--cp-bg)',
        surface: 'var(--cp-surface)',
        soft: 'var(--cp-surface-soft)',
        line: 'var(--cp-border)',
        ink: 'var(--cp-text)',
        muted: 'var(--cp-text-muted)',
        accent: 'var(--cp-accent)',
        'accent-soft': 'var(--cp-accent-soft)',
      },
      fontFamily: {
        sans: ['Segoe UI', 'Aptos', 'Calibri', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['Consolas', 'Courier New', 'Courier', 'monospace'],
      },
    },
  },
  plugins: [],
}
