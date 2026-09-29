import { transformFromAstSync } from '@babel/core';
import type { Binding, NodePath } from '@babel/traverse';
import type {
  FunctionExpression,
  ImportDeclaration,
  ImportSpecifier,
  JSXAttribute,
} from '@babel/types';
import {
  cloneNode,
  directive,
  directiveLiteral,
  exportDefaultDeclaration,
  importDeclaration,
  isReturnStatement,
  program,
  stringLiteral,
} from '@babel/types';
import assert from 'assert';
import { dirname } from 'path';

import type { WorkletsPluginPass } from './types';
import { workletModuleDirective } from './types';

/**
 * Builds the module that holds a worklet in Bundle Mode and returns it as a
 * `metro:inline` specifier. The importing file requires that specifier, and the
 * bundler resolves it to a virtual module anchored at the importing file, so
 * relative and package imports inside it resolve exactly as they do in the
 * importing file. Nothing is written to disk.
 */
export function generateWorkletModuleSpecifier(
  moduleBindingsToImport: Set<Binding>,
  relativeBindingsToImport: Set<Binding>,
  factory: FunctionExpression,
  state: WorkletsPluginPass
): string {
  const imports = Array.from([
    ...moduleBindingsToImport,
    ...relativeBindingsToImport,
  ])
    .filter(
      (binding) =>
        (binding.path.isImportSpecifier() ||
          binding.path.isImportDefaultSpecifier()) &&
        binding.path.parentPath.isImportDeclaration()
    )
    .map((binding) =>
      importDeclaration(
        [cloneNode(binding.path.node as ImportSpecifier, true)],
        stringLiteral(
          (binding.path.parentPath as NodePath<ImportDeclaration>).node.source
            .value
        )
      )
    );

  const statements = [...factory.body.body];
  const returnedWorklet = statements.pop();
  assert(isReturnStatement(returnedWorklet) && returnedWorklet.argument);
  const newProg = program(
    [
      ...imports,
      ...(factory.params.length === 0
        ? [...statements, exportDefaultDeclaration(returnedWorklet.argument)]
        : [exportDefaultDeclaration(factory)]),
    ],
    [directive(directiveLiteral(workletModuleDirective))]
  );

  const transformedProg = transformFromAstSync(newProg, undefined, {
    filename: state.file.opts.filename,
    presets: [resolvePresetTypescript()],
    plugins: [stripJsxDevAttributesPlugin],
    ast: false,
    babelrc: false,
    configFile: false,
    comments: false,
  })?.code;

  assert(transformedProg, '[Worklets] `transformedProg` is undefined.');

  return (
    'metro:inline;base64,' +
    Buffer.from(transformedProg, 'utf8').toString('base64')
  );
}

function resolvePresetTypescript(): string {
  try {
    return require.resolve('@babel/preset-typescript');
  } catch {
    return require.resolve('@babel/preset-typescript', {
      paths: [dirname(require.resolve('react-native-worklets/package.json'))],
    });
  }
}

const stripJsxDevAttributesPlugin = {
  name: 'worklets-strip-jsx-dev-attributes',
  visitor: {
    JSXAttribute(path: NodePath<JSXAttribute>) {
      const name = path.node.name;

      if (name.type !== 'JSXIdentifier') {
        return;
      }

      if (name.name !== '__self' && name.name !== '__source') {
        return;
      }

      path.remove();
    },
  },
};
