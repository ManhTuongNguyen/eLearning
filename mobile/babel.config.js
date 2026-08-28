module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'module:react-native-dotenv',
      {
        moduleName: '@env',
        // Fail the bundle when an imported variable is missing from the .env
        // files instead of silently inlining `undefined`.
        allowUndefined: false,
      },
    ],
  ],
};
