/**
 * Design rules `@shadcn/lint` does not cover, registered as the `design` plugin in
 * `eslint.config.mjs` and recorded in `eslint-suppressions.json` like its rules.
 */

/** The shared disabled recipes (`packages/client/src/utils/theme.ts`), by name or by the
 *  variant each one is written in, so a class list that spells a recipe out also counts. */
const RECIPE =
  /\b(?:disabledFillClasses|disabledInkClasses|disabledWithinFillClasses|peerDisabledInkClasses)\b|(?:^|[\s'"`])(?:peer-)?theme-disabled(?:-within)?:/;

/** Variants that select a disabled control, its group, its peer or a wrapper around it. */
const DISABLED_VARIANT =
  /^(?:(?:group|peer)-)?(?:disabled|aria-disabled|data-disabled|data-\[disabled(?:=[^\]]*)?\]|has-\[:disabled\]|has-disabled)$/;

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
    return isOpacity(base) && variants.some((variant) => DISABLED_VARIANT.test(variant));
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

/** The whole class list the string belongs to. */
function classList(node) {
  let current = node;
  while (current.parent && COMPOSING.has(current.parent.type)) {
    current = current.parent;
  }
  return current;
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
      if (RECIPE.test(source.getText(classList(node)))) return;
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
