module.exports = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Dark mode warm dark (not pure black)
        dark: {
          bg: '#1c1c1e',
          card: '#2a2a2d',
          border: '#3a3a3d',
        },
        border: 'var(--border)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
      },
    },
  },
}
