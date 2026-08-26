module.exports = {
  preset: 'react-native',
  setupFiles: ['./jest.setup.js'],
  // @react-navigation ships untranspiled ESM; transform it (pnpm-aware).
  transformIgnorePatterns: [
    'node_modules/(?!(.pnpm/)?((jest-)?react-native|@react-native(-community)?|@react-navigation))',
  ],
};
