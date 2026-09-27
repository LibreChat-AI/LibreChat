import { ComponentTypes } from 'librechat-data-provider';
import type { SettingDefinition } from 'librechat-data-provider';
import { countModified, groupParameters, hasControl, isModified, isWideParameter } from '../groups';

const setting = (key: string, over: Partial<SettingDefinition> = {}): SettingDefinition =>
  ({ key, type: 'number', component: 'slider', ...over }) as SettingDefinition;

describe('groupParameters', () => {
  it('files each parameter under the question it answers', () => {
    const sections = groupParameters([
      setting('temperature'),
      setting('promptPrefix'),
      setting('web_search'),
      setting('maxContextTokens'),
    ]);

    expect(sections.map((section) => section.id)).toEqual([
      'identity',
      'sampling',
      'limits',
      'context',
    ]);
  });

  /** The panel is narrow and endpoints differ wildly: a heading for a section this
   *  model has nothing in is a row of nothing. */
  it('leaves out the sections this endpoint has no parameters for', () => {
    const sections = groupParameters([setting('temperature')]);

    expect(sections).toHaveLength(1);
    expect(sections[0].settings.map((s) => s.key)).toEqual(['temperature']);
  });

  /** A deployment can define its own parameters through `customParams`. Filing them
   *  under a guessed heading would misdescribe them; dropping them would hide a
   *  control the operator deliberately added. */
  it('keeps a parameter it has never heard of, in the last section', () => {
    const sections = groupParameters([setting('temperature'), setting('house_style')]);

    expect(sections.at(-1)).toMatchObject({ id: 'other' });
    expect(sections.at(-1)?.settings.map((s) => s.key)).toEqual(['house_style']);
  });

  /** Two narrow controls share a row, so a full-width one in the middle would break
   *  the pair on either side of it. */
  it('packs the narrow parameters before the wide ones', () => {
    const [limits] = groupParameters([
      setting('maxContextTokens', { type: 'number', component: 'input' }),
      setting('stop', { type: 'array', component: 'tags' }),
      setting('fileTokenLimit', { type: 'number', component: 'input' }),
    ]);

    expect(limits.settings.map((s) => s.key)).toEqual([
      'maxContextTokens',
      'fileTokenLimit',
      'stop',
    ]);
  });

  it("keeps the provider's own order inside a section", () => {
    const [sampling] = groupParameters([
      setting('presence_penalty'),
      setting('temperature'),
      setting('top_p'),
    ]);

    expect(sampling.settings.map((s) => s.key)).toEqual([
      'presence_penalty',
      'temperature',
      'top_p',
    ]);
  });

  it('survives a null in the definitions', () => {
    const sections = groupParameters([
      setting('temperature'),
      null as unknown as SettingDefinition,
    ]);

    expect(sections).toHaveLength(1);
  });
});

describe('isModified', () => {
  const temperature = setting('temperature', { default: 1 });

  it('reads an absent value as untouched', () => {
    expect(isModified(temperature, {})).toBe(false);
    expect(isModified(temperature, null)).toBe(false);
  });

  /** The count tells the owner where their changes are, so a value that merely
   *  restates the default is not one. */
  it('reads a value equal to the default as untouched', () => {
    expect(isModified(temperature, { temperature: 1 })).toBe(false);
  });

  it('counts a value that differs', () => {
    expect(isModified(temperature, { temperature: 0.2 })).toBe(true);
  });

  it('treats an empty string and an empty list as nothing said', () => {
    expect(isModified(setting('promptPrefix', { type: 'string' }), { promptPrefix: '' })).toBe(
      false,
    );
    expect(isModified(setting('stop', { type: 'array', default: [] }), { stop: [] })).toBe(false);
  });

  it('compares a list by its contents', () => {
    const stop = setting('stop', { type: 'array', default: [] });

    expect(isModified(stop, { stop: ['###'] })).toBe(true);
  });

  it('counts only what changed', () => {
    const settings = [temperature, setting('top_p', { default: 1 })];

    expect(countModified(settings, { temperature: 0.2, top_p: 1 })).toBe(1);
    expect(countModified(settings, {})).toBe(0);
  });
});

describe('isModified with an operator default', () => {
  /** A deployment can give a text or tags parameter its own default, and clearing it is
   *  a change this conversation made. */
  it('counts clearing a nonempty default as a change', () => {
    expect(isModified(setting('promptPrefix', { default: 'Be brief' }), { promptPrefix: '' })).toBe(
      true,
    );
    expect(isModified(setting('stop', { default: ['END'] }), { stop: [] })).toBe(true);
  });

  it('leaves an empty value untouched when the default is empty too', () => {
    expect(isModified(setting('promptPrefix'), { promptPrefix: '' })).toBe(false);
    expect(isModified(setting('stop', { default: [] }), { stop: [] })).toBe(false);
    expect(isModified(setting('promptPrefix', { default: 'Be brief' }), {})).toBe(false);
  });
});

describe('hasControl', () => {
  it('keeps a choice with options to pick from', () => {
    expect(
      hasControl(setting('region', { component: ComponentTypes.Combobox, options: ['us-east-1'] })),
    ).toBe(true);
    expect(
      hasControl(
        setting('imageDetail', { component: ComponentTypes.Dropdown, options: ['auto', 'low'] }),
      ),
    ).toBe(true);
  });

  /** Bedrock's region lists nothing of its own and takes the deployment's regions, so
   *  with none configured its combobox renders nothing. */
  it('drops a choice with nothing to choose', () => {
    expect(hasControl(setting('region', { component: ComponentTypes.Combobox }))).toBe(false);
    expect(
      hasControl(setting('imageDetail', { component: ComponentTypes.Dropdown, options: [] })),
    ).toBe(false);
  });

  it('keeps every other kind of control', () => {
    expect(hasControl(setting('temperature', { component: ComponentTypes.Slider }))).toBe(true);
  });

  it('leaves no section standing around a dropped control', () => {
    const settings = [
      setting('temperature'),
      setting('region', { component: ComponentTypes.Combobox }),
    ].filter(hasControl);

    expect(groupParameters(settings).map((section) => section.id)).toEqual(['sampling']);
  });
});

describe('isWideParameter', () => {
  /** A system prompt, a name and a stop list are read back as text, and half of a
   *  300px panel is a peephole for any of them. */
  it('gives the whole row to free text', () => {
    expect(
      isWideParameter(setting('promptPrefix', { type: 'string', component: 'textarea' })),
    ).toBe(true);
    expect(isWideParameter(setting('modelLabel', { type: 'string', component: 'input' }))).toBe(
      true,
    );
    expect(isWideParameter(setting('stop', { type: 'array', component: 'tags' }))).toBe(true);
  });

  /** Pairing these is the whole reason the panel fits with nothing collapsed. */
  it('keeps a number, a toggle and a choice in one column', () => {
    expect(
      isWideParameter(setting('maxContextTokens', { type: 'number', component: 'input' })),
    ).toBe(false);
    expect(isWideParameter(setting('resendFiles', { type: 'boolean', component: 'switch' }))).toBe(
      false,
    );
    expect(isWideParameter(setting('temperature', { type: 'number', component: 'slider' }))).toBe(
      false,
    );
    expect(
      isWideParameter(setting('promptCacheTtl', { type: 'string', component: 'combobox' })),
    ).toBe(false);
  });
});
