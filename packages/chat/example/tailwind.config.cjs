/** The consumer setup `@librechat/client`'s theme README documents. */
module.exports = {
  presets: [require('@librechat/client/tailwind-preset')],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../src/**/*.{ts,tsx}',
    '../../client/dist/**/*.{js,mjs,cjs}',
  ],
  darkMode: ['class'],
};
