import { codes, types } from 'micromark-util-symbol';
import { asciiDigit, markdownLineEnding, markdownSpace } from 'micromark-util-character';
import type {
  Code,
  Construct,
  Effects,
  Extension,
  State,
  TokenizeContext,
} from 'micromark-util-types';
import type { Plugin } from 'unified';
import type { Root } from 'mdast';

interface ParserData {
  micromarkExtensions?: Extension[];
}

/**
 * Single-dollar inline math is re-enabled here as a micromark construct instead of the
 * string preprocessing it replaces, because `$...$` is ambiguous with prices ("from $2bn
 * to at least $4bn") and only the tokenizer can decide a span without rewriting the
 * message: code spans, fences, and autolinks are structurally excluded, and a rejected
 * span stays byte-identical text. `remark-math` keeps running with
 * `singleDollarTextMath: false`; this construct is the sole single-dollar path.
 *
 * A `$...$` span becomes math only when all of Pandoc's boundary rules hold:
 * - the opening `$` is immediately followed by a non-space character;
 * - the closing `$` is immediately preceded by a non-space character and not immediately
 *   followed by a digit (rejects ranges like "$100-$200");
 * - the span stays on one line, contains no backtick, treats `\`-pairs as opaque
 *   (`\$` stays inside the span), and closes with balanced braces.
 *
 * A failed close abandons the whole attempt (`nok`) instead of scanning further, so the
 * next `$` in "Price is $50 and $100" can never silently extend a span; micromark then
 * retries the construct at that `$` on its own merits.
 */
function tokenizeMathSpan(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let previousCode: Code = null;
  let braceDepth = 0;

  function start(code: Code): State | undefined {
    effects.enter('mathText');
    effects.enter('mathTextSequence');
    effects.consume(code);
    effects.exit('mathTextSequence');
    return open;
  }

  function open(code: Code): State | undefined {
    if (
      code === codes.eof ||
      code === codes.dollarSign ||
      code === codes.graveAccent ||
      markdownSpace(code) ||
      markdownLineEnding(code)
    ) {
      return nok(code);
    }
    effects.enter('mathTextData');
    return content(code);
  }

  function content(code: Code): State | undefined {
    if (code === codes.eof || code === codes.graveAccent || markdownLineEnding(code)) {
      return nok(code);
    }
    if (code === codes.dollarSign) {
      if (markdownSpace(previousCode) || braceDepth !== 0) {
        return nok(code);
      }
      effects.exit('mathTextData');
      effects.enter('mathTextSequence');
      effects.consume(code);
      return close;
    }
    if (code === codes.backslash) {
      effects.consume(code);
      return escape;
    }
    if (code === codes.leftCurlyBrace) {
      braceDepth++;
    }
    if (code === codes.rightCurlyBrace) {
      if (braceDepth === 0) {
        return nok(code);
      }
      braceDepth--;
    }
    previousCode = code;
    effects.consume(code);
    return content;
  }

  function escape(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      return nok(code);
    }
    previousCode = code;
    effects.consume(code);
    return content;
  }

  function close(code: Code): State | undefined {
    if (code === codes.dollarSign || asciiDigit(code)) {
      return nok(code);
    }
    effects.exit('mathTextSequence');
    effects.exit('mathText');
    return ok(code);
  }

  return start;
}

/** Mirrors `micromark-extension-math`: a `$` opener is valid unless it follows an unescaped `$`. */
function previous(this: TokenizeContext, code: Code): boolean {
  return (
    code !== codes.dollarSign ||
    this.events[this.events.length - 1][1].type === types.characterEscape
  );
}

const mathSpan: Construct = {
  name: 'mathSpanSingleDollar',
  tokenize: tokenizeMathSpan,
  previous,
};

/**
 * micromark syntax extension adding currency-safe single-dollar inline math. It emits the
 * same `mathText`/`mathTextData` tokens as `micromark-extension-math`, so `remark-math`'s
 * `mathFromMarkdown` handlers turn its spans into regular `inlineMath` nodes. Registration
 * order relative to `remark-math` is immaterial: this construct rejects `$$` openers and
 * `remark-math` (with `singleDollarTextMath: false`) rejects single `$` openers.
 */
export const singleDollarMath: Extension = {
  text: { [codes.dollarSign]: mathSpan },
};

/**
 * remark plugin enabling {@link singleDollarMath}. Must run alongside `remark-math`, which
 * registers the mdast handlers for the tokens this extension emits.
 */
export const remarkSingleDollarMath: Plugin<[], Root> = function remarkSingleDollarMath() {
  const data = this.data() as ParserData;
  const extensions = (data.micromarkExtensions ??= []);
  extensions.push(singleDollarMath);
};
