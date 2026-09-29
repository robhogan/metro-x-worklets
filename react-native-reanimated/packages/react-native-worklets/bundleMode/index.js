const path = require('path');

const reactNativeShimPath = path.join(__dirname, 'shims', 'reactNativeShim.js');
const prepareBundleModePolyfillPath = path.join(
  __dirname,
  'polyfills',
  'prepareBundleMode.js'
);

const workletsPackageName = 'react-native-worklets';
const workletsSrcEntryPath = path.posix.join(
  workletsPackageName,
  'src',
  'index.ts'
);
const workletsLibEntryPath = path.posix.join(
  workletsPackageName,
  'lib',
  'module',
  'index.js'
);

function bundleModeResolveRequest(
  /** @type {any} */ context,
  /** @type {string} */ moduleName,
  /** @type {any} */ platform,
  /** @type {any} */ userConfigResolveRequest
) {
  if (
    moduleName === 'react-native' &&
    context.originModulePath !== reactNativeShimPath
  ) {
    return { type: 'sourceFile', filePath: reactNativeShimPath };
  }
  return (userConfigResolveRequest || context.resolveRequest)(
    context,
    moduleName,
    platform
  );
}

/** Use in React Native Community projects. */
const bundleModeMetroConfig = {
  serializer: {
    createModuleIdFactory: bundleModeCreateModuleIdFactory,
    polyfillModuleNames: [prepareBundleModePolyfillPath],
  },
  resolver: {
    resolveRequest: (
      /** @type {any} */ context,
      /** @type {string} */ moduleName,
      /** @type {any} */ platform
    ) => {
      if (
        moduleName === 'react-native' &&
        context.originModulePath !== reactNativeShimPath
      ) {
        return { type: 'sourceFile', filePath: reactNativeShimPath };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

// eslint-disable-next-line jsdoc/require-param, jsdoc/require-returns
/** Use in Expo projects. */
function getBundleModeMetroConfig(/** @type {any} */ config) {
  config.serializer.createModuleIdFactory = bundleModeCreateModuleIdFactory;
  config.serializer.polyfillModuleNames = [
    ...(config.serializer.polyfillModuleNames ?? []),
    prepareBundleModePolyfillPath,
  ];

  const currentResolveRequest = config?.resolver?.resolveRequest;
  config.resolver.resolveRequest = (
    /** @type {any} */ context,
    /** @type {string} */ moduleName,
    /** @type {any} */ platform
  ) =>
    bundleModeResolveRequest(
      context,
      moduleName,
      platform,
      currentResolveRequest
    );

  const currentGetTransformOptions = config?.transformer?.getTransformOptions;
  config.transformer.getTransformOptions = async (...args) => {
    const options = currentGetTransformOptions
      ? await currentGetTransformOptions(...args)
      : {};
    return {
      ...options,
      transform: {
        ...options.transform,
        inlineRequires: true,
      },
    };
  };

  return config;
}

/**
 * Worklet modules are ordinary modules with bundler-assigned ids, which the
 * worklet records from `module.id`. The only id the native side still assumes
 * is the worklets entry point, which Worklet Runtimes require by the constant
 * `-2` after evaluating the bundle.
 */
function bundleModeCreateModuleIdFactory() {
  let nextId = 0;
  const idFileMap = new Map();
  return (/** @type {string} */ moduleNameRaw) => {
    const moduleName = moduleNameRaw.replace(/\\/g, '/');
    if (idFileMap.has(moduleName)) {
      return idFileMap.get(moduleName);
    }
    if (
      moduleName.includes(workletsPackageName) &&
      (moduleName.endsWith(workletsSrcEntryPath) ||
        moduleName.endsWith(workletsLibEntryPath))
    ) {
      const entryPointId = -2;
      idFileMap.set(moduleName, entryPointId);
      return entryPointId;
    }
    idFileMap.set(moduleName, nextId++);
    return idFileMap.get(moduleName);
  };
}

module.exports = {
  getBundleModeMetroConfig,
  bundleModeMetroConfig,
};
