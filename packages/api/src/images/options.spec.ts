import type { TImageSpec } from 'librechat-data-provider';
import {
  bindImageChoice,
  applyImageChoice,
  imageToolSchema,
  imageToolSchemasFor,
  resolveImageChoice,
} from './options';
import { geminiToolkit } from '~/tools/toolkits/gemini';
import { oaiToolkit } from '~/tools/toolkits/oai';

const gen = oaiToolkit.image_gen_oai;
const edit = oaiToolkit.image_edit_oai;
const gemini = geminiToolkit.gemini_image_gen;

const hd: TImageSpec = {
  name: 'gpt-image-2-hd',
  label: 'GPT Image 2 · HD',
  model: 'gpt-image-2-h',
  protocol: 'openai',
  options: { sizes: ['1024x1024', '1536x1024', '3840x2160'] },
};
const fixed: TImageSpec = {
  name: 'gpt-image',
  label: 'GPT Image',
  model: 'gpt-image-2',
  protocol: 'openai',
  default: true,
  options: {},
};
const legacy: TImageSpec = {
  name: 'legacy',
  label: 'Legacy',
  model: 'gpt-image-1',
  protocol: 'openai',
};
const lite: TImageSpec = {
  name: 'gemini-lite',
  label: 'Gemini Lite',
  model: 'gemini-3.1-flash-lite-image',
  protocol: 'gemini',
  options: { aspectRatios: ['1:1', '16:9', '1:4'] },
};
const list = [fixed, hd, legacy, lite];

describe('resolveImageChoice', () => {
  it('keeps only values the entry offers', () => {
    expect(resolveImageChoice(hd, { size: '1536x1024', aspectRatio: '16:9' })).toEqual({
      size: '1536x1024',
    });
    expect(resolveImageChoice(hd, { size: '999x999' })).toBeUndefined();
  });

  it('ignores a choice for an entry without options, or a malformed one', () => {
    expect(resolveImageChoice(legacy, { size: '1024x1024' })).toBeUndefined();
    expect(resolveImageChoice(hd, 'big')).toBeUndefined();
    expect(resolveImageChoice(undefined, { size: '1024x1024' })).toBeUndefined();
  });
});

describe('imageToolSchema', () => {
  it('narrows size to auto plus the listed sizes and drops unhonoured arguments', () => {
    const schema = imageToolSchema(gen.name, gen.schema, hd, undefined);
    expect(schema.properties?.size?.enum).toEqual(['auto', '1024x1024', '1536x1024', '3840x2160']);
    expect(schema.properties?.size?.pattern).toBeUndefined();
    expect(schema.properties?.quality).toBeUndefined();
    expect(schema.properties?.background).toBeUndefined();
    expect(schema.properties?.prompt).toEqual(gen.schema.properties?.prompt);
    expect(schema.required).toEqual(['prompt']);
  });

  it('offers no parameters for a model that honours none', () => {
    const schema = imageToolSchema(gen.name, gen.schema, fixed, undefined);
    expect(Object.keys(schema.properties ?? {})).toEqual(['prompt']);
    const editSchema = imageToolSchema(edit.name, edit.schema, fixed, undefined);
    expect(Object.keys(editSchema.properties ?? {}).sort()).toEqual(['image_ids', 'prompt']);
  });

  it('keeps the generic schema for an entry that declares no options', () => {
    expect(imageToolSchema(gen.name, gen.schema, legacy, undefined)).toEqual(gen.schema);
  });

  it('removes a pinned field so the chat model cannot argue with it', () => {
    const schema = imageToolSchema(gen.name, gen.schema, hd, { size: '1536x1024' });
    expect(schema.properties?.size).toBeUndefined();
    const pinnedLegacy = imageToolSchema(gen.name, gen.schema, legacy, { size: '1024x1024' });
    expect(pinnedLegacy.properties?.size).toBeUndefined();
    expect(pinnedLegacy.properties?.quality).toBeDefined();
  });

  it('narrows the Gemini ratios and drops resolution when none is listed', () => {
    const schema = imageToolSchema(gemini.name, gemini.schema, lite, undefined);
    expect(schema.properties?.aspectRatio?.enum).toEqual(['1:1', '16:9', '1:4']);
    expect(schema.properties?.imageSize).toBeUndefined();
  });

  it('does not mutate the shared toolkit schema', () => {
    const before = JSON.stringify(gen.schema);
    imageToolSchema(gen.name, gen.schema, fixed, { size: '1024x1024' });
    expect(JSON.stringify(gen.schema)).toBe(before);
  });
});

describe('applyImageChoice', () => {
  it('lets a pinned value override the chat model', () => {
    expect(
      applyImageChoice(gen.name, { prompt: 'p', size: '1024x1024' }, hd, { size: '3840x2160' }),
    ).toEqual({ prompt: 'p', size: '3840x2160' });
  });

  it('drops values the model would ignore or reject', () => {
    expect(
      applyImageChoice(
        gen.name,
        { prompt: 'p', size: '2048x1152', quality: 'high', background: 'transparent' },
        hd,
        undefined,
      ),
    ).toEqual({ prompt: 'p' });
    expect(applyImageChoice(gen.name, { prompt: 'p', size: 'auto' }, hd, undefined)).toEqual({
      prompt: 'p',
      size: 'auto',
    });
    expect(
      applyImageChoice(gemini.name, { prompt: 'p', aspectRatio: '21:9', imageSize: '4K' }, lite, {
        aspectRatio: '1:4',
      }),
    ).toEqual({ prompt: 'p', aspectRatio: '1:4' });
  });

  it('passes arguments through untouched for an entry without options', () => {
    const args = { prompt: 'p', size: '1536x1024', quality: 'high' };
    expect(applyImageChoice(gen.name, args, legacy, undefined)).toEqual(args);
  });
});

describe('imageToolSchemasFor', () => {
  it('narrows both halves of the OpenAI toolkit for the selected entry', () => {
    const schemas = imageToolSchemasFor(
      { image_gen: 'gpt-image-2-hd', image_options: { size: '1536x1024' } },
      list,
    );
    expect(Object.keys(schemas).sort()).toEqual([edit.name, gen.name].sort());
    expect(schemas[gen.name].properties?.size).toBeUndefined();
  });

  it('uses the default entry for `true` and the Gemini tool for a Gemini entry', () => {
    expect(Object.keys(imageToolSchemasFor({ image_gen: true }, list))).toContain(gen.name);
    expect(Object.keys(imageToolSchemasFor({ image_gen: 'gemini-lite' }, list))).toEqual([
      gemini.name,
    ]);
  });

  it('is empty without an Image Gen selection or an image list', () => {
    expect(imageToolSchemasFor(undefined, list)).toEqual({});
    expect(imageToolSchemasFor({ image_gen: false }, list)).toEqual({});
    expect(imageToolSchemasFor({ image_gen: true }, undefined)).toEqual({});
  });
});

describe('bindImageChoice', () => {
  it('rewrites the arguments the tool function receives', async () => {
    const func = jest.fn(async (args: Record<string, unknown>) => args);
    const imageTool = bindImageChoice({ name: gen.name, func }, hd, { size: '1536x1024' });

    await imageTool.func({ prompt: 'p', size: '1024x1024', quality: 'high' });

    expect(func).toHaveBeenCalledWith({ prompt: 'p', size: '1536x1024' });
  });
});
