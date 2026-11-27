import type { ExtendedFile } from '@librechat/chat';
import { stagedForHandoff } from '../handoff';

const file = (file_id: string, progress: number): ExtendedFile =>
  ({ file_id, progress }) as ExtendedFile;

describe('stagedForHandoff', () => {
  it('takes the files whose upload has finished, and leaves one still on its way', () => {
    const staged = new Map([
      ['done', file('done', 1)],
      ['uploading', file('uploading', 0.4)],
      ['also-done', file('also-done', 1)],
    ]);

    expect([...stagedForHandoff(staged).keys()]).toEqual(['done', 'also-done']);
    /** The composer's own map is not changed by asking. */
    expect(staged.size).toBe(3);
  });

  it('takes nothing from a composer with nothing staged', () => {
    expect(stagedForHandoff(new Map()).size).toBe(0);
  });
});
