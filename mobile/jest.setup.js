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

/**
 * In-memory react-native-keychain mock so tests exercise the same code paths
 * as secure device storage without native modules.
 */
jest.mock('react-native-keychain', () => {
  const store = new Map();

  const serviceOf = (options) =>
    options && typeof options.service === 'string' ? options.service : 'default';

  return {
    __esModule: true,
    default: {},
    setGenericPassword: jest.fn(async (username, password, options) => {
      store.set(serviceOf(options), JSON.stringify({ username, password }));
      return { service: serviceOf(options), storage: 'none' };
    }),
    getGenericPassword: jest.fn(async (options) => {
      const entry = store.get(serviceOf(options));
      if (!entry) {
        return false;
      }
      return { ...JSON.parse(entry), service: serviceOf(options), storage: 'none' };
    }),
    resetGenericPassword: jest.fn(async (options) => store.delete(serviceOf(options))),
    SECURITY_LEVEL: { SECURE_SOFTWARE: 'SECURE_SOFTWARE', ANY: 'ANY' },
    STORAGE_TYPE: { AES: 'AES' },
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
    __resetKeychainStore: () => {
      store.clear();
    },
  };
});
