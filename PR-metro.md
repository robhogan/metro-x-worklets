# Add `metro:inline` modules, the first virtual module resolution

`VirtualResolution` has been reserved in `metro-resolver` since the scheme resolver work, and `ModuleResolution` throws on it:

https://github.com/react/metro/blob/f8269d5ffe9b083c6af7a6ab69cebfeb526df792/packages/metro/src/node-haste/DependencyGraph/ModuleResolution.js#L244-L246

This implements it, with one consumer: `metro:inline;base64,<payload>` (or `metro:inline,<percent-encoded>`) under the existing `metro:` scheme. The payload is the module's source, and the module belongs to the file that imports it - imports inside it resolve as they would from the importer, and the same payload in two files is two modules. That's what a transform needs when it emits a module derived from the file it's transforming. `react-native-worklets` bundle mode does this today by writing files into `node_modules` mid-transform and patching `getOrComputeSha1` to return a random SHA-1 for them, which defeats the cache for every worklet.

A resolver returns `{type: 'virtualModule', originModulePath, source}` and Metro derives the module path as `<originModulePath>?virtual=<sha1(source)>`, the same shape as `?ctx=`. So `path.dirname` is the origin's directory, the transform cache key stays portable, and because the path embeds the content hash a virtual module can never be served stale. `DependencyGraph` keeps a content-addressed map from path to source, filled on every resolution, and `Bundler.transformFile` feeds it through the `fileBuffer` path `require.context` already uses.

This is deliberately not spelled `data:`. A `data:` URL is importer-independent and has no base URL, and Node and browsers treat the same URL as one module wherever it's imported - the opposite on both counts. A spec-faithful `data:` resolver would be a separate change.

Two smaller pieces: the resolution memo keys these specifiers by the importing module's path rather than its directory, and `keepRequireNames` output abbreviates them to the header so a dev bundle carries each payload once. `require.context` isn't migrated, since its directory listing isn't observed yet - that's for after `unstable_incrementalResolution`.

## Changelog
```
 - **[Feature]**: Resolver: `metro:inline;base64,<source>` resolves to a virtual module owned by the importer, and custom resolvers may return `{type: 'virtualModule'}`
```

## Test plan

New unit tests for the specifier, and an integration test that builds and executes a bundle with inline modules: a relative import inside one resolves from the importer's directory, `require.resolveWeak` of the same specifier is the same module, the same payload from a second importer is a second instance, and the production build runs.

Verified e2e with a React Native 0.88.0-rc.2 app running Metro from this branch and a local `react-native-worklets` that emits `require("metro:inline;base64,…")` per worklet in bundle mode, with its Metro patch and `.worklets/` directory removed. Against a `FileStore` cache, across four builds:

 - warm rebuild: 0 new transform cache entries
 - editing `App.tsx` outside any worklet: 1 new entry, both worklet modules keep their ids and hit the cache
 - editing one worklet body: 2 new entries (`App.tsx` and the new worklet module)

The dev bundle from `metro serve` has 505 inline modules named `<file>?virtual=<sha1>`, each with a source map section. Not yet run on a device - the worklets side follows as a PR to react-native-reanimated once this lands.
