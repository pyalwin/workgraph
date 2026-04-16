/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        surface: '#ffffff',
        bg: '#fafafa',
        g1: '#111111',
        g2: '#333333',
        g3: '#555555',
        g4: '#777777',
        g5: '#999999',
        g6: '#bbbbbb',
        g7: '#dddddd',
        g8: '#eeeeee',
        g9: '#f5f5f5',
        accent: {
          green: '#1a8754',
          'green-soft': 'rgba(26,135,84,0.08)',
          red: '#c53030',
          'red-soft': 'rgba(197,48,48,0.08)',
        },
      },
      borderRadius: {
        card: '14px',
      },
    },
  },
  plugins: [],
};
