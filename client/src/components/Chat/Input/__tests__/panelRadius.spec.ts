import fs from 'fs';
import path from 'path';

const CHAT_DIR = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['Input', 'Menus', 'Messages', 'BackgroundTasks', 'approval'];
const PACKAGE_COMPONENTS = path.resolve(
  __dirname,
  '../../../../../../packages/client/src/components',
);
const PACKAGE_PANELS = ['SendActions.tsx'];
const SOURCE = /\.tsx$/;
const SKIPPED = /(__tests__|\.spec\.|\.test\.)/;
const PANEL_TAG =
  /<(?:Ariakit\.(?:Menu|Popover|SelectPopover|ComboboxPopover|Hovercard)|Popover\.Content)\b(?:[^\n]*>$|[\s\S]*?\n\s*\/?>)/gm;
const PANEL_CLASS = /className="popover\b[^"]*"/g;
const PANEL_CONSTANT = /const (?:menuClasses|panelClasses|popoverClasses)\b[^;]*;/g;
const PANEL_ROLE = /\brounded-theme-(?:menu-panel|popover)\b/;
const DELEGATED = /className=\{[A-Za-z.]+\}/;

function sourcesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (SKIPPED.test(full)) {
      return [];
    }
    if (entry.isDirectory()) {
      return sourcesUnder(full);
    }
    return SOURCE.test(entry.name) ? [full] : [];
  });
}

describe('composer menu and popover panels', () => {
  const files = [
    ...SCAN_DIRS.flatMap((dir) => sourcesUnder(path.join(CHAT_DIR, dir))),
    ...PACKAGE_PANELS.map((file) => path.join(PACKAGE_COMPONENTS, file)),
  ];

  it('finds the panels the theme roles are meant to cover', () => {
    const panels = files.flatMap((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return [
        ...(text.match(PANEL_TAG) ?? []),
        ...(text.match(PANEL_CONSTANT) ?? []),
        ...(text.match(PANEL_CLASS) ?? []),
      ];
    });
    expect(panels.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files.map((file) => [path.relative(CHAT_DIR, file), file]))(
    '%s names a theme radius role on every panel that styles its own corners',
    (_name, file) => {
      const text = fs.readFileSync(file, 'utf8');
      const strays = [
        ...(text.match(PANEL_TAG) ?? []),
        ...(text.match(PANEL_CONSTANT) ?? []),
        ...(text.match(PANEL_CLASS) ?? []),
      ]
        .filter((panel) => !PANEL_ROLE.test(panel) && !DELEGATED.test(panel))
        .map((panel) => panel.slice(0, 80));
      expect(strays).toEqual([]);
    },
  );
});
