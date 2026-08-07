/** @type {import('tailwindcss').Config} */
const defaultTheme = require('tailwindcss/defaultTheme');

module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Redesign palette (design_handoff_mvpfy_shell)
        paper: '#F7F5F1',
        surface: '#FFFFFF',
        sunken: '#FAF8F4',
        hoverfill: '#EFEBE3',
        line: '#E4E0D8',
        'line-subtle': '#EFEBE3',
        ink: { DEFAULT: '#1B1A17', hover: '#33302B' },
        body: '#57534C',
        muted: '#8A857C',
        faint: '#A8A296',
        'dot-idle': '#C9C3B8',
        go: {
          DEFAULT: '#1F7A4C',
          hover: '#155B38',
          bg: '#F2F9F5',
          bgalt: '#E9F4EE',
          border: '#CBE5D8',
        },
        warn: { bg: '#FBF1DC', border: '#EBD9AE', text: '#8A5A00' },
        danger: { DEFAULT: '#A32B22', hover: '#7E1F18' },
        // Legacy brand purple — retained for the logo and design-sync previews.
        brand: {
          DEFAULT: '#623883',
          light: '#A25ED8',
          hover: '#7a4aa3',
          dark: '#3e2354',
        },
      },
      fontFamily: {
        sans: ['IBM Plex Sans', ...defaultTheme.fontFamily.sans],
        mono: ['IBM Plex Mono', ...defaultTheme.fontFamily.mono],
      },
    },
  },
  plugins: [],
};
