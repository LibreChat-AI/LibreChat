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
  [/(?:^|\s)theme-disabled:(!?)opacity-100(!?)(?=\s|$)/, 'self'],
  [/(?:^|\s)theme-disabled-within:(!?)opacity-100(!?)(?=\s|$)/, 'within'],
  [/(?:^|\s)peer-theme-disabled:(!?)opacity-100(!?)(?=\s|$)/, 'peer'],
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
  !/(?:not|non)[-_]?disabled/.test(variant) &&
  !/disabled\s*!?=\s*["']?false\b|disabled\s*!=/.test(variant);

/** Which element a disabled variant fades: the control, a wrapper that has one, a label that
 *  follows one through `peer`, or a descendant of a disabled `group` or of an ancestor an
 *  arbitrary selector names (`[tr[data-disabled=true]_&]`), which no recipe restores. */
function topologyOf(variant) {
  if (/^peer-/.test(variant)) return 'peer';
  if (/^group-/.test(variant)) return 'group';
  if (/^\[(?!&)/.test(variant)) return 'group';
  if (/^has-|:has\(/.test(variant)) return 'within';
  return SELF_MARKERS.test(variant) ? 'self' : 'group';
}

/** The disabled markers `theme-disabled` matches (`:disabled`, `[data-disabled]`,
 *  `[aria-disabled='true']`); a self variant spelled with another marker, such as
 *  `data-[state=disabled]`, is one no recipe restores. */
const SELF_MARKERS =
  /^(?:disabled|aria-disabled|data-disabled|data-\[disabled(?:=["']?true["']?)?\]|aria-\[disabled=["']?true["']?\]|\[&:disabled\]|\[&\[data-disabled\]\]|\[&\[aria-disabled=["']?true["']?\]\])$/;

const TOPOLOGY_ORDER = ['group', 'peer', 'within', 'self'];

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

const isImportant = (base) => base.startsWith('!') || base.endsWith('!');

/** Every utility in `value` that dims a disabled control through a variant, with the element
 *  it fades. */
function variantDims(value) {
  return value.split(/\s+/).flatMap((token) => {
    const { variants, base } = splitVariants(token);
    const selecting = isOpacity(base) ? variants.filter(isDisabledVariant) : [];
    if (selecting.length === 0) return [];
    /** A stacked utility (`disabled:group-disabled:opacity-50`) needs the recipe for its most
     *  distant element, which a recipe for a nearer one cannot restore. */
    const topologies = selecting.map(topologyOf);
    const topology = TOPOLOGY_ORDER.find((candidate) => topologies.includes(candidate));
    return [{ dim: token, topology, important: isImportant(base) }];
  });
}

/** The first fading `opacity-*` in `value` that no disabled variant already selects, for a
 *  string a `disabled` condition chooses (`opacity-50`, `sm:opacity-50`), restored by the recipe
 *  for the element it sits on. */
function bareDim(value, topology) {
  const token = value.split(/\s+/).find((candidate) => {
    const { variants, base } = splitVariants(candidate);
    return isOpacity(base) && !variants.some(isDisabledVariant);
  });
  return token
    ? { dim: token, topology, important: isImportant(splitVariants(token).base) }
    : undefined;
}

/** Whether a shared recipe restores a dim: it targets the dim's element, and the dim is not
 *  `!important`, which no shared recipe outranks. */
const covers = (recipe, need) =>
  recipe !== undefined && !need.important && (need.topology === 'any' || recipe === need.topology);

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
  property?.type !== 'Property' || property.computed
    ? undefined
    : (property.key.name ?? String(property.key.value));

/** The sense of a `cva` option chosen by a boolean `disabled` variant: the `true` option of a
 *  `disabled` group in `variants`, or the class of a `compoundVariants` entry that sets
 *  `disabled: true`. */
/** The boolean a compound-variant value selects: `true`, `false`, or an array of only one of
 *  them (`[true]`); a mixed or dynamic value says nothing. */
function booleanSelection(value) {
  if (value.type === 'Literal' && typeof value.value === 'boolean') return value.value;
  if (value.type !== 'ArrayExpression' || value.elements.length === 0) return undefined;
  const values = value.elements.map((element) =>
    element?.type === 'Literal' && typeof element.value === 'boolean' ? element.value : undefined,
  );
  return values.every((entry) => entry === values[0]) ? values[0] : undefined;
}

function cvaDisabledSense(property) {
  const name = keyName(property);
  const owner = property.parent;
  const group = owner?.parent;
  if (
    (name === 'true' || name === 'false') &&
    group?.type === 'Property' &&
    group.value === owner &&
    isDisabledName(keyName(group)) &&
    keyName(group.parent?.parent) === 'variants'
  ) {
    return name === 'true';
  }
  const compound =
    owner?.parent?.type === 'ArrayExpression' &&
    keyName(owner.parent.parent) === 'compoundVariants';
  if (compound && (name === 'class' || name === 'className')) {
    const flag = owner.properties.find(
      (entry) => entry.type === 'Property' && isDisabledName(keyName(entry)),
    );
    return flag ? booleanSelection(flag.value) : undefined;
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
    /** Reaching the alternate of `a || b` proves every operand false, so an operand that holds
     *  only while enabled (`!disabled`) proves the control disabled. */
    if (
      parent.alternate === node &&
      parent.test.type === 'LogicalExpression' &&
      parent.test.operator === '||' &&
      [parent.test.left, parent.test.right].some(
        (operand) => disabledSense(operand, source, known) === false,
      )
    ) {
      return true;
    }
    const sense = disabledSense(parent.test, source, known);
    if (sense === undefined) return chosenByDisabled(parent, source, known);
    return sense === (parent.consequent === node);
  }
  if (parent?.type === 'LogicalExpression' && parent.right === node && parent.operator === '&&') {
    const sense = disabledSense(parent.left, source, known);
    if (sense === undefined) return chosenByDisabled(parent, source, known);
    return sense === true;
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

/** The helpers that join their arguments into one class list; another call's result is not
 *  known to carry what it was given. */
const CLASS_CALLS = new Set(['cn', 'clsx', 'cx', 'classNames', 'twMerge', 'twJoin', 'cva']);
const isClassCall = (call, source) => {
  if (call.type !== 'CallExpression') return false;
  const { callee } = call;
  if (callee.type === 'MemberExpression') return CLASS_CALLS.has(callee.property.name);
  if (callee.type !== 'Identifier' || !CLASS_CALLS.has(callee.name)) return false;
  /** An imported helper is trusted; a local function that merely shares the name is not. */
  const variable = findVariable(source.getScope(call), callee.name);
  return !variable || variable.defs[0]?.type === 'ImportBinding';
};

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

  /** A spelled-out recipe for the dim's element, `!important` when the dim is. */
  const stringCovers = (value, need) =>
    typeof value === 'string' &&
    RECIPE_VARIANTS.some(([pattern, recipe]) => {
      const match = pattern.exec(value);
      if (!match || !(need.topology === 'any' || recipe === need.topology)) return false;
      return !need.important || Boolean(match[1] || match[2]);
    });

  /** Whether `node` emits a recipe covering `need` (the dim's element and importance) on every
   *  path through it. */
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
          const [base] = node.arguments;
          return base !== undefined && always(base, topology);
        }
        return (
          isClassCall(node, source) && node.arguments.some((argument) => always(argument, topology))
        );
      case 'ArrayExpression':
        return node.elements.some((element) => element && always(element, topology));
      case 'ConditionalExpression':
        return always(node.consequent, topology) && always(node.alternate, topology);
      case 'LogicalExpression':
        return (
          node.operator !== '&&' && always(node.left, topology) && always(node.right, topology)
        );
      case 'BinaryExpression':
        return (
          node.operator === '+' && (always(node.left, topology) || always(node.right, topology))
        );
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

  /** A sibling that always emits a covering recipe, or one guarded by the same condition as the
   *  dim's own entry, on the same side: `cn(disabled && 'opacity-50', disabled && recipe)` or
   *  `cn(disabled ? 'opacity-50' : '', disabled ? recipe : '')`. */
  const alongside = (sibling, child, start, topology) => {
    if (always(sibling, topology)) return true;
    const guarded = (node) => node.type === 'LogicalExpression' && node.operator === '&&';
    if (guarded(sibling) && guarded(child)) {
      return (
        source.getText(sibling.left) === source.getText(child.left) &&
        always(sibling.right, topology)
      );
    }
    if (sibling.type !== 'ConditionalExpression' || child.type !== 'ConditionalExpression') {
      return false;
    }
    if (source.getText(sibling.test) !== source.getText(child.test)) return false;
    let branch = start;
    while (branch.parent && branch.parent !== child) branch = branch.parent;
    const side = branch === child.consequent ? 'consequent' : 'alternate';
    return always(sibling[side], topology);
  };

  /** The parts of `parent` emitted whenever `child` is: the other arguments of a class helper,
   *  the other entries of an array or template, the base of a `cva` around a variant (a variant
   *  can be passed `null`, so it never proves one), and class map entries switched on by the same
   *  condition. A condition's other branch is not. */
  const companions = (parent, child, start, topology) => {
    switch (parent.type) {
      case 'CallExpression': {
        if (parent.callee === child) return false;
        if (isCva(parent)) {
          const [base] = parent.arguments;
          return child !== base && base !== undefined && always(base, topology);
        }
        if (!isClassCall(parent, source)) return false;
        return parent.arguments.some(
          (argument) => argument !== child && alongside(argument, child, start, topology),
        );
      }
      case 'ArrayExpression':
        return parent.elements.some(
          (element) => element && element !== child && alongside(element, child, start, topology),
        );
      case 'TemplateLiteral':
        return always(parent, topology);
      case 'BinaryExpression':
        return (
          parent.operator === '+' &&
          always(parent.left === child ? parent.right : parent.left, topology)
        );
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
      if (companions(child.parent, child, start, topology)) return true;
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

/** Marks an element that is disabled outright (`disabled`, `disabled={true}`,
 *  `aria-disabled="true"`), where every fade on it is a disabled dim. */
const STATIC = Symbol('static');

/** The element's own `disabled` and `aria-disabled` expressions, with their negations, so a
 *  condition spelled the same way reads as the disabled state whatever it is named. Any such
 *  attribute also says the element is the control itself. */
function disabledExpressions(element, source) {
  const known = new Map();
  for (const attribute of element?.attributes ?? []) {
    if (attribute.type !== 'JSXAttribute') continue;
    if (!['disabled', 'aria-disabled'].includes(attribute.name.name)) continue;
    const literal = attribute.value?.type === 'Literal' ? attribute.value.value : undefined;
    const expression =
      attribute.value?.type === 'JSXExpressionContainer' ? attribute.value.expression : undefined;
    if (
      attribute.value == null ||
      literal === 'true' ||
      (expression?.type === 'Literal' && expression.value === true)
    ) {
      known.set(STATIC, true);
      continue;
    }
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
      const control = element?.attributes.some(
        (attribute) =>
          attribute.type === 'JSXAttribute' &&
          ['disabled', 'aria-disabled'].includes(attribute.name.name),
      );
      /** A bare fade sits on the control when the element carries the disabled state, on a
       *  wrapper around it when the element does not, and on an unknown element outside JSX. */
      let bareTopology = 'any';
      if (element) bareTopology = control ? 'self' : 'within';
      const picked = known.get(STATIC) === true || chosenByDisabled(node, source, known);
      const chosen = picked ? bareDim(value, bareTopology) : undefined;
      const dims = [...variantDims(value), ...(chosen ? [chosen] : [])];
      if (dims.length === 0) return;
      /** A primitive's own recipe restores a plain fade of the control itself; an important one,
       *  or one on another element, still needs the caller's recipe. */
      const coveredByPrimitive = (need) =>
        !need.important && (need.topology === 'self' || need.topology === 'any');
      if (isPrimitive(element) && dims.every(coveredByPrimitive)) return;
      const missing = dims.find((need) => !restored(node, list, need));
      if (!missing) return;
      context.report({ node: reported, messageId: 'missing', data: { dim: missing.dim } });
    };
    /** A constant class string the element names (`const faded = 'opacity-50'` then
     *  `<button disabled className={faded} />`): read where it is used, since the literal on its
     *  own carries no disabled context. */
    const checkReference = (attribute) => {
      if (attribute.name.name !== 'className') return;
      const expression =
        attribute.value?.type === 'JSXExpressionContainer' ? attribute.value.expression : undefined;
      if (expression?.type !== 'Identifier') return;
      const element = attribute.parent;
      if (disabledExpressions(element, source).get(STATIC) !== true) return;
      const variable = findVariable(source.getScope(expression), expression.name);
      const declarator = variable?.defs[0]?.node;
      if (declarator?.type !== 'VariableDeclarator' || declarator.parent.kind !== 'const') return;
      const init = declarator.init;
      let value = init?.type === 'Literal' ? init.value : undefined;
      if (init?.type === 'TemplateLiteral' && init.expressions.length === 0) {
        value = init.quasis[0].value.cooked;
      }
      if (typeof value !== 'string') return;
      const dim = bareDim(value, 'self');
      if (!dim || (isPrimitive(element) && !dim.important)) return;
      context.report({ node: expression, messageId: 'missing', data: { dim: dim.dim } });
    };

    return {
      JSXAttribute: checkReference,
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
