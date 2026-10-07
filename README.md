*Disclaimer: AI-generated.*

# metro-x-worklets

An experiment in making `react-native-worklets` bundle mode a first-class citizen of Metro - no files written into `node_modules` mid-transform, no Metro patches, and transform caching that's provably correct.

Three checkouts, worked as one project:

- `metro/` - react/metro at `f8269d5ffe9b`, plus one change: `metro:inline` modules, the first implementation of the reserved `VirtualResolution`.
- `react-native-reanimated/` - software-mansion/react-native-reanimated at `9b3ae129dc41`, plus one change in `packages/react-native-worklets`: the Babel plugin emits `metro:inline` specifiers instead of writing `.worklets/<hash>.js`.
- `app/` - a React Native 0.88.0-rc.2 app with a Reanimated screen, running Metro and worklets from the sibling checkouts.

The import commits are the upstream trees unchanged, so `git log` shows exactly what's been altered on top of each.

## The problem

Bundle mode today has each worklet extracted into its own module so that Worklet Runtimes can load it with `__r(id)` rather than `eval`. The plugin writes that module to `react-native-worklets/.worklets/<hash>.js` from inside the Babel visitor, and a `resolveRequest` maps the require back to it.

Metro can't see any of that. The file map hasn't indexed the file when the transform completes, so worklets ships a patch making `getOrComputeSha1` return a SHA-1 of `performance.now()` for anything under `.worklets` - which means no worklet is ever a transform cache hit. A cache hit on the *parent* file doesn't re-run the plugin, so nothing rewrites the generated file, and a stale one is served. And the module id has to equal the hash, via a custom `createModuleIdFactory`, so that both runtimes agree on it.

## The approach

The generated module belongs in the graph as a node the *resolver* produces, not a side effect of a transform. So the plugin emits

```js
require("metro:inline;base64,<module source>").default([closure])
```

and Metro's `metro:` scheme resolver decodes the payload into a `VirtualResolution` anchored at the importing file. The module path becomes `<importer>?virtual=<sha1(source)>` - the same shape as `?ctx=` - so `path.dirname` is the importer's directory and imports inside the worklet resolve exactly as they would from the file that defined it. The source rides the graph edge that resolved it, in the same slot `require.context` uses for its parameters, so it's released with the module. Because the path embeds the content hash, the transform cache key is a pure function of the path. A worklet module can't be stale: if the source changed, it's a different module.

Nothing on the worklets side depends on how ids are assigned any more. Each generated module records `__moduleId = module.id`, the unpacker on the Worklet Runtime does `__r(__moduleId)`, and the native side needs no change because it already copies every own property of a worklet.

This is deliberately not `data:`. A `data:` URL is spec'd as importer-independent with no base URL - the same URL is one module wherever it's imported, and relative imports inside it are an error. Inline modules are the opposite on both counts, so they get Metro's own name rather than borrowing one and breaking its meaning.

What's left: native still requires the worklets entry by the constant `-2`, so `bundleModeMetroConfig` keeps a tiny id factory for that one module. The `metro-runtime` Fast Refresh patch remains. The OXC port of the plugin isn't updated.

## Running the demo

```sh
cd metro && yarn
cd ../react-native-reanimated && corepack yarn
cd ../app && npm install --legacy-peer-deps
./scripts/link-source-packages.sh
```

`link-source-packages.sh` replaces every `metro-*` package plus `react-native-worklets` and `react-native-reanimated` in `node_modules` with symlinks to the checkouts. Rerun it after any `npm install`.

Metro runs from Flow source via a Node preload that compiles only files under `metro/packages`:

```sh
node -r ./scripts/metro-source-register.js ../metro/packages/metro/src/cli.js serve --config metro.config.js
node -r ./scripts/metro-source-register.js ../metro/packages/metro/src/cli.js build index.js --platform ios --dev true --out dist/ios.dev.js --config metro.config.js
```

The cache demo builds four times against a persistent cache and counts new transform cache entries:

```sh
./scripts/cache-demo.sh
```

```
cold build:                    1520 cache entries
warm rebuild:                  +0
edit App.tsx outside worklets: +1
  worklet module ids unchanged: yes (2 modules)
edit one worklet body:         +2
  worklet module ids changed:   1 of 2
```

A non-worklet edit re-transforms only `App.tsx` and every worklet module hits the cache. A worklet edit replaces exactly that worklet's module. Before this change, every `.worklets` module missed the cache on every build.

I haven't run this on a device yet - `cd ios && pod install && npm run ios` is the next step. The JS side is exercised by the bundle build and the tests in both repos.

`PR-metro.md` is the draft PR description for the Metro half.
