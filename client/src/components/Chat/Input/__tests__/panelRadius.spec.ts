import fs from 'fs';
import path from 'path';

const CHAT_DIR = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['Input', 'Menus'];
const SOURCE = /\.tsx$/;
const SKIPPED = /(__tests__|\.spec\.|\.test\.)/;
const PANEL_TAG =
  /<(?:Ariakit\.(?:Menu|Popover|SelectPopover|ComboboxPopover)|Popover\.Content|HoverCardContent|DropdownMenuContent)\b(?:=>|[^>])*>/g;
const PANEL_CONSTANT = /const (?:menuClasses|panelClasses|popoverClasses)\b[^;]*;/g;
const SCALE_STEP = /\brounded-(?:md|lg|xl|2xl|3xl)\b/;

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
  const files = SCAN_DIRS.flatMap((dir) => sourcesUnder(path.join(CHAT_DIR, dir)));

  it('finds the panels the theme roles are meant to cover', () => {
    const panels = files.flatMap((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return [...(text.match(PANEL_TAG) ?? []), ...(text.match(PANEL_CONSTANT) ?? [])];
    });
    expect(panels.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files.map((file) => [path.relative(CHAT_DIR, file), file]))(
    '%s corners its panels with a theme role, not a scale step',
    (_name, file) => {
      const text = fs.readFileSync(file, 'utf8');
      const strays = [...(text.match(PANEL_TAG) ?? []), ...(text.match(PANEL_CONSTANT) ?? [])]
        .filter((panel) => SCALE_STEP.test(panel))
        .map((panel) => panel.slice(0, 80));
      expect(strays).toEqual([]);
    },
  );
});
