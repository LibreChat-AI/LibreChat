/**
 * Design rules `@shadcn/lint` does not cover, registered as the `design` plugin in
 * `eslint.config.mjs` and recorded in `eslint-suppressions.json` like its rules.
 */

/** The shared disabled recipes (`packages/client/src/utils/theme.ts`). */
const RECIPES = new Set([
  'disabledFillClasses',
  'disabledInkClasses',
  'disabledWithinFillClasses',
  'peerDisabledInkClasses',
]);

/** The full-opacity override every recipe carries, so a class list that spells one out also
 *  counts; another `theme-disabled:` utility alone still leaves the control faded. */
const RECIPE_VARIANT = /(?:^|\s)(?:peer-)?theme-disabled(?:-within)?:!?opacity-100(?=\s|$)/;

/** A variant that selects a disabled control, its group, its peer or a wrapper around it:
 *  `disabled:`, `aria-disabled:`, `data-[state=disabled]:`, `has-[:disabled]:`, `[&:disabled]:`.
 *  The recipes' own `theme-disabled`, a negated `not-disabled` or `[&:not(:disabled)]` and an
 *  explicit `[disabled=false]` select something else. */
const isDisabledVariant = (variant) =>
  /disabled/.test(variant) &&
  !/^(?:(?:group|peer)-)?(?:theme-disabled|not-)/.test(variant) &&
  !/:not\([^)]*disabled/.test(variant) &&
  !/disabled\s*!?=\s*["']?false\b|disabled\s*!=/.test(variant);

/** Ancestors that keep a class string inside one class list: the expression a recipe is
 *  composed into reaches up through these, and stops at a declaration or an attribute. */
const COMPOSING = new Set([
  'ArrayExpression',
  'BinaryExpression',
  'CallExpression',
  'ConditionalExpression',
  'JSXExpressionContainer',
  'LogicalExpression',
  'ObjectExpression',
  'Property',
  'SpreadElement',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TemplateLiteral',
]);

/** Splits a utility into its variants and its base, leaving `:` inside brackets alone. */
function splitVariants(token) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of token) {
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
    if (char === ':' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return { variants: parts.slice(0, -1), base: parts[parts.length - 1] };
}

/** An opacity that fades: `opacity-100` keeps the control opaque, so it is not a dim. */
const isOpacity = (base) => /^!?opacity-(?!100$)/.test(base);

/** The first utility in `value` that dims a disabled control through a variant. */
function variantDim(value) {
  return value.split(/\s+/).find((token) => {
    const { variants, base } = splitVariants(token);
    return isOpacity(base) && variants.some(isDisabledVariant);
  });
}

/** The first bare `opacity-*` in `value`, for a string a `disabled` condition chooses. */
const bareDim = (value) =>
  value.split(/\s+/).find((token) => {
    const { variants, base } = splitVariants(token);
    return variants.length === 0 && isOpacity(base);
  });

/** Whether `test` holds only while the control is disabled (`true`), only while it is enabled
 *  (`false`), or says nothing certain about it (`undefined`). A `!` or a comparison to `false`
 *  flips the sense; an `&&` takes the sense of any operand that has one, and anything else that
 *  is not a plain reference to a `disabled` value is unknown. */
function disabledSense(test, source) {
  if (test.type === 'UnaryExpression' && test.operator === '!') {
    const inner = disabledSense(test.argument, source);
    return inner === undefined ? undefined : !inner;
  }
  if (test.type === 'BinaryExpression' && /^[!=]==?$/.test(test.operator)) {
    const literal = [test.left, test.right].find((side) => side.type === 'Literal');
    if (!literal || typeof literal.value !== 'boolean') return undefined;
    const inner = disabledSense(literal === test.left ? test.right : test.left, source);
    if (inner === undefined) return undefined;
    const flips = literal.value === test.operator.startsWith('!');
    return flips ? !inner : inner;
  }
  if (test.type === 'LogicalExpression' && test.operator === '&&') {
    const senses = [disabledSense(test.left, source), disabledSense(test.right, source)];
    const known = senses.filter((sense) => sense !== undefined);
    return known.length > 0 && known.every((sense) => sense === known[0]) ? known[0] : undefined;
  }
  if (['Identifier', 'MemberExpression', 'ChainExpression'].includes(test.type)) {
    const text = source.getText(test);
    return /disabled/i.test(text) && !/(?:not|non)_?disabled/i.test(text) ? true : undefined;
  }
  return undefined;
}

/** Wrappers a chosen string passes through on its way to the condition that picks it:
 *  `disabled ? cn('opacity-50') : ''` picks the call, not the string. */
const PASSING = new Set([
  'ArrayExpression',
  'BinaryExpression',
  'CallExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TemplateLiteral',
]);

/** Whether a `disabled` condition chooses the string: `disabled ? 'opacity-50' : ''`,
 *  `isDisabled && 'opacity-50'`, or `{ 'opacity-50': disabled }` in a class map. A string the
 *  condition picks for the enabled state (`disabled ? '' : 'opacity-50'`) is not a disabled dim. */
function chosenByDisabled(start, source) {
  let node = start;
  while (
    node.parent &&
    PASSING.has(node.parent.type) &&
    !(node.parent.type === 'CallExpression' && node.parent.callee === node)
  ) {
    node = node.parent;
  }
  const parent = node.parent;
  if (parent?.type === 'ConditionalExpression' && parent.test !== node) {
    const sense = disabledSense(parent.test, source);
    return sense !== undefined && sense === (parent.consequent === node);
  }
  if (parent?.type === 'LogicalExpression' && parent.right === node && parent.operator === '&&') {
    return disabledSense(parent.left, source) === true;
  }
  if (parent?.type === 'Property' && parent.key === node) {
    return disabledSense(parent.value, source) === true;
  }
  return false;
}

/** Whether an object belongs to a call's arguments, as a class map or a `cva` config does,
 *  rather than being a props or style object of its own. */
function isCallArgument(object) {
  let current = object;
  while (['ObjectExpression', 'Property', 'ArrayExpression'].includes(current.parent?.type)) {
    current = current.parent;
  }
  return current.parent?.type === 'CallExpression' && current.parent.callee !== current;
}

/** The whole class list the string belongs to. An object counts only when it is passed to a
 *  call; a property of any other object is a class list of its own. */
function classList(node) {
  let current = node;
  while (current.parent && COMPOSING.has(current.parent.type)) {
    const parent = current.parent;
    if (parent.type === 'Property' && !isCallArgument(parent.parent)) {
      return current;
    }
    current = parent;
  }
  return current;
}

/** Whether the class list composes a recipe: a reference to one (not a property key), or a
 *  string that spells one out. */
function composesRecipe(root, visitorKeys) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === 'Identifier' && RECIPES.has(node.name)) {
      const parent = node.parent;
      const isKey =
        parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand;
      if (!isKey) return true;
    }
    if (
      node.type === 'Literal' &&
      typeof node.value === 'string' &&
      RECIPE_VARIANT.test(node.value)
    ) {
      return true;
    }
    if (node.type === 'TemplateElement' && RECIPE_VARIANT.test(node.value.cooked ?? '')) {
      return true;
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) {
        stack.push(...child.filter(Boolean));
      } else if (child && typeof child.type === 'string') {
        stack.push(child);
      }
    }
  }
  return false;
}

/** The element a JSX `className` lands on, when the class list is that attribute's value. */
function classNameElement(root) {
  const attribute = root.parent?.type === 'JSXAttribute' ? root.parent : undefined;
  if (attribute?.name.name !== 'className') return undefined;
  const name = attribute.parent.name;
  return name.type === 'JSXMemberExpression' ? name.property.name : name.name;
}

/** @type {import('eslint').Rule.RuleModule} */
const disabledRecipe = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a shared disabled recipe wherever a class list dims a disabled control, so a `disabledStyle: fill` theme can paint it',
    },
    schema: [
      {
        type: 'object',
        properties: {
          /** Components whose rendered class list already composes a recipe on the element
           *  that takes `className`, so a caller's dim there is painted over by the recipe. */
          primitives: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missing:
        '`{{dim}}` dims a disabled control without a disabled recipe: compose disabledFillClasses, disabledInkClasses or disabledWithinFillClasses (@librechat/client) into the same class list, so a theme with `disabledStyle: fill` paints it instead of fading it.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    const primitives = new Set(context.options[0]?.primitives ?? []);
    /** `node` is the string as an expression; a template's text reports on its own part. */
    const check = (node, value, reported = node) => {
      if (typeof value !== 'string' || !value.includes('opacity-')) return;
      const dim =
        variantDim(value) ?? (chosenByDisabled(node, source) ? bareDim(value) : undefined);
      if (!dim) return;
      const list = classList(node);
      if (primitives.has(classNameElement(list))) return;
      if (composesRecipe(list, source.visitorKeys)) return;
      context.report({ node: reported, messageId: 'missing', data: { dim } });
    };
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node.parent, node.value.cooked, node);
      },
    };
  },
};

export default {
  meta: { name: 'design' },
  rules: { 'disabled-recipe': disabledRecipe },
};
