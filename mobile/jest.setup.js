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
  const SafeAreaInsetsContext = React.createContext(insets);
  const SafeAreaFrameContext = React.createContext(frame);

  return {
    SafeAreaProvider: PassThrough,
    SafeAreaConsumer: ({ children }) => children(insets),
    SafeAreaView: PassThrough,
    SafeAreaInsetsContext,
    SafeAreaFrameContext,
    initialWindowMetrics: { frame, insets },
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
  };
});

/**
 * react-native-screens mock: native-stack navigators render through plain
 * views so navigation state/logic is exercised without native modules.
 */
jest.mock('react-native-screens', () => {
  const React = require('react');
  const { View } = require('react-native');

  const PassThrough = ({ children }) => React.createElement(View, null, children);
  const Nothing = () => null;

  return {
    Screen: PassThrough,
    ScreenContainer: PassThrough,
    ScreenFooter: PassThrough,
    ScreenStack: PassThrough,
    ScreenStackItem: PassThrough,
    ScreenStackHeaderBackButtonImage: Nothing,
    ScreenStackHeaderCenterView: PassThrough,
    ScreenStackHeaderLeftView: PassThrough,
    ScreenStackHeaderRightView: PassThrough,
    ScreenStackHeaderSearchBarView: Nothing,
    SearchBar: Nothing,
    isSearchBarAvailableForCurrentPlatform: false,
    compatibilityFlags: {},
    enableScreens: jest.fn(),
    enableFreeze: jest.fn(),
    screensEnabled: () => false,
  };
});

/**
 * react-native-blob-util mock: exposes just the fs surface used by the Anki
 * CSV share seam (TASK-075) so tests can assert the file write without
 * native modules.
 */
jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: {
      dirs: { CacheDir: '/mock-cache' },
      writeFile: jest.fn(async (path, contents) => path),
    },
  },
}));

/**
 * react-native-share mock: records the options of every open() call.
 */
jest.mock('react-native-share', () => ({
  __esModule: true,
  default: {
    open: jest.fn(async () => ({ message: 'shared' })),
  },
}));

/**
 * In-memory AsyncStorage mock (mode flag persistence, SPEC TASK-080).
 *
 * Like the keychain store below, the backing Map lives OUTSIDE the mock
 * factory so it survives jest.resetModules(), mirroring device storage
 * across an application restart. __resetAsyncStorageStore() clears it
 * between tests.
 */
const mockAsyncStorageStore = new Map();

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = mockAsyncStorageStore;

  return {
    __esModule: true,
    default: {
      setItem: jest.fn(async (key, value) => {
        store.set(String(key), String(value));
        return null;
      }),
      getItem: jest.fn(async key => (store.has(String(key)) ? store.get(String(key)) : null)),
      removeItem: jest.fn(async key => {
        store.delete(String(key));
        return null;
      }),
      __resetAsyncStorageStore: () => {
        store.clear();
      },
    },
  };
});

/**
 * In-memory react-native-keychain mock so tests exercise the same code paths
 * as secure device storage without native modules.
 *
 * The backing store deliberately lives OUTSIDE the mock factory (babel
 * allows `mock`-prefixed out-of-scope references): jest.resetModules()
 * recreates the JS modules but keeps this Map, mirroring how device storage
 * outlives an application process. __resetKeychainStore() clears it between
 * tests.
 */
const mockKeychainStore = new Map();

jest.mock('react-native-keychain', () => {
  const store = mockKeychainStore;

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
