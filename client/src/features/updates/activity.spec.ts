import {
  canLeave,
  hasBlockingWork,
  hasRegisteredReloadGuard,
  holdReloadForUpload,
  registerReloadGuard,
} from './activity';

describe('reload safety registrations', () => {
  it('holds reload during queued uploads and releases each batch exactly once', () => {
    const releaseA = holdReloadForUpload();
    const releaseB = holdReloadForUpload();
    expect(hasBlockingWork()).toBe(true);
    releaseA();
    releaseA();
    expect(hasBlockingWork()).toBe(true);
    releaseB();
    expect(hasBlockingWork()).toBe(false);
  });

  it('defers a typed draft, open workflow, and active generation', () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    expect(canLeave(false)).toBe(true);
    textarea.value = 'unsaved draft';
    expect(canLeave(false)).toBe(false);
    textarea.value = '';
    expect(canLeave(true)).toBe(false);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    expect(canLeave(false)).toBe(false);
    dialog.remove();
    textarea.remove();
  });

  it('checks current feature state and fails closed if a guard throws', () => {
    let active = false;
    const unregister = registerReloadGuard(() => active);
    expect(hasBlockingWork()).toBe(false);
    expect(hasRegisteredReloadGuard()).toBe(true);
    active = true;
    expect(hasBlockingWork()).toBe(true);
    unregister();
    const removeThrowing = registerReloadGuard(() => {
      throw new Error('not ready');
    });
    expect(hasBlockingWork()).toBe(true);
    removeThrowing();
    expect(hasBlockingWork()).toBe(false);
  });
});
