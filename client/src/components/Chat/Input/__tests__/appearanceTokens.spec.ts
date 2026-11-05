import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const inputRoot = join(__dirname, '..');
const packageRoot = join(__dirname, '../../../../../../packages/chat/src/components/composer');
/** Composer modules live in `@librechat/chat` once they move; the rest are still app-side. */
const source = (file: string): string => {
  const moved = join(packageRoot, file);
  return readFileSync(existsSync(moved) ? moved : join(inputRoot, file), 'utf8');
};

/** Send and stop take the slot's recipe from IconButton's `submit` variant,
 *  which is built from `composerSubmitClasses()`. */
const submitControls = ['SendButton.tsx', 'StopButton.tsx'] as const;

const themedControls = [
  /** The submit slot's faces share one recipe, which owns the coarse-pointer
   *  tap-target floor as well as the geometry. */
  ['DuringRunSendButton.tsx', ['composerSubmitClasses()']],
  ['TokenUsage/Popover.tsx', ['size-theme-control', 'rounded-theme-control-round']],
  /** The context rail's pills share one recipe built on the composer control classes. */
  ['chip.ts', ['composerControlClasses()']],
  ['CodeApprovalMenu.tsx', ['chipClasses']],
  ['CodeWorkspaceMenu.tsx', ['chipClasses', 'infoChipClasses']],
  /** The dictation mic and its send share the submit slot's corner. */
  ['Composer/Bar.tsx', ['shape="composer"']],
] as const;

describe('Composer appearance tokens', () => {
  it.each(submitControls)('%s composes the shared submit-slot control', (file) => {
    const contents = source(file);

    ['IconButton', 'variant="submit"', 'size="theme"', 'shape="composer"'].forEach((token) =>
      expect(contents).toContain(token),
    );
  });

  it.each(themedControls)('%s uses shared control geometry', (file, expectedTokens) => {
    const contents = source(file);

    expectedTokens.forEach((token) => expect(contents).toContain(token));
  });
});
