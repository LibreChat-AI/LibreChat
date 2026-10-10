import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

const composerRoot = join(__dirname, '..');

const collectSourceModules = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const sourcePath = join(directory, entry.name);

    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : collectSourceModules(sourcePath);
    }

    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [sourcePath] : [];
  });

const composerModules = collectSourceModules(composerRoot);

const protectedModules = [
  ...composerModules,
  join(__dirname, '..', '..', 'Reasoning.tsx'),
  join(__dirname, '..', '..', 'EscalateNowButton.tsx'),
  join(__dirname, '..', '..', '..', 'Messages', 'Content', 'Parts', 'PendingSteers.tsx'),
  join(__dirname, '..', '..', '..', '..', '..', 'hooks', 'Input', 'usePaletteEntries.tsx'),
];

describe('composer semantic color guardrail', () => {
  it('keeps the composer seam free of direct palette and raw colors', () => {
    const directPalette =
      /(?:bg|text|border|ring|from|via|to|fill|stroke)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d|white\b|black\b)/;
    const rawColor = /#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\(/i;

    protectedModules.forEach((modulePath) => {
      const source = readFileSync(modulePath, 'utf8');

      expect(source).not.toMatch(directPalette);
      expect(source).not.toMatch(rawColor);
    });
  });
});
