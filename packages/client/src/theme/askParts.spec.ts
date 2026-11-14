import postcss from 'postcss';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const parts = postcss.parse(read('./parts.css'));
const app = postcss.parse(read('../../../../client/src/style.css'));
const sharedSelectors = [
  '.tool-status-text',
  '.shimmer',
  '.progress-text-wrapper',
  '.progress-text-content',
  '.progress-text-wrapper button',
  '.disclosure-collapse',
];

describe('ask card stylesheet cascade', () => {
  test('loads the shared stylesheet first without app redefinitions of the moved rules', () => {
    const main = read('../../../../client/src/main.jsx');
    expect(main.indexOf("import '@librechat/client/style.css'")).toBeLessThan(
      main.indexOf("import './style.css'"),
    );
    const selectors: string[] = [];
    app.walkRules((rule) => {
      selectors.push(...rule.selectors);
    });
    for (const selector of sharedSelectors) {
      expect(selectors).not.toContain(selector);
    }
  });

  test('keeps card presentation outside Tailwind layers so later app utilities cannot override it', () => {
    for (const selector of sharedSelectors) {
      const rules = parts.nodes.filter(
        (node) => node.type === 'rule' && node.selectors.includes(selector),
      );
      expect(rules).toHaveLength(1);
    }
    const collapse = parts.nodes.find(
      (node) => node.type === 'rule' && node.selector === '.disclosure-collapse',
    );
    expect(collapse?.toString()).toContain('grid-template-rows: var(--expand-rows, 1fr)');
    expect(collapse?.toString()).toContain('transition: var(--expand-transition)');
  });
});
