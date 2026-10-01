import { createAssistantMethods } from '~/methods/assistant';
import assistantSchema from './assistant';

describe('assistantSchema', () => {
  it('indexes tenant-scoped avatar filepath lookups', () => {
    expect(assistantSchema.indexes()).toContainEqual([
      { tenantId: 1, 'avatar.filepath': 1 },
      { background: true },
    ]);
  });

  it('creates schema indexes before the first assistant lookup when auto-indexing is disabled', async () => {
    const createIndexes = jest.fn().mockResolvedValue(undefined);
    const lean = jest.fn().mockResolvedValue(null);
    const findOne = jest.fn().mockReturnValue({ lean });
    const mongoose = {
      models: { Assistant: { modelName: 'Assistant', createIndexes, findOne } },
    } as unknown as typeof import('mongoose');
    const methods = createAssistantMethods(mongoose);

    await methods.getAssistant({ assistantId: 'assistant-id' });
    await methods.getAssistant({ assistantId: 'assistant-id' });

    expect(createIndexes).toHaveBeenCalledTimes(1);
  });
});
