import '@testing-library/jest-dom';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import type { ThemeDefinition } from '../theme/types';
import { resolveTheme, validateThemeDefinition, THEME_VERSION } from '../theme/registry';
import { applyResolvedTheme, clearAppliedTheme } from '../theme/utils/applyTheme';
import { Progress } from './Progress';

const indicator = () => screen.getByRole('progressbar').firstElementChild as HTMLElement;

describe('Progress', () => {
  it('reports its value to assistive tech', () => {
    render(<Progress value={38} aria-label="Used" />);
    const bar = screen.getByRole('progressbar', { name: 'Used' });
    expect(bar).toHaveAttribute('aria-valuenow', '38');
    expect(indicator().style.transform).toBe('translateX(-62%)');
  });

  it('fills with the inverted surface by default', () => {
    render(<Progress value={10} />);
    expect(indicator()).toHaveClass('bg-surface-inverted');
  });

  it.each([
    ['warning', 'bg-status-warning'],
    ['error', 'bg-status-error'],
  ] as const)('fills the %s variant from its status token', (variant, token) => {
    render(<Progress value={95} variant={variant} />);
    expect(indicator()).toHaveClass(token);
    expect(indicator()).not.toHaveClass('bg-surface-inverted');
    expect(screen.getByRole('progressbar')).toHaveClass('bg-surface-tertiary');
  });
});

/** AGENTS.md requires a deliberately different reference theme, to prove the
 *  variants follow theme data rather than the bundled LibreChat values. */
const referenceTheme: ThemeDefinition = {
  version: THEME_VERSION,
  name: 'reference',
  modes: {
    light: {
      colors: {
        'rgb-status-warning': '11 22 33',
        'rgb-status-error': '44 55 66',
        'rgb-surface-inverted': '77 88 99',
      },
    },
  },
};

describe('Progress under a reference theme', () => {
  afterEach(() => {
    clearAppliedTheme();
  });

  it('is accepted by the registry and lands on the variables the fills read', () => {
    expect(validateThemeDefinition(referenceTheme)).toEqual([]);
    applyResolvedTheme(resolveTheme(referenceTheme, 'light'));
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--status-warning')).toBe('11 22 33');
    expect(root.style.getPropertyValue('--status-error')).toBe('44 55 66');
    expect(root.style.getPropertyValue('--surface-inverted')).toBe('77 88 99');

    const tokens = readFileSync(join(__dirname, '../theme/tokens.css'), 'utf8');
    expect(tokens).toContain('--color-status-warning: rgb(var(--status-warning));');
    expect(tokens).toContain('--color-status-error: rgb(var(--status-error));');
    expect(tokens).toContain('--color-surface-inverted: rgb(var(--surface-inverted));');
  });

  it('paints no colour of its own', () => {
    applyResolvedTheme(resolveTheme(referenceTheme, 'light'));
    const { container } = render(
      <>
        <Progress value={20} />
        <Progress value={92} variant="warning" />
        <Progress value={100} variant="error" />
      </>,
    );
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(container.innerHTML).not.toMatch(/\brgba?\((?!var\()/);
  });
});
