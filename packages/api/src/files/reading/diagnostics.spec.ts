import { logger } from '@librechat/data-schemas';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { TFileConfig, TurnFileConsumers } from 'librechat-data-provider';
import type { FileTextDeriver, TurnReadingFile } from './turn';
import { resolveTurnDeliveryRouting } from '~/agents/files/delivery';
import { logTurnReading, logAllocation } from './diagnostics';
import { buildTurnReadingContext } from './turn';

type EndpointFileConfigInput = NonNullable<TFileConfig['endpoints']>[string];

const searchOnly: TurnFileConsumers = { executeCode: false, fileSearch: true };

const attachment = (
  overrides: Partial<TurnReadingFile> & Pick<TurnReadingFile, 'file_id'>,
): TurnReadingFile => ({
  type: 'application/pdf',
  bytes: 1024,
  filename: 'quarterly-report.pdf',
  source: FileSources.local,
  context: FileContext.message_attachment,
  llmDeliveryPath: 'provider',
  metadata: { destinationChosen: false },
  ...overrides,
});

const deriveText: FileTextDeriver = async () => ({ status: 'skipped', reason: 'policy' });

function agentFor(endpointConfig: EndpointFileConfigInput, withContext = true) {
  const deliveryRouting = resolveTurnDeliveryRouting({
    agent: { provider: 'openAI', endpoint: 'openAI' },
    config: { fileConfig: { endpoints: { openAI: endpointConfig } } },
  });
  const context = withContext
    ? buildTurnReadingContext({
        routing: deliveryRouting,
        provider: 'openAI',
        fileTokenLimit: 100_000,
        configuredFileSizeLimit: 1024,
        countTokens: (text) => text.length,
        deriveText,
      })
    : undefined;
  if (context != null) {
    deliveryRouting.reading = context;
  }
  return {
    agent: {
      id: 'agent_1',
      deliveryRouting,
      fileConsumers: searchOnly,
      currentRequestAttachments: [
        attachment({ file_id: 'fits' }),
        attachment({ file_id: 'large', bytes: 4096 }),
      ],
    },
    context,
  };
}

describe('reading diagnostics', () => {
  let info: jest.SpyInstance;
  let debug: jest.SpyInstance;

  beforeEach(() => {
    info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    debug = jest.spyOn(logger, 'debug').mockImplementation(() => logger);
  });

  afterEach(() => {
    info.mockRestore();
    debug.mockRestore();
  });

  it('logs a summary and one line per file under the automatic policy, without filenames', () => {
    const { agent, context } = agentFor({ llmDeliveryPolicy: 'automatic' });
    context?.recordDropped([attachment({ file_id: 'dropped' })]);

    logTurnReading(agent, 'init');

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      '[fileReading] agent=agent_1 policy=automatic pass=init files=2 provider=1 text=0 search=1 code=0 unavailable=0 overflow=0 derived=0 rejected=0 dropped=1',
    );
    expect(debug.mock.calls.map(([line]) => line)).toEqual([
      '[fileReading] file_id=fits category=document reader=provider path=provider classic=provider reason=native_supported skipped=none code=no_run_code',
      '[fileReading] file_id=large category=document reader=search path=none classic=provider reason=native_capacity skipped=provider:native_capacity code=no_run_code',
    ]);
    const lines = [...info.mock.calls, ...debug.mock.calls].map(([line]) => String(line));
    expect(lines.some((line) => line.includes('quarterly-report'))).toBe(false);
  });

  it.each([
    ['without a reading context', { llmDeliveryPolicy: 'automatic' as const }, false],
    ['under the classic policy with a derive-only context', {}, true],
  ])('stays silent %s', (_label, endpointConfig, withContext) => {
    const { agent } = agentFor(endpointConfig, withContext);

    logTurnReading(agent, 'final');

    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('stays silent for a turn with nothing to report', () => {
    const { agent } = agentFor({ llmDeliveryPolicy: 'automatic' });

    logTurnReading({ ...agent, currentRequestAttachments: [] }, 'run');

    expect(info).not.toHaveBeenCalled();
  });

  it('logs an allocation at debug', () => {
    logAllocation({ agentId: 'agent_1', scope: 'history', candidates: 4, overflow: 1 });

    expect(debug).toHaveBeenCalledWith(
      '[allocation] agent=agent_1 scope=history candidates=4 overflow=1',
    );
    expect(info).not.toHaveBeenCalled();
  });
});
