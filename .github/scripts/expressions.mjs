/**
 * Evaluates the subset of GitHub Actions expressions the workflows here use, so a test can
 * state what a job condition, matrix or concurrency group resolves to for a given event
 * instead of matching the expression's text. Covers literals, context lookups, `!`, `==`,
 * `!=`, `&&`, `||`, parentheses and the functions passed in `functions`.
 */

const TOKEN =
  /\s*(?:('(?:[^']|'')*')|(-?\d+(?:\.\d+)?)|(==|!=|&&|\|\||[!(),])|([A-Za-z_][\w-]*(?:\.[\w-]+)*))/y;

function tokenize(source) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(source);
    if (!match) {
      if (source.slice(start).trim() === '') break;
      throw new Error(`Unsupported expression syntax at: ${source.slice(start, start + 40)}`);
    }
    const [, string, number, operator, name] = match;
    if (string !== undefined) {
      tokens.push({ type: 'value', value: string.slice(1, -1).replaceAll("''", "'") });
    } else if (number !== undefined) {
      tokens.push({ type: 'value', value: Number(number) });
    } else if (operator !== undefined) {
      tokens.push({ type: operator });
    } else {
      tokens.push({ type: 'name', name });
    }
  }
  return tokens;
}

const truthy = (value) =>
  !(value === false || value === 0 || value === '' || value == null || Number.isNaN(value));

function toNumber(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  return typeof value === 'string' ? Number(value) : NaN;
}

/** Same-type values compare directly (strings ignoring case); mixed types compare as numbers. */
function equal(left, right) {
  if (typeof left === 'string' && typeof right === 'string') {
    return left.toLowerCase() === right.toLowerCase();
  }
  if (left === right) return true;
  const sameType = typeof left === typeof right && left != null && right != null;
  return sameType ? false : toNumber(left) === toNumber(right);
}

const BUILTINS = {
  fromJSON: (text) => JSON.parse(text),
  contains: (haystack, needle) =>
    Array.isArray(haystack)
      ? haystack.some((item) => equal(item, needle))
      : String(haystack ?? '')
          .toLowerCase()
          .includes(String(needle ?? '').toLowerCase()),
};

const LITERALS = new Map([
  ['true', true],
  ['false', false],
  ['null', null],
]);

/** A missing property is null, as in Actions. */
const lookup = (context, path) =>
  path.split('.').reduce((value, key) => (value == null ? null : (value[key] ?? null)), context);

export function evaluate(source, context = {}, functions = {}) {
  const tokens = tokenize(source);
  const calls = { ...BUILTINS, ...functions };
  let position = 0;
  const peek = () => tokens[position]?.type;
  const take = (type) => {
    const token = tokens[position];
    if (!token || (type && token.type !== type)) {
      throw new Error(`Expected ${type ?? 'a token'} in: ${source}`);
    }
    position += 1;
    return token;
  };

  /** `evaluating` is false on the short-circuited side, which is parsed but never called. */
  function primary(evaluating) {
    if (peek() === '(') {
      take('(');
      const value = or(evaluating);
      take(')');
      return value;
    }
    if (peek() === 'value') return take('value').value;
    const { name } = take('name');
    if (peek() !== '(') return LITERALS.has(name) ? LITERALS.get(name) : lookup(context, name);
    take('(');
    const args = [];
    while (peek() !== ')') {
      args.push(or(evaluating));
      if (peek() === ',') take(',');
    }
    take(')');
    if (!evaluating) return null;
    if (!calls[name]) throw new Error(`Unsupported function ${name}() in: ${source}`);
    return calls[name](...args);
  }

  function unary(evaluating) {
    if (peek() !== '!') return primary(evaluating);
    take('!');
    return !truthy(unary(evaluating));
  }

  function comparison(evaluating) {
    let left = unary(evaluating);
    while (peek() === '==' || peek() === '!=') {
      const { type } = take();
      const right = unary(evaluating);
      left = type === '==' ? equal(left, right) : !equal(left, right);
    }
    return left;
  }

  function and(evaluating) {
    let left = comparison(evaluating);
    while (peek() === '&&') {
      take('&&');
      const right = comparison(evaluating && truthy(left));
      left = truthy(left) ? right : left;
    }
    return left;
  }

  function or(evaluating) {
    let left = and(evaluating);
    while (peek() === '||') {
      take('||');
      const right = and(evaluating && !truthy(left));
      left = truthy(left) ? left : right;
    }
    return left;
  }

  const value = or(true);
  if (position !== tokens.length) throw new Error(`Trailing tokens in: ${source}`);
  return value;
}

/** A job-level `if` is an expression whether or not it is wrapped in `${{ }}`. */
export function condition(source, context, functions) {
  const text = String(source).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  return truthy(evaluate(wrapped ? wrapped[1] : text, context, functions));
}

/** Resolves every `${{ }}` in a string; a value that is only an expression keeps its type. */
export function interpolate(template, context, functions) {
  const text = String(template).trim();
  const whole = /^\$\{\{((?:(?!\}\})[\s\S])*)\}\}$/.exec(text);
  if (whole) return evaluate(whole[1], context, functions);
  return text.replace(/\$\{\{((?:(?!\}\})[\s\S])*)\}\}/g, (_, expression) => {
    const value = evaluate(expression, context, functions);
    return value == null ? '' : String(value);
  });
}
