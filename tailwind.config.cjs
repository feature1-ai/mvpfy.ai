/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // mvpfy logo palette
        brand: {
          DEFAULT: '#623883',
          light: '#A25ED8',
          hover: '#7a4aa3',
          dark: '#3e2354',
        },
      },
    },
  },
  plugins: [],
};
