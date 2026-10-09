import { dirname, resolve } from 'node:path';

/**
 * Design rules `@shadcn/lint` does not cover, registered as the `design` plugin in
 * `eslint.config.mjs` and recorded in `eslint-suppressions.json` like its rules.
 */

/** The shared disabled recipes (`packages/client/src/utils/theme.ts`) and the element each one
 *  restores: the control itself (`theme-disabled`), a wrapper around it (`theme-disabled-within`)
 *  or a label that follows it through `peer`. */
const RECIPES = new Map([
  ['disabledFillClasses', 'self'],
  ['disabledInkClasses', 'self'],
  ['disabledWithinFillClasses', 'within'],
  ['peerDisabledInkClasses', 'peer'],
]);

/** The full-opacity override every recipe carries, so a class list that spells one out also
 *  counts; another `theme-disabled:` utility alone still leaves the control faded. */
const RECIPE_VARIANTS = [
  [/(?:^|\s)theme-disabled:!?opacity-100!?(?=\s|$)/, 'self'],
  [/(?:^|\s)theme-disabled-within:!?opacity-100!?(?=\s|$)/, 'within'],
  [/(?:^|\s)peer-theme-disabled:!?opacity-100!?(?=\s|$)/, 'peer'],
];

/** Where the shared primitives live, for a relative import inside the component library. */
const PRIMITIVES_DIR = /packages[\\/]client[\\/]src[\\/]components[\\/]([\w.-]+?)(?:\.tsx?)?$/;

/** The file that defines the recipes, where a local binding with a recipe's name is the recipe. */
const RECIPES_FILE = /packages[\\/]client[\\/]src[\\/]utils[\\/]theme\.ts$/;
const COMPONENT_LIBRARY = /packages[\\/]client[\\/]src[\\/]/;
/** The recipes' module and the barrel that re-exports it, for a relative import. */
const RECIPES_MODULE = /packages[\\/]client[\\/]src[\\/]utils(?:[\\/](?:theme|index))?(?:\.ts)?$/;

/** Whether an import of a recipe's name comes from the module that defines the recipes: the
 *  package, or inside the component library its `~/utils` alias or a relative path to it. */
function isRecipeSource(from, filename) {
  if (from === '@librechat/client') return true;
  if (!COMPONENT_LIBRARY.test(filename)) return false;
  if (from === '~/utils' || from === '~/utils/theme') return true;
  return from.startsWith('.') && RECIPES_MODULE.test(resolve(dirname(filename), from));
}

/** A variant that selects a disabled control, its group, its peer or a wrapper around it:
 *  `disabled:`, `aria-disabled:`, `data-[state=disabled]:`, `has-[:disabled]:`, `[&:disabled]:`.
 *  The recipes' own `theme-disabled`, a negated `not-disabled` or `[&:not(:disabled)]` and an
 *  explicit `[disabled=false]` select something else. */
const isDisabledVariant = (variant) =>
  /disabled/.test(variant) &&
  !/^(?:(?:group|peer)-)?(?:theme-disabled|not-)/.test(variant) &&
  !/:not\([^)]*disabled/.test(variant) &&
  !/disabled\s*!?=\s*["']?false\b|disabled\s*!=/.test(variant);

/** Which element a disabled variant fades: the control, a wrapper that has one, a label that
 *  follows one through `peer`, or a descendant of a disabled `group`, which no recipe restores. */
function topologyOf(variant) {
  if (/^peer-/.test(variant)) return 'peer';
  if (/^group-/.test(variant)) return 'group';
  if (/^has-|:has\(/.test(variant)) return 'within';
  return 'self';
}

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

/** An opacity that fades: `opacity-100` (or `opacity-100!`) keeps the control opaque, so it is
 *  not a dim. */
const isOpacity = (base) => /^!?opacity-(?!100!?$)/.test(base);

/** Every utility in `value` that dims a disabled control through a variant, with the element
 *  it fades. */
function variantDims(value) {
  return value.split(/\s+/).flatMap((token) => {
    const { variants, base } = splitVariants(token);
    const variant = isOpacity(base) ? variants.find(isDisabledVariant) : undefined;
    return variant ? [{ dim: token, topology: topologyOf(variant) }] : [];
  });
}

/** The first bare `opacity-*` in `value`, for a string a `disabled` condition chooses. Which
 *  element it sits on is not known, so any recipe restores it. */
function bareDim(value) {
  const token = value.split(/\s+/).find((candidate) => {
    const { variants, base } = splitVariants(candidate);
    return variants.length === 0 && isOpacity(base);
  });
  return token ? { dim: token, topology: 'any' } : undefined;
}

const covers = (recipe, topology) =>
  recipe !== undefined && (topology === 'any' || recipe === topology);

/** The variable a name resolves to from `scope`, or `undefined` when nothing declares it. */
function findVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return undefined;
}

/** Whether `test` holds only while the control is disabled (`true`), only while it is enabled
 *  (`false`), or says nothing certain about it (`undefined`). `known` holds the element's own
 *  `disabled` and `aria-disabled` expressions, so a condition spelled the same way counts
 *  whatever its name. A `!` or a comparison to `false` flips the sense; an `&&` takes the sense
 *  of any operand that has one, and anything else that is not a plain reference to a `disabled`
 *  value is unknown. */
function disabledSense(test, source, known) {
  const text = source.getText(test);
  if (known.has(text)) return known.get(text);
  if (test.type === 'UnaryExpression' && test.operator === '!') {
    const inner = disabledSense(test.argument, source, known);
    return inner === undefined ? undefined : !inner;
  }
  if (test.type === 'BinaryExpression' && /^[!=]==?$/.test(test.operator)) {
    const literal = [test.left, test.right].find((side) => side.type === 'Literal');
    if (!literal || typeof literal.value !== 'boolean') return undefined;
    const inner = disabledSense(literal === test.left ? test.right : test.left, source, known);
    if (inner === undefined) return undefined;
    const flips = literal.value === test.operator.startsWith('!');
    return flips ? !inner : inner;
  }
  if (test.type === 'LogicalExpression' && test.operator === '&&') {
    const senses = [
      disabledSense(test.left, source, known),
      disabledSense(test.right, source, known),
    ];
    const certain = senses.filter((sense) => sense !== undefined);
    return certain.length > 0 && certain.every((sense) => sense === certain[0])
      ? certain[0]
      : undefined;
  }
  if (['Identifier', 'MemberExpression', 'ChainExpression'].includes(test.type)) {
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
 *  `isDisabled && 'opacity-50'`, `{ 'opacity-50': disabled }` in a class map, or a map that is
 *  itself chosen (`disabled && { 'opacity-50': true }`). A string the condition picks for the
 *  enabled state (`disabled ? '' : 'opacity-50'`) is not a disabled dim. */
const isDisabledName = (name) =>
  typeof name === 'string' && /disabled/i.test(name) && !/(?:not|non)_?disabled/i.test(name);

const keyName = (property) =>
  property.computed ? undefined : (property.key.name ?? String(property.key.value));

/** The sense of a `cva` option chosen by a boolean `disabled` variant: the `true` option of a
 *  `disabled` group in `variants`, or the class of a `compoundVariants` entry that sets
 *  `disabled: true`. */
function cvaDisabledSense(property) {
  const name = keyName(property);
  const owner = property.parent;
  const group = owner?.parent;
  if (
    (name === 'true' || name === 'false') &&
    group?.type === 'Property' &&
    group.value === owner &&
    isDisabledName(keyName(group)) &&
    keyName(group.parent?.parent ?? {}) === 'variants'
  ) {
    return name === 'true';
  }
  if (name === 'class' || name === 'className') {
    const flag = owner.properties.find(
      (entry) =>
        entry.type === 'Property' &&
        isDisabledName(keyName(entry)) &&
        entry.value.type === 'Literal' &&
        typeof entry.value.value === 'boolean',
    );
    return flag ? flag.value.value : undefined;
  }
  return undefined;
}

function chosenByDisabled(start, source, known) {
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
    const sense = disabledSense(parent.test, source, known);
    return sense !== undefined && sense === (parent.consequent === node);
  }
  if (parent?.type === 'LogicalExpression' && parent.right === node && parent.operator === '&&') {
    return disabledSense(parent.left, source, known) === true;
  }
  if (
    parent?.type === 'Property' &&
    parent.value === node &&
    parent.parent?.type === 'ObjectExpression'
  ) {
    return cvaDisabledSense(parent) === true;
  }
  if (parent?.type === 'Property' && parent.key === node) {
    const sense = disabledSense(parent.value, source, known);
    if (sense !== undefined) return sense;
    const always = parent.value.type === 'Literal' && parent.value.value === true;
    return always && chosenByDisabled(parent.parent, source, known);
  }
  return false;
}

/** Whether an object belongs to a call's arguments, as a class map or a `cva` config does,
 *  rather than being a props or style object of its own. */
function isCallArgument(object) {
  let current = object;
  while (
    [
      'ObjectExpression',
      'Property',
      'ArrayExpression',
      'ConditionalExpression',
      'LogicalExpression',
    ].includes(current.parent?.type)
  ) {
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

/** The JSX element whose `className` the class list is, when it is one. */
function classNameElement(root) {
  const attribute = root.parent?.type === 'JSXAttribute' ? root.parent : undefined;
  return attribute?.name.name === 'className' ? attribute.parent : undefined;
}

const isCva = (call) => call.type === 'CallExpression' && call.callee.name === 'cva';

const propertyNamed = (object, name) =>
  object?.type === 'ObjectExpression'
    ? object.properties.find(
        (property) =>
          property.type === 'Property' &&
          !property.computed &&
          (property.key.name ?? property.key.value) === name,
      )
    : undefined;

/** Reads, for one class list, what a recipe reference resolves to and which strings and
 *  expressions always emit one. */
function recipeReader(context) {
  const source = context.sourceCode;
  const inRecipesFile = RECIPES_FILE.test(context.filename);

  /** The recipe an identifier is: an import of one (under any local name), the recipe itself in
   *  the file that defines it, or, when nothing declares the name, the name alone. A local that
   *  shadows a recipe's name is not one. */
  const recipeOf = (identifier) => {
    const variable = findVariable(source.getScope(identifier), identifier.name);
    if (!variable) return RECIPES.get(identifier.name);
    const definition = variable.defs[0];
    if (definition?.type === 'ImportBinding') {
      const imported = definition.node.imported;
      if (!imported || !isRecipeSource(definition.parent.source.value, context.filename)) {
        return undefined;
      }
      return RECIPES.get(imported.name ?? imported.value);
    }
    return inRecipesFile ? RECIPES.get(identifier.name) : undefined;
  };

  /** The recipe `namespace.name` is, when `namespace` is the recipes' module imported whole (or,
   *  when nothing declares it, by the name alone). */
  const memberRecipeOf = (member) => {
    const name = RECIPES.get(member.property.name);
    if (!name || member.object.type !== 'Identifier') return undefined;
    const variable = findVariable(source.getScope(member), member.object.name);
    if (!variable) return name;
    const definition = variable.defs[0];
    const whole =
      definition?.type === 'ImportBinding' && definition.node.type === 'ImportNamespaceSpecifier';
    return whole && isRecipeSource(definition.parent.source.value, context.filename)
      ? name
      : undefined;
  };

  const stringCovers = (value, topology) =>
    typeof value === 'string' &&
    RECIPE_VARIANTS.some(([pattern, recipe]) => covers(recipe, topology) && pattern.test(value));

  /** Every option of some `cva` variant group composes a covering recipe, and the group has a
   *  default, so whichever option is chosen, or none, restores the control. */
  const variantsAlways = (config, topology) => {
    const groups = propertyNamed(config, 'variants')?.value;
    if (groups?.type !== 'ObjectExpression') return false;
    const defaults = propertyNamed(config, 'defaultVariants')?.value;
    return groups.properties.some(
      (group) =>
        group.type === 'Property' &&
        !group.computed &&
        propertyNamed(defaults, group.key.name ?? group.key.value) !== undefined &&
        group.value.type === 'ObjectExpression' &&
        group.value.properties.length > 0 &&
        group.value.properties.every(
          (option) => option.type === 'Property' && always(option.value, topology),
        ),
    );
  };

  /** Whether `node` emits a recipe covering `topology` on every path through it. */
  const always = (node, topology) => {
    switch (node.type) {
      case 'Literal':
        return stringCovers(node.value, topology);
      case 'TemplateElement':
        return stringCovers(node.value.cooked, topology);
      case 'TemplateLiteral':
        return (
          node.quasis.some((quasi) => always(quasi, topology)) ||
          node.expressions.some((expression) => always(expression, topology))
        );
      case 'Identifier':
        return covers(recipeOf(node), topology);
      case 'MemberExpression':
        return !node.computed && covers(memberRecipeOf(node), topology);
      case 'CallExpression':
        if (isCva(node)) {
          const [base, config] = node.arguments;
          return (base !== undefined && always(base, topology)) || variantsAlways(config, topology);
        }
        return node.arguments.some((argument) => always(argument, topology));
      case 'ArrayExpression':
        return node.elements.some((element) => element && always(element, topology));
      case 'ConditionalExpression':
        return always(node.consequent, topology) && always(node.alternate, topology);
      case 'LogicalExpression':
        return (
          node.operator !== '&&' && always(node.left, topology) && always(node.right, topology)
        );
      case 'BinaryExpression':
        return always(node.left, topology) || always(node.right, topology);
      case 'ObjectExpression':
        return node.properties.some((property) => mapEntryAlways(property, topology));
      case 'SpreadElement':
        return always(node.argument, topology);
      case 'ChainExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
        return always(node.expression, topology);
      default:
        return false;
    }
  };

  /** A class-map entry that is always on and names a covering recipe. */
  const mapEntryAlways = (property, topology) =>
    property.type === 'Property' &&
    property.value.type === 'Literal' &&
    property.value.value === true &&
    (property.computed
      ? always(property.key, topology)
      : stringCovers(property.key.value, topology));

  /** The parts of `parent` emitted whenever `child` is: the other arguments of a class call,
   *  the other entries of an array or template, the base of a `cva` around a variant, and class
   *  map entries switched on by the same condition. A condition's other branch is not. */
  /** A sibling that always emits a covering recipe, or one guarded by the same condition as the
   *  dim's own entry: `cn(disabled && 'opacity-50', disabled && disabledFillClasses)`. */
  const alongside = (sibling, child, topology) => {
    if (always(sibling, topology)) return true;
    const guarded = (node) => node.type === 'LogicalExpression' && node.operator === '&&';
    return (
      guarded(sibling) &&
      guarded(child) &&
      source.getText(sibling.left) === source.getText(child.left) &&
      always(sibling.right, topology)
    );
  };

  const companions = (parent, child, topology) => {
    switch (parent.type) {
      case 'CallExpression': {
        if (parent.callee === child) return false;
        if (isCva(parent)) {
          const [base, config] = parent.arguments;
          return child === base
            ? variantsAlways(config, topology)
            : base !== undefined && always(base, topology);
        }
        return parent.arguments.some(
          (argument) => argument !== child && alongside(argument, child, topology),
        );
      }
      case 'ArrayExpression':
        return parent.elements.some(
          (element) => element && element !== child && alongside(element, child, topology),
        );
      case 'TemplateLiteral':
        return always(parent, topology);
      case 'BinaryExpression':
        return always(parent.left === child ? parent.right : parent.left, topology);
      case 'ObjectExpression': {
        if (child.type !== 'Property') return false;
        const condition = source.getText(child.value);
        return parent.properties.some(
          (property) =>
            property !== child &&
            property.type === 'Property' &&
            (mapEntryAlways(property, topology) ||
              (source.getText(property.value) === condition &&
                (property.computed
                  ? always(property.key, topology)
                  : stringCovers(property.key.value, topology)))),
        );
      }
      default:
        return false;
    }
  };

  /** Whether a covering recipe is emitted on every path that emits the string at `start`,
   *  looking no further than the class list it belongs to. */
  return (start, list, topology) => {
    if (always(start, topology)) return true;
    for (let child = start; child !== list && child.parent; child = child.parent) {
      if (companions(child.parent, child, topology)) return true;
    }
    return false;
  };
}

/** The component a JSX element names and the import it comes from: `<Button>` from its import,
 *  `<ui.Checkbox>` from the namespace `ui` is imported as. */
function elementImport(element, source) {
  const name = element.name;
  const local = name.type === 'JSXMemberExpression' ? name.object : name;
  if (local.type !== 'JSXIdentifier') return undefined;
  const component = name.type === 'JSXMemberExpression' ? name.property.name : name.name;
  const variable = findVariable(source.getScope(element), local.name);
  if (!variable) return { component, from: undefined, declared: false };
  const definition = variable.defs[0];
  if (definition?.type !== 'ImportBinding') return { component, from: null, declared: true };
  const from = definition.parent.source.value;
  if (name.type === 'JSXMemberExpression') {
    const namespace = definition.node.type === 'ImportNamespaceSpecifier';
    return { component: namespace ? component : undefined, from, declared: true };
  }
  const imported = definition.node.imported;
  return { component: imported?.name ?? imported?.value, from, declared: true };
}

/** The element's own `disabled` and `aria-disabled` expressions, with their negations, so a
 *  condition spelled the same way reads as the disabled state whatever it is named. */
function disabledExpressions(element, source) {
  const known = new Map();
  for (const attribute of element?.attributes ?? []) {
    if (attribute.type !== 'JSXAttribute') continue;
    if (!['disabled', 'aria-disabled'].includes(attribute.name.name)) continue;
    const expression =
      attribute.value?.type === 'JSXExpressionContainer' ? attribute.value.expression : undefined;
    if (!expression || expression.type === 'JSXEmptyExpression' || expression.type === 'Literal') {
      continue;
    }
    known.set(source.getText(expression), true);
    if (expression.type === 'UnaryExpression' && expression.operator === '!') {
      known.set(source.getText(expression.argument), false);
    }
  }
  return known;
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
          /** The modules those components are imported from; the same name from anywhere else
           *  is another component. */
          sources: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missing:
        '`{{dim}}` dims a disabled control without a disabled recipe that restores it on every path: compose disabledFillClasses or disabledInkClasses for the control itself, disabledWithinFillClasses for a wrapper around it or peerDisabledInkClasses for a label that follows it (@librechat/client) into the same class list, so a theme with `disabledStyle: fill` paints it instead of fading it.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    const primitives = new Set(context.options[0]?.primitives ?? []);
    const sources = new Set(context.options[0]?.sources ?? ['@librechat/client']);
    const restored = recipeReader(context);

    /** A configured primitive imported from a configured module or, inside the component
     *  library, from its own file; when the file declares no such name at all, the name alone. */
    const isPrimitive = (element) => {
      const resolved = element ? elementImport(element, source) : undefined;
      if (!resolved || !primitives.has(resolved.component)) return false;
      if (!resolved.declared) return true;
      if (sources.has(resolved.from)) return true;
      if (typeof resolved.from !== 'string' || !resolved.from.startsWith('.')) return false;
      const file = resolve(dirname(context.filename), resolved.from);
      return PRIMITIVES_DIR.exec(file)?.[1] === resolved.component;
    };

    /** `node` is the string as an expression; a template's text reports on its own part. */
    const check = (node, value, reported = node) => {
      if (typeof value !== 'string' || !value.includes('opacity-')) return;
      const list = classList(node);
      const element = classNameElement(list);
      const known = disabledExpressions(element, source);
      const chosen = chosenByDisabled(node, source, known) ? bareDim(value) : undefined;
      const dims = [...variantDims(value), ...(chosen ? [chosen] : [])];
      if (dims.length === 0 || isPrimitive(element)) return;
      const missing = dims.find(({ topology }) => !restored(node, list, topology));
      if (!missing) return;
      context.report({ node: reported, messageId: 'missing', data: { dim: missing.dim } });
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
