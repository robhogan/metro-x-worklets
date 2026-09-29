/**
 * Preload for running Metro from the sibling source checkout.
 *
 * Usage: node -r ./scripts/metro-source-register.js <entry>
 *
 * Metro's packages ship Flow source under `src/`, so anything loaded from the
 * checkout is compiled on the fly with Metro's own Babel config. Only files
 * under the checkout's `packages/` are touched; the app, React Native and every
 * other dependency load untransformed. Metro's transform workers are forked
 * with the parent's `execArgv`, so this preload applies to them too.
 */
const path = require('path');

const METRO_ROOT = path.resolve(__dirname, '../../metro');

require(path.join(METRO_ROOT, 'node_modules/@babel/register'))({
  root: METRO_ROOT,
  configFile: path.join(METRO_ROOT, 'babel.config.js'),
  babelrc: false,
  only: [path.join(METRO_ROOT, 'packages')],
  ignore: [/node_modules/],
  extensions: ['.js'],
  cache: true,
});
