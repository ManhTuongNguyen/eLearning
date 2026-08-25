/**
 * Jest setup: provide stable mocks for libraries that depend on native modules
 * unavailable in the Node test environment.
 */
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');

  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 0, height: 0 };

  const PassThrough = ({ children }) => React.createElement(View, null, children);

  return {
    SafeAreaProvider: PassThrough,
    SafeAreaConsumer: ({ children }) => children(insets),
    SafeAreaView: PassThrough,
    initialWindowMetrics: { frame, insets },
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
  };
});
