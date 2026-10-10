module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
  plugins: ['babel-plugin-replace-ts-export-assignment'],
};
