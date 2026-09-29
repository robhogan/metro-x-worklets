const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { bundleModeMetroConfig } = require('react-native-worklets/bundleMode');
const { FileStore } = require('metro-cache');

/**
 * Metro configuration for running worklets in Bundle Mode against Metro from
 * source. The only worklets-specific pieces are the shims and module id
 * factory in `bundleModeMetroConfig`: worklet modules themselves arrive as
 * `metro:inline` dependencies and resolve through Metro's built-in resolver.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const REANIMATED_ROOT = path.resolve(__dirname, '../react-native-reanimated');

// Packages that must resolve to this app's copy even when imported from the
// symlinked worklets and reanimated sources, whose monorepo has its own.
const SINGLETONS = ['react', 'react-native'];

const config = {
  // A persistent cache so transform reuse across runs can be observed.
  cacheStores: [
    new FileStore({ root: path.join(__dirname, '.metro-cache') }),
  ],
  watchFolders: [REANIMATED_ROOT, path.resolve(__dirname, '../metro')],
  resolver: {
    blockList: SINGLETONS.map(
      (name) =>
        new RegExp(
          `^${escapeRegExp(path.join(REANIMATED_ROOT, 'node_modules', name))}/.*`
        )
    ),
    extraNodeModules: Object.fromEntries(
      SINGLETONS.map((name) => [
        name,
        path.join(__dirname, 'node_modules', name),
      ])
    ),
  },
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = mergeConfig(
  getDefaultConfig(__dirname),
  bundleModeMetroConfig,
  config
);
