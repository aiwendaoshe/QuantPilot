/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/renderer/src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        bull: '#ef4444', // A股涨 = 红
        bear: '#22c55e', // A股跌 = 绿
        panel: '#11161f',
        panel2: '#1a212e',
        edge: '#2a3342',
        accent: '#f59e0b',
        warn: '#fbbf24', // 提示色（演示数据标记等）
      },
    },
  },
  plugins: [],
};
