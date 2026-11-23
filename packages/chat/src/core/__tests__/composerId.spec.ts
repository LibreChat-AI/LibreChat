/** @jest-environment jsdom */
import { mainTextareaId, isComposerTextarea, composerTextareaId } from '../composer';

describe('composer textarea ids', () => {
  it("keeps main chat's id, and gives every other pane's composer one of its own", () => {
    expect(composerTextareaId()).toBe(mainTextareaId);
    expect(composerTextareaId(0)).toBe(mainTextareaId);
    expect(composerTextareaId(3)).toBe(`${mainTextareaId}-3`);
    expect(composerTextareaId(3)).not.toBe(composerTextareaId(1));
  });

  it('knows a composer textarea in whichever pane it is', () => {
    const textarea = (id: string) => Object.assign(document.createElement('textarea'), { id });

    expect(isComposerTextarea(textarea(composerTextareaId(0)))).toBe(true);
    expect(isComposerTextarea(textarea(composerTextareaId(3)))).toBe(true);
    expect(isComposerTextarea(textarea('message-edit'))).toBe(false);
    expect(
      isComposerTextarea(Object.assign(document.createElement('input'), { id: mainTextareaId })),
    ).toBe(false);
    expect(isComposerTextarea(null)).toBe(false);
  });
});
