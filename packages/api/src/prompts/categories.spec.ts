import { defaultPromptCategories } from 'librechat-data-provider';
import type { TPromptsConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import {
  resolvePromptCategories,
  getPromptCategoriesStartupConfig,
  createGetPromptCategoriesHandler,
} from './categories';

const cfg = (categories: NonNullable<TPromptsConfig>['categories']): TPromptsConfig => ({
  categories,
});

describe('resolvePromptCategories', () => {
  it('returns exactly the defaults when unconfigured', () => {
    expect(resolvePromptCategories(undefined, [])).toEqual(defaultPromptCategories);
    expect(resolvePromptCategories({}, ['x'])).toEqual(defaultPromptCategories);
    expect(resolvePromptCategories(undefined, [])[0]).not.toBe(defaultPromptCategories[0]);
  });

  it('replaces defaults with the configured list, labels falling back to value', () => {
    const result = resolvePromptCategories(
      cfg({
        enableDefaultCategories: false,
        list: [
          { value: 'hr' },
          { value: 'legal', label: 'Legal', color: 'series-1' },
          { value: 'ops' },
        ],
      }),
      [],
    );
    expect(result).toEqual([
      { value: 'hr', label: 'hr' },
      { value: 'legal', label: 'Legal', color: 'series-1' },
      { value: 'ops', label: 'ops' },
    ]);
  });

  it('overrides a built-in in place and appends new entries', () => {
    const result = resolvePromptCategories(
      cfg({ list: [{ value: 'code', label: 'Engineering' }, { value: 'hr' }] }),
      [],
    );
    expect(result).toHaveLength(10);
    expect(result[5]).toEqual({ value: 'code', label: 'Engineering' });
    expect(result[9]).toEqual({ value: 'hr', label: 'hr' });
  });

  it('matches built-ins case-insensitively and keeps the built-in value', () => {
    const result = resolvePromptCategories(cfg({ list: [{ value: ' CODE ', icon: 'box' }] }), []);
    expect(result).toHaveLength(9);
    expect(result[5]).toMatchObject({ value: 'code', label: 'com_ui_code', icon: 'box' });
  });

  it('returns nothing when defaults are off and the list is empty', () => {
    expect(resolvePromptCategories(cfg({ enableDefaultCategories: false, list: [] }), [])).toEqual(
      [],
    );
  });

  it('keeps a built-in-valued entry when defaults are off', () => {
    expect(
      resolvePromptCategories(
        cfg({ enableDefaultCategories: false, list: [{ value: 'code' }] }),
        [],
      ),
    ).toEqual([{ value: 'code', label: 'code' }]);
  });

  it('appends custom values after configured ones, deduping by exact value', () => {
    const result = resolvePromptCategories(
      cfg({ allowCustom: true, enableDefaultCategories: false, list: [{ value: 'hr' }] }),
      ['hr', 'alpha', 'Alpha', 'beta', 'beta'],
    );
    expect(result).toEqual([
      { value: 'hr', label: 'hr' },
      { value: 'alpha', label: 'alpha', custom: true },
      { value: 'Alpha', label: 'Alpha', custom: true },
      { value: 'beta', label: 'beta', custom: true },
    ]);
  });

  it('keeps a stored value that only matches a configured label', () => {
    const result = resolvePromptCategories(
      cfg({
        allowCustom: true,
        enableDefaultCategories: false,
        list: [{ value: 'hr', label: 'People' }],
      }),
      ['People'],
    );
    expect(result).toEqual([
      { value: 'hr', label: 'People' },
      { value: 'People', label: 'People', custom: true },
    ]);
  });

  it('trims configured values and labels', () => {
    const result = resolvePromptCategories(
      cfg({ enableDefaultCategories: false, list: [{ value: ' hr ', label: ' People ' }] }),
      [],
    );
    expect(result).toEqual([{ value: 'hr', label: 'People' }]);
  });

  it('ignores custom values unless allowCustom is true', () => {
    expect(resolvePromptCategories(cfg({ allowCustom: false }), ['alpha'])).toEqual(
      defaultPromptCategories,
    );
  });
});

describe('createGetPromptCategoriesHandler', () => {
  const makeRes = () => {
    const res = { status: jest.fn(), send: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  };
  const makeReq = (prompts?: TPromptsConfig) =>
    ({ config: { prompts }, user: { id: 'u1', role: 'USER' } }) as unknown as ServerRequest;

  it('makes no reads when custom categories are off', async () => {
    const getPromptGroupAccessContext = jest.fn();
    const getDistinctPromptGroupCategories = jest.fn();
    const res = makeRes();
    await createGetPromptCategoriesHandler({
      getPromptGroupAccessContext,
      getDistinctPromptGroupCategories,
    })(makeReq(), res as unknown as Response);
    expect(getPromptGroupAccessContext).not.toHaveBeenCalled();
    expect(getDistinctPromptGroupCategories).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(defaultPromptCategories);
  });

  it('reads context then distinct categories once each when custom is on', async () => {
    const getPromptGroupAccessContext = jest.fn().mockResolvedValue({ accessibleIds: ['a', 'b'] });
    const getDistinctPromptGroupCategories = jest.fn().mockResolvedValue(['alpha']);
    const res = makeRes();
    await createGetPromptCategoriesHandler({
      getPromptGroupAccessContext,
      getDistinctPromptGroupCategories,
    })(
      makeReq({ categories: { allowCustom: true, enableDefaultCategories: false } }),
      res as unknown as Response,
    );
    expect(getPromptGroupAccessContext).toHaveBeenCalledTimes(1);
    expect(getPromptGroupAccessContext).toHaveBeenCalledWith({ userId: 'u1', role: 'USER' });
    expect(getDistinctPromptGroupCategories).toHaveBeenCalledTimes(1);
    expect(getDistinctPromptGroupCategories).toHaveBeenCalledWith(['a', 'b']);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith([{ value: 'alpha', label: 'alpha', custom: true }]);
  });

  it('responds 500 with a fixed message and no error text', async () => {
    const getPromptGroupAccessContext = jest.fn().mockRejectedValue(new Error('secret db text'));
    const res = makeRes();
    await createGetPromptCategoriesHandler({
      getPromptGroupAccessContext,
      getDistinctPromptGroupCategories: jest.fn(),
    })(makeReq({ categories: { allowCustom: true } }), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith({ message: 'Failed to retrieve categories' });
  });
});

describe('getPromptCategoriesStartupConfig', () => {
  it('is false when unset', () => {
    expect(getPromptCategoriesStartupConfig(undefined)).toEqual({ allowCustom: false });
    expect(getPromptCategoriesStartupConfig({ prompts: { categories: {} } })).toEqual({
      allowCustom: false,
    });
  });

  it('is true when allowCustom is set', () => {
    expect(
      getPromptCategoriesStartupConfig({ prompts: { categories: { allowCustom: true } } }),
    ).toEqual({ allowCustom: true });
  });
});
