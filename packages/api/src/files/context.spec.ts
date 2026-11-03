import type { TFile } from 'librechat-data-provider';
import { applyTurnDelivery, resolveTurnDeliveryRouting } from '~/agents/files/delivery';
import { getAttachmentTitleText, extractFileContext } from './context';

const file = (filename?: string): TFile => ({ filename }) as TFile;

describe('getAttachmentTitleText', () => {
  it('returns an empty string when there are no files', () => {
    expect(getAttachmentTitleText()).toBe('');
    expect(getAttachmentTitleText(null)).toBe('');
    expect(getAttachmentTitleText([])).toBe('');
  });

  it('lists a single filename', () => {
    expect(getAttachmentTitleText([file('report.pdf')])).toBe('Attached file(s): report.pdf');
  });

  it('lists every filename', () => {
    expect(getAttachmentTitleText([file('a.pdf'), file('b.csv')])).toBe(
      'Attached file(s): a.pdf, b.csv',
    );
  });

  it('skips files that carry no filename', () => {
    expect(getAttachmentTitleText([file(), file('kept.txt')])).toBe('Attached file(s): kept.txt');
  });

  it('returns an empty string when no file has a filename', () => {
    expect(getAttachmentTitleText([file(), file()])).toBe('');
  });
});

describe('a spreadsheet stored as none with its text under automatic reading', () => {
  const xlsx = {
    file_id: 'xlsx',
    filename: 'sales.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    text: 'a,b',
    llmDeliveryPath: 'none' as const,
    metadata: { destinationChosen: false },
  };
  const routing = resolveTurnDeliveryRouting({
    agent: { provider: 'openAI' },
    config: { fileConfig: { endpoints: { openAI: { llmDeliveryPolicy: 'automatic' } } } },
  });
  const extract = (executeCode: boolean) =>
    extractFileContext({
      attachments: applyTurnDelivery([xlsx], {
        routing,
        consumers: { executeCode, fileSearch: false },
      }),
      tokenCountFn: (text: string) => text.length,
    });

  it('puts the text in the prompt on a turn without Run Code', async () => {
    await expect(extract(false)).resolves.toContain('a,b');
  });

  it('leaves the text out on a turn with Run Code', async () => {
    await expect(extract(true)).resolves.toBeUndefined();
  });
});

describe('a spreadsheet stored for Run Code without text', () => {
  const deferred = {
    file_id: 'sheet',
    filename: 'pivot.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: 18_769_510,
    llmDeliveryPath: 'none' as const,
    metadata: { destinationChosen: false, textDerivation: 'deferred' as const },
  };
  const routing = resolveTurnDeliveryRouting({
    agent: { provider: 'openAI' },
    config: { fileConfig: { endpoints: { openAI: { llmDeliveryPolicy: 'automatic' } } } },
  });

  it('names the file and Run Code in the context of a turn without Run Code', async () => {
    const context = await extractFileContext({
      attachments: applyTurnDelivery([deferred], {
        routing,
        consumers: { executeCode: false, fileSearch: false },
      }),
      tokenCountFn: (text: string) => text.length,
    });
    expect(context).toContain('"pivot.xlsx"');
    expect(context).toContain('Run Code');
  });
});
