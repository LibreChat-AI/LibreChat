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

/** The variant each recipe is written in, so a class list that spells one out also counts. */
const RECIPE_VARIANT = /(?:^|\s)(?:peer-)?theme-disabled(?:-within)?:/;

/** A variant that selects a disabled control, its group, its peer or a wrapper around it:
 *  `disabled:`, `aria-disabled:`, `data-[state=disabled]:`, `has-[:disabled]:`, `[&:disabled]:`.
 *  The recipes' own `theme-disabled` and a negated `not-disabled` select something else. */
const isDisabledVariant = (variant) =>
  /disabled/.test(variant) && !/^(?:(?:group|peer)-)?(?:theme-disabled|not-)/.test(variant);

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

const isOpacity = (base) => /^!?opacity-/.test(base);

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

const mentionsDisabled = (source, node) => /disabled/i.test(source.getText(node));

/** Whether a `disabled` condition chooses the string: `disabled ? 'opacity-50' : ''`,
 *  `isDisabled && 'opacity-50'`, or `{ 'opacity-50': disabled }` in a class map. */
function chosenByDisabled(node, source) {
  const parent = node.parent;
  if (parent?.type === 'ConditionalExpression' && parent.test !== node) {
    return mentionsDisabled(source, parent.test);
  }
  if (parent?.type === 'LogicalExpression' && parent.right === node && parent.operator === '&&') {
    return mentionsDisabled(source, parent.left);
  }
  if (parent?.type === 'Property' && parent.key === node) {
    return mentionsDisabled(source, parent.value);
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

/** @type {import('eslint').Rule.RuleModule} */
const disabledRecipe = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a shared disabled recipe wherever a class list dims a disabled control, so a `disabledStyle: fill` theme can paint it',
    },
    schema: [],
    messages: {
      missing:
        '`{{dim}}` dims a disabled control without a disabled recipe: compose disabledFillClasses, disabledInkClasses or disabledWithinFillClasses (@librechat/client) into the same class list, so a theme with `disabledStyle: fill` paints it instead of fading it.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    /** `node` is the string as an expression; a template's text reports on its own part. */
    const check = (node, value, reported = node) => {
      if (typeof value !== 'string' || !value.includes('opacity-')) return;
      const dim =
        variantDim(value) ?? (chosenByDisabled(node, source) ? bareDim(value) : undefined);
      if (!dim) return;
      if (composesRecipe(classList(node), source.visitorKeys)) return;
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
