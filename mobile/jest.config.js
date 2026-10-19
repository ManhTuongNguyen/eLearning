module.exports = {
  preset: 'react-native',
  setupFiles: ['./jest.setup.js'],
  // @react-navigation ships untranspiled ESM; transform it (pnpm-aware).
  // react-native-svg and its lucide consumers are resolved through their
  // react-native/ESM entries in some cases, so they must be transformed too
  // (TASK-SENT-001).
  transformIgnorePatterns: [
    'node_modules/(?!(.pnpm/)?((jest-)?react-native|@react-native(-community)?|@react-navigation|lucide-react-native|react-native-svg))',
  ],
  moduleNameMapper: {
    // lucide exposes an ESM build under the "react-native" condition; Jest runs
    // CommonJS, so point the seam at the published CommonJS entry instead of
    // transforming ~3800 icon modules on every suite.
    '^lucide-react-native$':
      '<rootDir>/node_modules/lucide-react-native/dist/cjs/lucide-react-native.js',
  },
};
