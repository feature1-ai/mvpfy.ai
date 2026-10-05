/** @type {import('tailwindcss').Config} */
const defaultTheme = require('tailwindcss/defaultTheme');

module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Shared workspace palette: neutral surfaces with semantic status colors.
        paper: '#F6F7F9',
        surface: '#FFFFFF',
        sunken: '#F8F9FB',
        hoverfill: '#EDEFF3',
        line: '#E0E3E9',
        'line-subtle': '#ECEEF2',
        ink: { DEFAULT: '#1B1A17', hover: '#33302B' },
        body: '#505766',
        muted: '#697180',
        faint: '#747C89',
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
        // Brand purple. No longer only the logo: it is the accent the workspace
        // marks "you are here" with — the open tab, the selected project, the
        // focus ring — so it carries meaning now and not just identity.
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
