import '../src/jestMatchers';

import type { TransformOptions } from '@babel/core';
import { transformSync } from '@babel/core';
import { strict as assert } from 'assert';
import { html } from 'code-tag';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PluginOptions } from '../index';
import plugin from '../index';
import { countOccurrences } from '../jest/pluginTestUtils';

const MOCK_LOCATION = 'test.js';
const MOCK_TSX_LOCATION = 'test.tsx';
const MOCK_WORKLET_RUNTIME_ENTRY = 'react-native-worklets/src/index.ts';
const MOCK_OTHER_FILE = 'someOtherFile.ts';

const TOGGLE_PATH_CASES: ReadonlyArray<[label: string, filename: string]> = [
  ['source entry-point', MOCK_WORKLET_RUNTIME_ENTRY],
  ['source mode-check', 'react-native-worklets/src/debug/bundleMode.native.ts'],
  ['built entry-point', 'react-native-worklets/lib/module/index.js'],
  [
    'built mode-check',
    'react-native-worklets/lib/module/debug/bundleMode.native.js',
  ],
  [
    'prepareBundleMode polyfill',
    'react-native-worklets/bundleMode/polyfills/prepareBundleMode.js',
  ],
];

const DATA_URL_PREFIX = 'metro:inline;base64,';
const INLINE_MODULE_PATTERN = /metro:inline;base64,([A-Za-z0-9+/=]+)/g;
const REQUIRE_PREFIX = `require("${DATA_URL_PREFIX}`;
const WORKLET_MODULE_DIRECTIVE = /^["']worklet-module["'];/;

type GeneratedModule = { specifier: string; content: string };

/**
 * Every generated worklet module the code requires, in order of appearance,
 * each followed by the modules its own content requires in turn.
 */
function generatedModules(code: string): GeneratedModule[] {
  return Array.from(
    code.matchAll(INLINE_MODULE_PATTERN),
    ([specifier, payload]): GeneratedModule => ({
      specifier,
      content: Buffer.from(payload, 'base64').toString('utf8'),
    })
  ).flatMap((module) => [module, ...generatedModules(module.content)]);
}

/**
 * Keeps snapshots readable: each base64 payload is replaced by its position
 * among the distinct payloads in the string, so the snapshot still pins the
 * transport and the module count without a multi-KB blob.
 */
function redactGeneratedModules(code: string): string {
  const positions = new Map<string, number>();
  return code.replace(INLINE_MODULE_PATTERN, (specifier) => {
    if (!positions.has(specifier)) {
      positions.set(specifier, positions.size + 1);
    }
    return `${DATA_URL_PREFIX}<module ${positions.get(specifier)}>`;
  });
}

function reformat(code: string, filename: string = MOCK_LOCATION): string {
  const transformed = transformSync(code, {
    filename,
    compact: false,
    babelrc: false,
    configFile: false,
  });
  assert(transformed);
  return transformed.code ?? '';
}

function runPlugin(
  input: string,
  transformOpts: TransformOptions = {},
  pluginOpts: PluginOptions = {},
  filename: string = MOCK_LOCATION
) {
  const strippedInput = input.replace(/<\/?script[^>]*>/g, '');
  const config = {
    filename,
    compact: false,
    babelrc: false,
    configFile: false,
    ...transformOpts,
    plugins: [
      ...(transformOpts.plugins || []),
      [plugin, { disableSourceMaps: true, ...pluginOpts, bundleMode: true }],
    ],
  };
  const transformed = transformSync(strippedInput, config);
  assert(transformed);
  const code = transformed.code ?? '';
  return { code, modules: generatedModules(code) };
}

describe('babel plugin in bundleMode', () => {
  beforeEach(() => {
    process.env.WORKLETS_JEST_SHOULD_MOCK_VERSION = '1';
  });

  describe('source replacement', () => {
    test.each(['arrow', 'method'])(
      'does not shadow forwarded imports with the closure-free %s worklet binding',
      (kind) => {
        const name = kind === 'arrow' ? 'testJs1' : 'read';
        const body = `{ 'worklet'; return [${name}(), _${name}()]; }`;
        const expression =
          kind === 'arrow' ? `() => ${body}` : `{ read() ${body} }.read`;
        const { modules } = runPlugin(
          `
          import { first as ${name}, second as _${name} } from 'some-library';
          const f = ${expression};
        `,
          {},
          { importForwarding: { moduleNames: ['some-library'] } }
        );
        expect(modules[0].content).toContain(`const __${name} =`);
        expect(modules[0].content).toMatchSnapshot();
      }
    );

    test('packs captures in the same order at the call site and in the factory', () => {
      const { code, modules } = runPlugin(`
        function make(z, missing, a) {
          return (suffix) => {
            'worklet';
            return [z.value, missing, a, suffix];
          };
        }
        module.exports = make;
      `);
      expect(redactGeneratedModules(code)).toMatchSnapshot();
      expect(modules[0].content).toMatchSnapshot();
    });

    test('exports closure-free worklets without a factory call', () => {
      const { code, modules } = runPlugin(`
        function factorial(n) {
          'worklet';
          return n <= 1 ? 1 : n * factorial(n - 1);
        }
        module.exports = factorial;
      `);
      expect(code).toMatch(/\.default;/);
      expect(modules[0].content).not.toContain('Factory');
      expect(modules[0].content).not.toContain('__closure');
    });

    test('replaces inline factory with a require of the generated module', () => {
      const input = html`<script>
        function foo() {
          'worklet';
          var x = 1;
        }
      </script>`;

      const { code, modules } = runPlugin(input);
      expect(modules).toHaveLength(1);
      expect(redactGeneratedModules(code)).toMatchSnapshot();
    });

    test('still captures closure even with "no-worklet-closure" directive', () => {
      const input = html`<script>
        const x = 1;
        function foo() {
          'worklet';
          'no-worklet-closure';
          return x;
        }
      </script>`;

      const { code, modules } = runPlugin(input);
      expect(modules).toHaveLength(1);
      expect(redactGeneratedModules(code)).toMatchSnapshot();
      expect(modules[0].content).toMatchSnapshot();
    });
  });

  describe('worklet module generation', () => {
    test('generates one worklet module per worklet', () => {
      const input = html`<script>
        function foo() {
          'worklet';
          var x = 1;
        }
        function bar() {
          'worklet';
          var y = 2;
        }
      </script>`;

      const { modules } = runPlugin(input);
      expect(modules).toHaveLength(2);
    });

    test('requires the generated module by its inline specifier', () => {
      const input = html`<script>
        function foo() {
          'worklet';
          var x = 1;
        }
      </script>`;

      const { code, modules } = runPlugin(input);
      expect(modules).toHaveLength(1);
      expect(code).toContain(`require("${modules[0].specifier}").default`);
      expect(redactGeneratedModules(code)).toMatchSnapshot();
    });

    test('starts the generated module with the worklet-module directive', () => {
      const input = html`<script>
        function foo() {
          'worklet';
          var x = 1;
        }
      </script>`;

      const { modules } = runPlugin(input);
      expect(modules).toHaveLength(1);
      expect(modules[0].content).toMatch(WORKLET_MODULE_DIRECTIVE);
    });

    test('records the bundler module id on the worklet', () => {
      const input = html`<script>
        function foo() {
          'worklet';
          var x = 1;
        }
      </script>`;

      const { modules } = runPlugin(input);
      expect(modules).toHaveLength(1);
      expect(modules[0].content).toContain('foo.__moduleId = module.id;');
    });

    test('closure-free generated module exports the worklet directly', () => {
      const input = html`<script>
        function foo() {
          'worklet';
          var x = 1;
          return x;
        }
      </script>`;

      const { modules } = runPlugin(input);
      expect(modules).toHaveLength(1);
      expect(modules[0].content).toMatchSnapshot();
    });

    test('does not emit init data', () => {
      const input = html`<script>
        function foo() {
          'worklet';
          var x = 1;
        }
      </script>`;

      const { code, modules } = runPlugin(input);
      expect(redactGeneratedModules(code)).toMatchSnapshot();
      expect(modules[0].content).toMatchSnapshot();
    });

    test('does not emit stack-trace machinery', () => {
      const input = html`<script>
        function foo() {
          'worklet';
          var x = 1;
        }
      </script>`;

      const { modules } = runPlugin(input);
      expect(modules).toHaveLength(1);
      expect(modules[0].content).not.toContain('__stackDetails');
      expect(modules[0].content).toMatchSnapshot();
    });

    test('generates a worklet module when cwd has no @babel/preset-typescript reachable', () => {
      const isolatedDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'worklets-isolated-cwd-')
      );
      fs.mkdirSync(path.join(isolatedDir, 'node_modules'), {
        recursive: true,
      });
      const previousCwd = process.cwd();

      const input = html`<script>
        function foo() {
          'worklet';
          var x = 1;
        }
      </script>`;

      expect(() =>
        require.resolve('@babel/preset-typescript', {
          paths: [isolatedDir],
        })
      ).toThrow();

      try {
        process.chdir(isolatedDir);
        const { modules } = runPlugin(input);
        expect(modules).toHaveLength(1);
      } finally {
        process.chdir(previousCwd);
        fs.rmSync(isolatedDir, { recursive: true, force: true });
      }
    });

    test('forwards closure variables from source to factory', () => {
      const input = html`<script>
        const a = 1;
        const b = 2;
        function foo() {
          'worklet';
          return a + b;
        }
      </script>`;

      const { code, modules } = runPlugin(input);
      expect(redactGeneratedModules(code)).toMatchSnapshot();
      expect(modules[0].content).toMatchSnapshot();
    });

    test('preserves workletizable library imports in the generated module', () => {
      const input = html`<script>
        import { foo } from 'some-library';
        function bar() {
          'worklet';
          return foo();
        }
      </script>`;

      const { code, modules } = runPlugin(
        input,
        {},
        { importForwarding: { moduleNames: ['some-library'] } }
      );
      expect(modules).toHaveLength(1);
      expect(redactGeneratedModules(code)).toMatchSnapshot();
      expect(modules[0].content).toMatchSnapshot();
    });

    test('strips JSX dev attributes in generated modules', () => {
      const input = html`<script>
        import { ImportedComponent } from 'react-native-worklets';

        function renderView() {
          'worklet';
          return <ImportedComponent />;
        }
      </script>`;

      const control = transformSync(input.replace(/<\/?script[^>]*>/g, ''), {
        filename: MOCK_TSX_LOCATION,
        compact: false,
        babelrc: false,
        configFile: false,
        presets: [
          ['@babel/preset-react', { runtime: 'classic', development: true }],
        ],
        envName: 'development',
      })!.code;
      expect(control).toContain('__self');
      expect(control).toContain('__source');

      const { modules } = runPlugin(
        input,
        {
          presets: [
            ['@babel/preset-react', { runtime: 'classic', development: true }],
          ],
          envName: 'development',
        },
        { importForwarding: { moduleNames: ['react-native-worklets'] } },
        MOCK_TSX_LOCATION
      );
      expect(modules).toHaveLength(1);
      expect(modules[0].content).toContain('return <ImportedComponent />;');
      expect(modules[0].content).not.toContain('__self');
      expect(modules[0].content).not.toContain('__source');
    });

    test('captures locally defined JSX components in the closure', () => {
      const input = html`<script>
        function LocalComponent() {
          return null;
        }

        function renderView() {
          'worklet';
          return <LocalComponent />;
        }
      </script>`;

      const { code } = runPlugin(
        input,
        { presets: [['@babel/preset-react', { runtime: 'classic' }]] },
        {},
        MOCK_TSX_LOCATION
      );
      expect(code).toContain('LocalComponent');
      expect(redactGeneratedModules(code)).toMatchSnapshot();
    });

    test('leaves relative imports as written in the importing file', () => {
      const input = html`<script>
        import { foo } from './bar';
        function baz() {
          'worklet';
          return foo();
        }
      </script>`;

      const fakeFilename = '/some-library/src/file.ts';
      const { modules } = runPlugin(
        input,
        {},
        { importForwarding: { relativePaths: ['some-library'] } },
        fakeFilename
      );
      expect(modules).toHaveLength(1);
      expect(modules[0].content).toContain(`from "./bar"`);
    });

    test.each<[label: string, filename: string, pluginOpts: PluginOptions]>([
      [
        'a workletizable package',
        '/some-library/src/file.ts',
        { importForwarding: { relativePaths: ['some-library'] } },
      ],
      [
        'a non-workletizable file',
        '/not-a-workletizable-package/src/file.ts',
        {},
      ],
    ])(
      'leaves relative requires inside the worklet body as written in %s',
      (_label, filename, pluginOpts) => {
        const input = html`<script>
          function baz() {
            'worklet';
            const helper = require('./helper');
            return helper.foo();
          }
        </script>`;

        const { modules } = runPlugin(input, {}, pluginOpts, filename);
        expect(modules).toHaveLength(1);
        expect(modules[0].content).toMatch(/require\(["']\.\/helper["']\)/);
        expect(modules[0].content).toMatchSnapshot();
      }
    );
  });

  describe('bundle mode flag toggle', () => {
    for (const [label, filename] of TOGGLE_PATH_CASES) {
      test(`flips _WORKLETS_BUNDLE_MODE_ENABLED to true in the ${label} file`, () => {
        const input = html`<script>
          globalThis._WORKLETS_BUNDLE_MODE_ENABLED = false;
        </script>`;

        const { code } = runPlugin(input, {}, {}, filename);
        expect(code).toContain(
          'globalThis._WORKLETS_BUNDLE_MODE_ENABLED = true;'
        );
      });
    }

    test('does not flip the flag in unrelated files', () => {
      const input = html`<script>
        globalThis._WORKLETS_BUNDLE_MODE_ENABLED = false;
      </script>`;

      const { code } = runPlugin(input, {}, {}, MOCK_OTHER_FILE);
      expect(code).toMatchSnapshot();
    });
  });

  describe('nested worklets', () => {
    test('extracts each nested worklet into its own module', () => {
      const input = html`<script>
        const foo = function () {
          'worklet';
          const bar = function () {
            'worklet';
            return 1;
          };
          return bar();
        };
      </script>`;

      const { code, modules } = runPlugin(input);
      expect(modules).toHaveLength(2);
      const sourceRequires = countOccurrences(code, REQUIRE_PREFIX);
      expect(sourceRequires).toBe(1);
      const [outerModule] = modules;
      expect(code).toContain(`require("${outerModule.specifier}")`);
      expect(redactGeneratedModules(code)).toMatchSnapshot();
      expect(redactGeneratedModules(outerModule.content)).toMatchSnapshot();
    });

    test('requires the inner worklet module from the outer one', () => {
      // The inner worklet is only reachable through the outer module, which
      // carries the inner inline specifier in its own content rather than in the
      // importing file.
      const input = html`<script>
        const foo = function () {
          'worklet';
          const bar = function () {
            'worklet';
            return 1;
          };
          return bar();
        };
      </script>`;

      const { code, modules } = runPlugin(input);
      assert(modules.length === 2);
      const [outerModule, innerModule] = modules;
      expect(code).not.toContain(innerModule.specifier);
      expect(outerModule.content).toContain(
        `require("${innerModule.specifier}").default`
      );
      expect(innerModule.content).not.toContain(DATA_URL_PREFIX);
    });
  });

  describe('with source maps enabled', () => {
    test('generates a worklet module without crashing', () => {
      // Other tests in this file disable source maps so the filename can be
      // arbitrary; here we run with real source-map generation against a real
      // file path so that path is at least exercised once.
      const input = html`<script>
        function foo() {
          'worklet';
          var x = 1;
        }
      </script>`;

      const { code, modules } = runPlugin(
        input,
        {},
        { disableSourceMaps: false },
        __filename
      );
      expect(modules).toHaveLength(1);
      expect(code).toContain(REQUIRE_PREFIX);
    });
  });

  describe('bail-out on generated worklet modules', () => {
    test('leaves a generated worklet module unchanged', () => {
      const input = html`<script>
        function foo() {
          'worklet';
          var x = 1;
        }
      </script>`;

      const { modules } = runPlugin(input);
      assert(modules.length === 1);
      const [{ content }] = modules;
      expect(content).toMatch(WORKLET_MODULE_DIRECTIVE);

      const { code: rePassedCode, modules: rePassedModules } =
        runPlugin(content);
      expect(rePassedCode).toBe(reformat(content));
      expect(rePassedCode).toMatch(WORKLET_MODULE_DIRECTIVE);
      expect(rePassedModules).toHaveLength(0);
    });

    test('autoworkletization fires before generating the module', () => {
      const input = html`<script>
        function foo() {
          'worklet';
          scheduleOnUI(() => {
            return 1;
          });
        }
      </script>`;

      const { modules } = runPlugin(input);
      assert(modules.length === 2);
      const [outerModule, innerModule] = modules;
      expect(outerModule.content).toContain(
        `require("${innerModule.specifier}")`
      );

      const { code: rePassedCode, modules: rePassedModules } = runPlugin(
        outerModule.content
      );
      expect(rePassedCode).toBe(reformat(outerModule.content));
      expect(rePassedCode).toMatch(WORKLET_MODULE_DIRECTIVE);
      expect(rePassedModules.map((module) => module.specifier)).toEqual([
        innerModule.specifier,
      ]);
    });
  });
});
