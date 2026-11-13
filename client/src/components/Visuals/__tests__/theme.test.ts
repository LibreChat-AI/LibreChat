import { readVisualTheme } from '../theme';

describe('readVisualTheme', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => root.remove());

  it('resolves theme triplets into colors the page can use', () => {
    root.style.setProperty('--surface-primary', '255 255 255');
    root.style.setProperty('--text-primary', '13 13 13');
    root.style.setProperty('--border-light', '0 0 0');
    root.style.setProperty('--border-light-alpha', '0.1');
    root.style.setProperty('--series-1', '5 110 189');
    const { appearance, variables } = readVisualTheme(root);
    expect(appearance).toBe('light');
    expect(variables['--background']).toBe('#ffffff');
    expect(variables['--foreground']).toBe('#0d0d0d');
    expect(variables['--border']).toBe('#0000001a');
    expect(variables['--chart-1']).toBe('#056ebd');
  });

  it('takes the page color from the conversation canvas, and muted fills a step away from it', () => {
    root.style.setProperty('--surface-primary', '255 255 255');
    root.style.setProperty('--surface-primary-alt', '247 247 248');
    root.style.setProperty('--surface-tertiary', '236 236 236');
    expect(readVisualTheme(root).variables['--background']).toBe('#f7f7f8');
    root.style.setProperty('--surface-canvas', '31 31 28');
    const { variables } = readVisualTheme(root);
    expect(variables['--background']).toBe('#1f1f1c');
    expect(variables['--muted']).toBe('#ececec');
  });

  it('follows the dark class and falls back for an unset button role', () => {
    root.classList.add('dark');
    root.style.setProperty('--surface-inverted', '255 255 255');
    const { appearance, variables } = readVisualTheme(root);
    expect(appearance).toBe('dark');
    expect(variables['--primary']).toBe('#ffffff');
  });

  it('puts system faces after the theme fonts, which the frame cannot load', () => {
    root.style.setProperty('--theme-font-family', 'Inter, sans-serif');
    const { variables } = readVisualTheme(root);
    expect(variables['--font-sans']).toMatch(/^Inter, system-ui, /);
    expect(variables['--font-mono']).toContain('monospace');
    expect(variables['--radius']).toBe('0.5rem');
  });

  it('gives hex colors that survive a hex alpha suffix', () => {
    root.style.setProperty('--series-2', '233 86 13');
    const color = readVisualTheme(root).variables['--chart-2'];
    expect(color).toBe('#e9560d');
    expect(`${color}66`).toMatch(/^#[0-9a-f]{8}$/);
  });

  it('passes through a role a theme wrote as a full color', () => {
    root.style.setProperty('--series-3', '#00948e');
    expect(readVisualTheme(root).variables['--chart-3']).toBe('#00948e');
  });

  it('omits roles the theme does not define', () => {
    expect(readVisualTheme(root).variables['--chart-8']).toBeUndefined();
  });
});
