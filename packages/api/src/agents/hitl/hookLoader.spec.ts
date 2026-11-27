import { logger } from '@librechat/data-schemas';
import { getRegisteredToolApprovalHookCount, clearToolApprovalHooks } from './hooks';
import { loadToolApprovalHooks } from './hookLoader';

/** A conforming hook module: (options) => (context) => (input) => decision. */
const goodModule = (options?: Record<string, unknown>) => () => async () => ({
  decision: (options?.decision as 'ask') ?? 'ask',
});

describe('loadToolApprovalHooks', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    jest.spyOn(logger, 'info').mockImplementation(() => logger);
  });

  afterEach(() => {
    clearToolApprovalHooks();
    jest.restoreAllMocks();
  });

  test('registers a hook from a module default export', async () => {
    const importModule = jest.fn(async () => ({ default: goodModule }));
    const n = await loadToolApprovalHooks([{ module: './hook.js', matcher: 'write_.*' }], {
      importModule,
    });
    expect(n).toBe(1);
    expect(getRegisteredToolApprovalHookCount()).toBe(1);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  test('supports a module that IS the builder (no default export)', async () => {
    const importModule = jest.fn(async () => goodModule);
    expect(await loadToolApprovalHooks([{ module: 'some-pkg' }], { importModule })).toBe(1);
  });

  test('passes the entry options to the builder', async () => {
    const builder = jest.fn(goodModule);
    const importModule = jest.fn(async () => ({ default: builder }));
    await loadToolApprovalHooks([{ module: './h.js', options: { foo: 'bar' } }], { importModule });
    expect(builder).toHaveBeenCalledWith({ foo: 'bar' });
  });

  test('returns 0 for empty / undefined config and registers nothing', async () => {
    expect(await loadToolApprovalHooks(undefined)).toBe(0);
    expect(await loadToolApprovalHooks([])).toBe(0);
    expect(getRegisteredToolApprovalHookCount()).toBe(0);
  });

  test('skips a module whose export is not a function (no crash)', async () => {
    const importModule = jest.fn(async () => ({ default: { notAFunction: true } }));
    expect(await loadToolApprovalHooks([{ module: './bad.js' }], { importModule })).toBe(0);
    expect(getRegisteredToolApprovalHookCount()).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  test('skips when the builder returns a non-function', async () => {
    const importModule = jest.fn(async () => ({ default: () => 'not a factory' }));
    expect(await loadToolApprovalHooks([{ module: './bad.js' }], { importModule })).toBe(0);
  });

  test('resolves (does not throw) when a module import fails', async () => {
    const importModule = jest.fn(async () => {
      throw new Error('cannot find module');
    });
    await expect(
      loadToolApprovalHooks([{ module: './missing.js' }], { importModule }),
    ).resolves.toBe(0);
    expect(getRegisteredToolApprovalHookCount()).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  test('continues past a bad entry to load the good ones', async () => {
    const importModule = jest.fn(async (spec: string) =>
      spec.includes('bad') ? Promise.reject(new Error('nope')) : { default: goodModule },
    );
    const n = await loadToolApprovalHooks([{ module: './bad.js' }, { module: './good.js' }], {
      importModule,
    });
    expect(n).toBe(1);
    expect(getRegisteredToolApprovalHookCount()).toBe(1);
  });

  test('reload unregisters the previous batch (idempotent, no double-register)', async () => {
    const importModule = jest.fn(async () => ({ default: goodModule }));
    await loadToolApprovalHooks([{ module: './a.js' }, { module: './b.js' }], { importModule });
    expect(getRegisteredToolApprovalHookCount()).toBe(2);

    // A reload with a single hook must drop the previous two.
    await loadToolApprovalHooks([{ module: './a.js' }], { importModule });
    expect(getRegisteredToolApprovalHookCount()).toBe(1);
  });

  test('unwraps a nested default (CJS/transpiled `exports.default = fn` interop)', async () => {
    // import() of TS/Babel CJS output surfaces as { default: { default: builder } }.
    const importModule = jest.fn(async () => ({ default: { default: goodModule } }));
    expect(await loadToolApprovalHooks([{ module: './cjs.js' }], { importModule })).toBe(1);
    expect(getRegisteredToolApprovalHookCount()).toBe(1);
  });

  test('skips an entry with an invalid matcher regex (does not register a throwing pattern)', async () => {
    const importModule = jest.fn(async () => ({ default: goodModule }));
    expect(
      await loadToolApprovalHooks([{ module: './h.js', matcher: '[' }], { importModule }),
    ).toBe(0);
    expect(getRegisteredToolApprovalHookCount()).toBe(0);
    expect(importModule).not.toHaveBeenCalled(); // rejected before import
    expect(logger.error).toHaveBeenCalled();
  });

  test('loads valid hooks even when a sibling entry has a bad matcher', async () => {
    const importModule = jest.fn(async () => ({ default: goodModule }));
    const n = await loadToolApprovalHooks(
      [
        { module: './bad.js', matcher: '(' },
        { module: './good.js', matcher: 'write_.*' },
      ],
      { importModule },
    );
    expect(n).toBe(1);
  });

  describe('module specifier resolution', () => {
    test('resolves an app-root-relative FILE without a leading dot to a file:// URL', async () => {
      const importModule = jest.fn(async () => ({ default: goodModule }));
      // `hookLoader.ts` exists next to this spec — a bare-looking path that is a real file.
      await loadToolApprovalHooks([{ module: 'hookLoader.ts' }], {
        importModule,
        basePath: __dirname,
      });
      expect(importModule).toHaveBeenCalledWith(
        expect.stringMatching(/^file:\/\/.*hookLoader\.ts$/),
      );
    });

    test('leaves a bare package specifier untouched when no such file exists', async () => {
      const importModule = jest.fn(async () => ({ default: goodModule }));
      await loadToolApprovalHooks([{ module: 'some-approval-hooks-pkg' }], {
        importModule,
        basePath: __dirname,
      });
      expect(importModule).toHaveBeenCalledWith('some-approval-hooks-pkg');
    });

    test('resolves a ./ relative path to a file:// URL', async () => {
      const importModule = jest.fn(async () => ({ default: goodModule }));
      await loadToolApprovalHooks([{ module: './hooks/x.js' }], {
        importModule,
        basePath: '/srv/app',
      });
      expect(importModule).toHaveBeenCalledWith('file:///srv/app/hooks/x.js');
    });
  });
});
