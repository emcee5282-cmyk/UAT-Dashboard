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
        // shadcn tokens — declared here too (not just globals.css's `@theme
        // inline` block) because this project mixes the legacy `@config`
        // directive with Tailwind v4's CSS-first `@theme` syntax, and
        // tokens that exist ONLY in `@theme` silently fail to generate a
        // working utility (bg-primary computed to transparent, confirmed
        // via getComputedStyle) — @config takes precedence, so anything
        // meant to work as a real utility class must also be listed here.
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        input: 'var(--input)',
        ring: 'var(--ring)',
      },
    },
  },
}
