import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import { render } from '@testing-library/react';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Options as ReactMarkdownOptions } from 'react-markdown';
import {
  getRemarkPlugins,
  getRehypePlugins,
} from '~/components/Chat/Messages/Content/markdownConfig';
import { singleDollarMath } from './latex';

type SpecNode = {
  type: string;
  value?: string;
  children?: SpecNode[];
};

/**
 * Mirrors the production parser: `micromark-extension-math` resolves to
 * `micromark-extension-llm-math` (vite alias in the app, moduleNameMapper here), with
 * single-dollar spans handled exclusively by the `singleDollarMath` construct.
 */
const parse = (content: string): SpecNode =>
  fromMarkdown(content, {
    extensions: [math({ singleDollarTextMath: false }), singleDollarMath],
    mdastExtensions: [mathFromMarkdown()],
  }) as SpecNode;

const collect = (node: SpecNode, type: string, values: string[] = []): string[] => {
  if (node.type === type && node.value !== undefined) {
    values.push(node.value);
  }
  for (const child of node.children ?? []) {
    collect(child, type, values);
  }
  return values;
};

const hasType = (node: SpecNode, type: string): boolean => {
  if (node.type === type) {
    return true;
  }
  return (node.children ?? []).some((child) => hasType(child, type));
};

const inlineMath = (content: string): string[] => collect(parse(content), 'inlineMath');
const flowMath = (content: string): string[] => collect(parse(content), 'math');
const textOf = (content: string): string => collect(parse(content), 'text').join('');

describe('singleDollarMath', () => {
  describe('currency stays literal', () => {
    test('Treasury buyback report (production bug)', () => {
      const content =
        'The U.S. Treasury said it would at least double long-dated bond buybacks, from $2bn to at least $4bn per operation starting Sept 9.';
      expect(inlineMath(content)).toEqual([]);
      expect(textOf(content)).toContain('from $2bn to at least $4bn per operation');
    });

    test('plain amounts', () => {
      expect(inlineMath('Price is $50 and $100')).toEqual([]);
      expect(inlineMath('$50 is $20 + $30')).toEqual([]);
      expect(inlineMath('The price is $1,000,000 for this item.')).toEqual([]);
      expect(inlineMath('Total: $29.50 plus tax')).toEqual([]);
    });

    test('abbreviated amounts', () => {
      expect(inlineMath('Revenue: $5M to $10M, funding: $1.5B, price: $5K')).toEqual([]);
      expect(inlineMath('$250k is 25% of $1M')).toEqual([]);
      expect(inlineMath('More than $1bn in leveraged shorts, over $3bn total')).toEqual([]);
    });

    test('long decimals and large numbers', () => {
      expect(inlineMath('You can win $1000000 or even $9999999.99!')).toEqual([]);
      expect(inlineMath('Bitcoin: $0.00001234, Gas: $3.999, Rate: $1.234567890')).toEqual([]);
      expect(
        inlineMath('The total is $1157.90 (existing) + $500 (new investment) = $1657.90.'),
      ).toEqual([]);
    });

    test('ranges with a punctuation dash reject on the trailing digit', () => {
      expect(inlineMath('a $100-$200 range')).toEqual([]);
      expect(inlineMath('a $100–$200 range')).toEqual([]);
      expect(inlineMath('in the $10k-$20k band')).toEqual([]);
    });

    test('sums across a whole line', () => {
      expect(inlineMath('- **Total Savings**: $500 + $200 + $150 = $850')).toEqual([]);
    });

    test('suffixed European style amounts', () => {
      expect(inlineMath('Cela coûte 100$ et 200$ en Europe')).toEqual([]);
    });

    test('lone and trailing dollar signs', () => {
      expect(inlineMath('A single $ sign should not be converted')).toEqual([]);
      expect(inlineMath('The price hit $79,455 on')).toEqual([]);
    });

    test('amounts on separate lines of one paragraph', () => {
      expect(inlineMath('Currency $100 and\nthen $200 later')).toEqual([]);
    });
  });

  describe('single-dollar math parses', () => {
    test('basic expressions', () => {
      expect(inlineMath('Inline math: $x^2 + y^2 = z^2$')).toEqual(['x^2 + y^2 = z^2']);
      expect(inlineMath('Equation: $f(x) = 2x + 3$ where x is a variable.')).toEqual([
        'f(x) = 2x + 3',
      ]);
      expect(inlineMath('First $a + b = c$ and second $x^2 + y^2 = z^2$')).toEqual([
        'a + b = c',
        'x^2 + y^2 = z^2',
      ]);
    });

    test('digit-led expressions are still math', () => {
      expect(
        inlineMath('- **Goldbach Conjecture**: $2n = p + q$ (every even integer > 2)'),
      ).toEqual(['2n = p + q']);
      expect(inlineMath('the answer is $3$.')).toEqual(['3']);
      expect(inlineMath('an eigenvalue of $-1$ is expected')).toEqual(['-1']);
    });

    test('letters may follow the closer (ordinals)', () => {
      expect(inlineMath('the $n$th term')).toEqual(['n']);
    });

    test('trailing punctuation after the closer', () => {
      expect(inlineMath('The set is defined as $\\{x | x > 0\\}$.')).toEqual(['\\{x | x > 0\\}']);
    });

    test('physics expressions', () => {
      const content = [
        '- **Schrödinger Equation**: $i\\hbar\\frac{\\partial}{\\partial t}|\\psi\\rangle = \\hat{H}|\\psi\\rangle$',
        '- **Einstein Field Equations**: $G_{\\mu\\nu} = \\frac{8\\pi G}{c^4} T_{\\mu\\nu}$',
      ].join('\n');
      expect(inlineMath(content)).toEqual([
        'i\\hbar\\frac{\\partial}{\\partial t}|\\psi\\rangle = \\hat{H}|\\psi\\rangle',
        'G_{\\mu\\nu} = \\frac{8\\pi G}{c^4} T_{\\mu\\nu}',
      ]);
    });

    test('nested braces and subscripted products', () => {
      expect(
        inlineMath('Totient: $\\phi(n) = n \\prod_{p|n} \\left(1 - \\frac{1}{p}\\right)$'),
      ).toEqual(['\\phi(n) = n \\prod_{p|n} \\left(1 - \\frac{1}{p}\\right)']);
    });

    test('escaped dollars stay inside the span', () => {
      expect(inlineMath('Calculate $\\text{Total} = \\$500 + \\$200$')).toEqual([
        '\\text{Total} = \\$500 + \\$200',
      ]);
      expect(inlineMath('The formula $f(x) = \\$2x$ represents cost')).toEqual(['f(x) = \\$2x']);
    });

    test('math and prices coexist', () => {
      expect(inlineMath('Formula $x^2$ costs $25')).toEqual(['x^2']);
      expect(inlineMath('LaTeX $x^2$ and price $50')).toEqual(['x^2']);
      expect(inlineMath('Price $100 then equation $x + y = z$ then another price $50')).toEqual([
        'x + y = z',
      ]);
    });

    test('markdown characters inside math never form emphasis', () => {
      const content = 'terms $a_1 + b_2$ and $c_{i}^{*}$ here';
      expect(inlineMath(content)).toEqual(['a_1 + b_2', 'c_{i}^{*}']);
      expect(hasType(parse(content), 'emphasis')).toBe(false);
    });

    test('mhchem passes through unmangled', () => {
      expect(inlineMath('$\\ce{H2O}$ and $\\pu{123 J}$')).toEqual(['\\ce{H2O}', '\\pu{123 J}']);
    });
  });

  describe('structural protection', () => {
    test('inline code is untouchable', () => {
      const content = 'Outside $x^2$ and inside code: `$100`';
      expect(inlineMath(content)).toEqual(['x^2']);
      expect(collect(parse(content), 'inlineCode')).toEqual(['$100']);
    });

    test('a span never swallows an inline code marker', () => {
      const content = 'The error "invalid $lookup namespace" occurs when using `$lookup` operator';
      expect(inlineMath(content)).toEqual([]);
      expect(collect(parse(content), 'inlineCode')).toEqual(['$lookup']);
    });

    test('math and inline code coexist', () => {
      const content = 'Use $x + y$ in math but `$lookup` in code';
      expect(inlineMath(content)).toEqual(['x + y']);
      expect(collect(parse(content), 'inlineCode')).toEqual(['$lookup']);
    });

    test('fenced code is untouchable', () => {
      const content = '```\n$100\n$variable\n```\n\nOutside $x^2$';
      expect(inlineMath(content)).toEqual(['x^2']);
      expect(collect(parse(content), 'code')).toEqual(['$100\n$variable']);
    });
  });

  describe('escapes and line boundaries', () => {
    test('escaped dollars never open a span', () => {
      expect(inlineMath('Already escaped \\$50 and \\$100')).toEqual([]);
      expect(inlineMath('Escaped \\$x^2\\$ should not change')).toEqual([]);
    });

    test('single-dollar spans never cross lines', () => {
      expect(inlineMath('This has $x\ny$ which spans lines')).toEqual([]);
    });

    test('a dangling escape abandons the span', () => {
      expect(inlineMath('dangling $a\\')).toEqual([]);
      expect(inlineMath('dangling $a\\\nnext line$')).toEqual([]);
    });
  });

  describe('unambiguous delimiters are unaffected', () => {
    test('double dollars, inline and flow', () => {
      expect(inlineMath('This is valid: $$x^2 + y^2 = z^2$$')).toEqual(['x^2 + y^2 = z^2']);
      expect(flowMath('$$\nE = mc^2\n$$')).toEqual(['E = mc^2']);
    });

    test('TeX brackets from the llm-math fork', () => {
      expect(inlineMath('This is inline LaTeX: \\(x^2 + y^2 = z^2\\)')).toEqual([
        'x^2 + y^2 = z^2',
      ]);
      const display = parse('\\[\nE = mc^2\n\\]');
      expect([...collect(display, 'math'), ...collect(display, 'inlineMath')]).toEqual([
        'E = mc^2',
      ]);
    });
  });

  describe('documented ambiguity limits', () => {
    test('a trailing dollar-wrapped number still parses (Pandoc parity)', () => {
      expect(inlineMath('Simple Interest: $A = P + Prt = $1,000 and = $1,100$')).toEqual(['1,100']);
    });

    test('unbalanced braces abandon the span', () => {
      expect(inlineMath('weird $a}b$ y')).toEqual([]);
      expect(inlineMath('open $a{b$ y')).toEqual([]);
    });
  });
});

describe('getRemarkPlugins LaTeX wiring', () => {
  /** The config's unified@10 `PluggableList` and react-markdown's unified@11 plugin types are structurally compatible but nominally distinct, as at the production call sites. */
  const renderMarkdown = (content: string, latexParsing: boolean) => {
    const remarkPlugins = getRemarkPlugins(latexParsing) as ReactMarkdownOptions['remarkPlugins'];
    return render(createElement(ReactMarkdown, { remarkPlugins }, content));
  };

  test('currency renders literally through the full plugin chain', () => {
    const { container } = renderMarkdown('from $2bn to at least $4bn per operation', true);
    expect(container.querySelector('.math-inline')).toBeNull();
    expect(container.textContent).toContain('from $2bn to at least $4bn per operation');
  });

  test('single-dollar math renders when enabled', () => {
    const { container } = renderMarkdown('Equation $E=mc^2$ here', true);
    const node = container.querySelector('.math-inline');
    expect(node?.textContent).toBe('E=mc^2');
  });

  test('the toggle gates only single-dollar syntax', () => {
    const single = renderMarkdown('Equation $E=mc^2$ here', false);
    expect(single.container.querySelector('.math-inline')).toBeNull();
    expect(single.container.textContent).toContain('$E=mc^2$');

    const double = renderMarkdown('Equation $$E=mc^2$$ here', false);
    expect(double.container.querySelector('.math-inline')).not.toBeNull();

    const brackets = renderMarkdown('Equation \\(E=mc^2\\) here', false);
    expect(brackets.container.querySelector('.math-inline')).not.toBeNull();
  });

  test('currency alongside citation anchors stays literal', () => {
    const content =
      'The U.S. Treasury said it would at least double long-dated bond buybacks, from $2bn to at least $4bn per operation starting Sept 9. turn0search4 That pushed long-end yields down.';
    const { container } = renderMarkdown(content, true);
    expect(container.querySelector('.math-inline')).toBeNull();
    expect(container.textContent).toContain('from $2bn to at least $4bn per operation');
  });

  test('KaTeX renders the parsed spans without errors', () => {
    const rehypePlugins = getRehypePlugins() as ReactMarkdownOptions['rehypePlugins'];
    const remarkPlugins = getRemarkPlugins(true) as ReactMarkdownOptions['remarkPlugins'];
    const { container } = render(
      createElement(
        ReactMarkdown,
        { remarkPlugins, rehypePlugins },
        'Water is $\\ce{H2O}$ where $E=mc^2$ costs $2bn to at least $4bn.',
      ),
    );
    expect(container.querySelectorAll('.katex')).toHaveLength(2);
    expect(container.querySelector('.katex-error')).toBeNull();
    expect(container.textContent).toContain('costs $2bn to at least $4bn.');
  });

  test('currency and approx-tildes inside GFM table cells stay literal', () => {
    const content = [
      '| Date | Level | What happened |',
      '|---|---|---|',
      '| Aug 19 | ~$64,500 open | Treasury buyback news hits after hours turn0search4 |',
      '| Aug 21 | $77,300, peak $79,455 | White House Clarity Act push |',
    ].join('\n');
    const { container } = renderMarkdown(content, true);
    expect(container.querySelector('.math-inline')).toBeNull();
    expect(container.textContent).toContain('$64,500 open');
    expect(container.textContent).toContain('$77,300, peak $79,455');
  });
});
