import { VISITOR_KEYS } from '@babel/types';
import { declareValuePlugin, PluginKind } from '@stryker-mutator/api/plugin';

import type { CallExpression, Node } from '@babel/types';
import type { NodePath } from '@babel/core';
import type { Ignorer } from '@stryker-mutator/api/ignore';

export const REASON = 'logging-only';

const LOG_METHODS = new Set(['error', 'warn', 'info', 'debug', 'verbose', 'silly']);
const SIDE_EFFECT_TYPES = new Set([
  'CallExpression',
  'OptionalCallExpression',
  'NewExpression',
  'AssignmentExpression',
  'UpdateExpression',
  'AwaitExpression',
  'YieldExpression',
  'TaggedTemplateExpression',
  'ImportExpression',
]);

function isNode(value: unknown): value is Node {
  return !!value && typeof value === 'object' && 'type' in (value as object);
}

/** Depth-first scan; a call, mutation, `await`/`yield`, tagged template, dynamic import, or
 * `delete` anywhere disqualifies the argument. */
function hasSideEffect(node: Node): boolean {
  if (SIDE_EFFECT_TYPES.has(node.type)) return true;
  if (node.type === 'UnaryExpression' && node.operator === 'delete') return true;
  for (const key of VISITOR_KEYS[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      if (value.some((item) => isNode(item) && hasSideEffect(item))) return true;
    } else if (isNode(value) && hasSideEffect(value)) {
      return true;
    }
  }
  return false;
}

/** `logger.<level>(...)`, with side-effect-free arguments. */
function isLoggerCall(node: Node): node is CallExpression {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.object.type !== 'Identifier' || callee.object.name !== 'logger') return false;
  if (callee.property.type !== 'Identifier' || !LOG_METHODS.has(callee.property.name)) return false;
  return !node.arguments.some((argument) => isNode(argument) && hasSideEffect(argument));
}

/** A standalone `logger.<level>(...)` call, as a statement on its own. */
function isLoggerStatement(node: Node): boolean {
  return node.type === 'ExpressionStatement' && isLoggerCall(node.expression);
}

/** Ignores a mutant confined to a standalone, side-effect-free `logger.<level>(...)` call, and the
 * block-emptying mutant of a block whose every statement is such a call. */
export class LoggingIgnorer implements Ignorer {
  shouldIgnore(path: NodePath): string | undefined {
    if (isLoggerStatement(path.node)) return REASON;
    if (
      path.isBlockStatement() &&
      path.node.body.length > 0 &&
      path.node.body.every(isLoggerStatement)
    ) {
      return REASON;
    }
    return undefined;
  }
}

export const LOGGER_IGNORER_NAME = 'quality-logger';

export const strykerPlugins = [
  declareValuePlugin(PluginKind.Ignore, LOGGER_IGNORER_NAME, new LoggingIgnorer()),
];
