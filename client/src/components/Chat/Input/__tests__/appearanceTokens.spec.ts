import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const inputRoot = join(__dirname, '..');
const source = (file: string): string => readFileSync(join(inputRoot, file), 'utf8');

/** Send and stop take the slot's recipe from IconButton's `submit` variant,
 *  which is built from `composerSubmitClasses()`. */
const submitControls = ['SendButton.tsx', 'StopButton.tsx'] as const;

const themedControls = [
  /** The submit slot's faces share one recipe, which owns the coarse-pointer
   *  tap-target floor as well as the geometry. */
  ['DuringRunSendButton.tsx', ['composerSubmitClasses()']],
  ['InterruptSteerButton.tsx', ['size-theme-control', 'rounded-theme-control-round']],
  ['TokenUsage/index.tsx', ['size-theme-control', 'rounded-theme-control-round']],
  ['Files/AttachFile.tsx', ['size-theme-control', 'rounded-theme-control-round']],
  ['CodeApprovalMenu.tsx', ['composerControlClasses()', 'md:px-theme-normal']],
] as const;

describe('Composer appearance tokens', () => {
  it.each(submitControls)('%s composes the shared submit-slot control', (file) => {
    const contents = source(file);

    ['IconButton', 'variant="submit"', 'size="theme"', 'shape="theme"'].forEach((token) =>
      expect(contents).toContain(token),
    );
  });

  it.each(themedControls)('%s uses shared control geometry', (file, expectedTokens) => {
    const contents = source(file);

    expectedTokens.forEach((token) => expect(contents).toContain(token));
  });
});
