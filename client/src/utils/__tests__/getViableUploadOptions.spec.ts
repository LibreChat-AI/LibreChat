import { Tools, EToolResources } from 'librechat-data-provider';
import type { FileConfig } from 'librechat-data-provider';
import {
  getViableUploadOptions,
  getUploadToolAllowances,
  type UploadOptionContext,
} from '../files';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const POTX = 'application/vnd.openxmlformats-officedocument.presentationml.template';

/** context accepts plain text + csv (text), pdf + xlsx (ocr); nothing else */
const fileConfig = {
  text: { supportedMimeTypes: [/^text\/(plain|csv)$/] },
  ocr: {
    supportedMimeTypes: [
      /^application\/pdf$/,
      /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/,
    ],
  },
  stt: { supportedMimeTypes: [] },
} as unknown as FileConfig;

const baseCtx = (over: Partial<UploadOptionContext> = {}): UploadOptionContext => ({
  provider: 'anthropic',
  endpoint: 'anthropic',
  endpointType: 'anthropic',
  useResponsesApi: false,
  fileSearchEnabled: true,
  codeEnabled: true,
  contextEnabled: true,
  fileSearchAllowedByAgent: true,
  codeAllowedByAgent: true,
  fileConfig,
  ...over,
});

const file = (type: string, name: string) => new File(['x'], name, { type });

describe('getViableUploadOptions', () => {
  it('returns empty for no files', () => {
    expect(getViableUploadOptions([], baseCtx())).toEqual([]);
  });

  it('returns empty when a file type cannot be inferred', () => {
    expect(getViableUploadOptions([file('', 'mystery.unknownext')], baseCtx())).toEqual([]);
  });

  describe('Anthropic (PDF/image only for provider attach)', () => {
    it('routes a spreadsheet to code + text, not the provider', () => {
      expect(getViableUploadOptions([file(XLSX, 'report.xlsx')], baseCtx())).toEqual([
        EToolResources.execute_code,
        EToolResources.context,
      ]);
    });

    it('routes a PowerPoint template to file search and code, not the provider', () => {
      expect(getViableUploadOptions([file(POTX, 'brand-template.potx')], baseCtx())).toEqual([
        EToolResources.file_search,
        EToolResources.execute_code,
      ]);
    });

    it('offers every destination for a PDF', () => {
      expect(getViableUploadOptions([file('application/pdf', 'doc.pdf')], baseCtx())).toEqual([
        undefined,
        EToolResources.file_search,
        EToolResources.execute_code,
        EToolResources.context,
      ]);
    });

    it('yields a single option for a zip (code only) so it can auto-route', () => {
      expect(getViableUploadOptions([file('application/zip', 'a.zip')], baseCtx())).toEqual([
        EToolResources.execute_code,
      ]);
    });

    it('attaches a PDF directly to the provider when capabilities are off', () => {
      const ctx = baseCtx({ fileSearchEnabled: false, codeEnabled: false, contextEnabled: false });
      expect(getViableUploadOptions([file('application/pdf', 'doc.pdf')], ctx)).toEqual([
        undefined,
      ]);
    });

    it('returns nothing for a spreadsheet when no capabilities are enabled', () => {
      const ctx = baseCtx({ fileSearchEnabled: false, codeEnabled: false, contextEnabled: false });
      expect(getViableUploadOptions([file(XLSX, 'report.xlsx')], ctx)).toEqual([]);
    });
  });

  describe('provider-specific direct attachment', () => {
    it('lets Google attach video directly', () => {
      const ctx = baseCtx({
        provider: 'google',
        endpoint: 'google',
        endpointType: 'google',
        fileSearchEnabled: false,
        codeEnabled: false,
        contextEnabled: false,
      });
      expect(getViableUploadOptions([file('video/mp4', 'clip.mp4')], ctx)).toEqual([undefined]);
    });

    it('does not let Anthropic attach video directly', () => {
      const ctx = baseCtx({
        fileSearchEnabled: false,
        codeEnabled: false,
        contextEnabled: false,
      });
      expect(getViableUploadOptions([file('video/mp4', 'clip.mp4')], ctx)).toEqual([]);
    });

    it('lets Bedrock attach a spreadsheet directly via its document allowlist', () => {
      const ctx = baseCtx({
        provider: 'bedrock',
        endpoint: 'bedrock',
        endpointType: 'bedrock',
        fileSearchEnabled: false,
        codeEnabled: false,
        contextEnabled: false,
      });
      expect(getViableUploadOptions([file(XLSX, 'report.xlsx')], ctx)).toEqual([undefined]);
    });

    it('honors a permissive custom endpoint config for direct attach', () => {
      const ctx = baseCtx({
        provider: 'MyGateway',
        endpoint: 'MyGateway',
        endpointType: 'custom',
        fileSearchEnabled: false,
        codeEnabled: false,
        contextEnabled: false,
        endpointSupportedMimeTypes: [/.*/],
      });
      expect(getViableUploadOptions([file(XLSX, 'report.xlsx')], ctx)).toEqual([undefined]);
    });

    it('offers direct attach for a video when the custom config explicitly allows video', () => {
      const ctx = baseCtx({
        provider: 'MyGateway',
        endpoint: 'MyGateway',
        endpointType: 'custom',
        fileSearchEnabled: false,
        codeEnabled: false,
        contextEnabled: false,
        endpointSupportedMimeTypes: [/^image\/.*$/, /^application\/pdf$/, /^video\/.*$/],
      });
      expect(getViableUploadOptions([file('video/mp4', 'clip.mp4')], ctx)).toEqual([undefined]);
      expect(getViableUploadOptions([file('audio/wav', 'tone.wav')], ctx)).toEqual([]);
    });

    it('does not offer video for a custom endpoint that inherits the default config', () => {
      const ctx = baseCtx({
        provider: 'MyGateway',
        endpoint: 'MyGateway',
        endpointType: 'custom',
        fileSearchEnabled: false,
        codeEnabled: false,
        contextEnabled: false,
        endpointSupportedMimeTypes: undefined,
      });
      expect(getViableUploadOptions([file('video/mp4', 'clip.mp4')], ctx)).toEqual([]);
    });

    it('does not treat a non-permissive custom config as broad provider support', () => {
      const ctx = baseCtx({
        provider: 'MyGateway',
        endpoint: 'MyGateway',
        endpointType: 'custom',
        fileSearchEnabled: false,
        codeEnabled: false,
        contextEnabled: false,
        endpointSupportedMimeTypes: [/^application\/pdf$/],
      });
      expect(getViableUploadOptions([file(XLSX, 'report.xlsx')], ctx)).toEqual([]);
    });
  });

  it('drops an option when the agent disallows it', () => {
    const ctx = baseCtx({ contextEnabled: false, fileSearchEnabled: false });
    expect(getViableUploadOptions([file(XLSX, 'report.xlsx')], ctx)).toEqual([
      EToolResources.execute_code,
    ]);
  });
});

describe('getUploadToolAllowances', () => {
  const SAVED = 'agent_abc123';

  it('offers both tool destinations in an ordinary chat, where no agent decides', () => {
    expect(getUploadToolAllowances(null, undefined)).toEqual({
      fileSearchAllowedByAgent: true,
      codeAllowedByAgent: true,
    });
    expect(getUploadToolAllowances(undefined, undefined)).toEqual({
      fileSearchAllowedByAgent: true,
      codeAllowedByAgent: true,
    });
    expect(getUploadToolAllowances('', undefined)).toEqual({
      fileSearchAllowedByAgent: true,
      codeAllowedByAgent: true,
    });
  });

  /* The regression this rule was extracted for: an ephemeral agent carries no
     tool list, and reading one left both destinations hidden for good. */
  it('offers both to an ephemeral agent, which has no tool list to consult', () => {
    expect(getUploadToolAllowances('openAI__gpt-5___GPT-5', undefined)).toEqual({
      fileSearchAllowedByAgent: true,
      codeAllowedByAgent: true,
    });
    expect(getUploadToolAllowances('openAI__gpt-5___GPT-5', [])).toEqual({
      fileSearchAllowedByAgent: true,
      codeAllowedByAgent: true,
    });
  });

  it('lets a saved agent offer only what it was built with', () => {
    expect(getUploadToolAllowances(SAVED, [Tools.file_search])).toEqual({
      fileSearchAllowedByAgent: true,
      codeAllowedByAgent: false,
    });
    expect(getUploadToolAllowances(SAVED, [Tools.execute_code])).toEqual({
      fileSearchAllowedByAgent: false,
      codeAllowedByAgent: true,
    });
    expect(getUploadToolAllowances(SAVED, [Tools.file_search, Tools.execute_code])).toEqual({
      fileSearchAllowedByAgent: true,
      codeAllowedByAgent: true,
    });
  });

  it('offers a saved agent nothing when its tools are absent or empty', () => {
    expect(getUploadToolAllowances(SAVED, undefined)).toEqual({
      fileSearchAllowedByAgent: false,
      codeAllowedByAgent: false,
    });
    expect(getUploadToolAllowances(SAVED, [])).toEqual({
      fileSearchAllowedByAgent: false,
      codeAllowedByAgent: false,
    });
    expect(getUploadToolAllowances(SAVED, ['some_other_tool'])).toEqual({
      fileSearchAllowedByAgent: false,
      codeAllowedByAgent: false,
    });
  });

  it('reads through an indexed agent id, which carries the suffix from a split view', () => {
    expect(getUploadToolAllowances(`${SAVED}____1`, [Tools.execute_code])).toEqual({
      fileSearchAllowedByAgent: false,
      codeAllowedByAgent: true,
    });
  });
});
