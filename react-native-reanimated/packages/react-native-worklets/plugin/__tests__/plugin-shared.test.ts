import '../src/jestMatchers';

import type { TransformOptions } from '@babel/core';
import { transformSync } from '@babel/core';
import { describe, expect, test } from '@jest/globals';
import { strict as assert } from 'assert';
import { html } from 'code-tag';

import type { PluginOptions } from '../index';
import plugin from '../index';
import { countOccurrences } from '../jest/pluginTestUtils';

const MOCK_LOCATION = 'test.js';

const DATA_URL_PREFIX = 'metro:inline;base64,';
const INLINE_MODULE_PATTERN = /metro:inline;base64,([A-Za-z0-9+/=]+)/g;

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

type RunResult = {
  code: string;
  modules: GeneratedModule[];
};

function runPlugin(
  input: string,
  pluginOpts: PluginOptions,
  transformOpts: TransformOptions = {}
): RunResult {
  const strippedInput = input.replace(/<\/?script[^>]*>/g, '');
  const transformed = transformSync(strippedInput, {
    filename: MOCK_LOCATION,
    compact: false,
    babelrc: false,
    configFile: false,
    ...transformOpts,
    plugins: [
      ...(transformOpts.plugins ?? []),
      [
        plugin,
        {
          disableSourceMaps: true,
          relativeSourceLocation: true,
          ...pluginOpts,
        },
      ],
    ],
  });
  assert(transformed);
  const code = transformed.code ?? '';
  return { code, modules: generatedModules(code) };
}

function workletText(result: RunResult, bundleMode: boolean): string {
  if (bundleMode) {
    return result.modules.map((module) => module.content).join('\n');
  }
  return result.code;
}

describe.each([
  { label: 'bundleless', bundleMode: false },
  { label: 'bundle', bundleMode: true },
])('babel plugin core ($label mode)', ({ bundleMode }) => {
  beforeEach(() => {
    process.env.WORKLETS_JEST_SHOULD_MOCK_VERSION = '1';
    process.env.WORKLETS_JEST_SHOULD_MOCK_SOURCE_MAP = '1';
  });

  describe('worklet shapes', () => {
    const cases: Array<{ name: string; input: string }> = [
      {
        name: 'FunctionDeclaration',
        input: html`<script>
          function foo(x) {
            'worklet';
            return x + 2;
          }
        </script>`,
      },
      {
        name: 'ArrowFunctionExpression',
        input: html`<script>
          const foo = (x) => {
            'worklet';
            return x + 2;
          };
        </script>`,
      },
      {
        name: 'unnamed FunctionExpression',
        input: html`<script>
          const foo = function (x) {
            'worklet';
            return x + 2;
          };
        </script>`,
      },
      {
        name: 'named FunctionExpression',
        input: html`<script>
          const foo = function foo(x) {
            'worklet';
            return x + 2;
          };
        </script>`,
      },
      {
        name: 'ObjectMethod',
        input: html`<script>
          const foo = {
            bar(x) {
              'worklet';
              return x + 2;
            },
          };
        </script>`,
      },
    ];

    test.each(cases)('workletizes $name', ({ input }) => {
      const result = runPlugin(input, { bundleMode });
      const factoryCount = bundleMode
        ? result.modules.length
        : countOccurrences(result.code, 'Factory(');
      expect(factoryCount).toBe(1);
      expect(redactGeneratedModules(result.code)).toMatchSnapshot();
      if (bundleMode) {
        expect(result.modules[0].content).toMatchSnapshot();
      }
    });
  });

  describe('closure handling', () => {
    test('does not capture default globals', () => {
      const input = html`<script>
        function f() {
          'worklet';
          console.log('hi');
          return Math.random();
        }
      </script>`;

      const result = runPlugin(input, { bundleMode });
      expect(workletText(result, bundleMode)).toMatchSnapshot();
    });

    test('does not capture navigator', () => {
      const input = html`<script>
        function f() {
          'worklet';
          return navigator.gpu;
        }
      </script>`;

      const result = runPlugin(input, { bundleMode });
      expect(workletText(result, bundleMode)).toMatchSnapshot();
    });

    test('captures locally bound variables shadowing globals', () => {
      const input = html`<script>
        const console = {
          log: () => 42,
        };

        function f() {
          'worklet';
          console.log(console);
        }
      </script>`;

      const result = runPlugin(input, { bundleMode });
      expect(workletText(result, bundleMode)).toMatchSnapshot();
    });

    test('captures multiple closure variables', () => {
      const input = html`<script>
        const a = 1;
        const b = 2;
        function foo() {
          'worklet';
          return a + b;
        }
      </script>`;

      const result = runPlugin(input, { bundleMode });
      expect(workletText(result, bundleMode)).toMatchSnapshot();
    });
  });

  describe('autoworkletization', () => {
    test('workletizes useAnimatedStyle callback', () => {
      const input = html`<script>
        import { useAnimatedStyle } from 'react-native-reanimated';
        function Box() {
          const style = useAnimatedStyle(() => ({ width: 100 }));
        }
      </script>`;

      const result = runPlugin(input, { bundleMode });
      expect(redactGeneratedModules(result.code)).toMatchSnapshot();
      if (bundleMode) {
        expect(result.modules[0].content).toMatchSnapshot();
      }
    });
  });

  describe('without worklets', () => {
    test('leaves code untouched and emits no factory', () => {
      const input = html`<script>
        function foo() {
          var x = 1;
        }
      </script>`;

      const result = runPlugin(input, { bundleMode });
      expect(result.modules).toHaveLength(0);
      expect(result.code).toMatchSnapshot();
    });
  });

  describe('state environment flavor detection', () => {
    const sampleInput = html`<script>
      function foo() {
        'worklet';
        return 1;
      }
    </script>`;

    function transformWithEnvName(envName: string): string {
      const result = runPlugin(sampleInput, { bundleMode }, { envName });
      return workletText(result, bundleMode);
    }

    test('envName "production" is detected as release', () => {
      expect(transformWithEnvName('production')).not.toContain(
        '__pluginVersion'
      );
    });

    test('envName "development" is not detected as release', () => {
      expect(transformWithEnvName('development')).toContain('__pluginVersion');
    });
  });

  describe('for react-compiler', () => {
    test('prevents outlining from worklet functions', () => {
      const input = html`<script>
        const TestComponent = ({ number }) => {
          const keyToIndex = useDerivedValue(() => [1, 2, 3].map(() => null));

          return null;
        };
      </script>`;

      const result = runPlugin(
        input,
        { bundleMode },
        { envName: 'development', plugins: ['babel-plugin-react-compiler'] }
      );

      const notOutlinedFunction = '.map(() => null);';
      const output = bundleMode ? result.modules[0].content : result.code;

      expect(output).toMatch(notOutlinedFunction);
      expect(output).toMatchSnapshot();
    });
  });
});
