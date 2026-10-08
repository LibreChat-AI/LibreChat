import type { IndexDefinition, IndexOptions } from 'mongoose';
import conversationSchema from './convo';
import messageSchema from './message';

type SchemaIndexes = Array<[IndexDefinition, IndexOptions]>;

function hasIndex(indexes: SchemaIndexes, fields: IndexDefinition): boolean {
  return indexes.some(([candidate]) => JSON.stringify(candidate) === JSON.stringify(fields));
}

describe('Insights indexes', () => {
  it('registers the dashboard timeline and user activity indexes', () => {
    expect(
      hasIndex(conversationSchema.indexes(), {
        tenantId: 1,
        isTemporary: 1,
        createdAt: -1,
        _id: -1,
      }),
    ).toBe(true);
    expect(
      hasIndex(messageSchema.indexes(), {
        tenantId: 1,
        isTemporary: 1,
        createdAt: -1,
        _id: -1,
      }),
    ).toBe(true);
    expect(
      hasIndex(messageSchema.indexes(), {
        tenantId: 1,
        isTemporary: 1,
        isCreatedByUser: 1,
        user: 1,
        createdAt: -1,
        _id: -1,
      }),
    ).toBe(true);
    expect(
      hasIndex(conversationSchema.indexes(), {
        tenantId: 1,
        isTemporary: 1,
        initial_agent_id: 1,
        createdAt: -1,
        _id: -1,
      }),
    ).toBe(true);
    expect(
      hasIndex(conversationSchema.indexes(), {
        tenantId: 1,
        isTemporary: 1,
        agent_id: 1,
        createdAt: -1,
        _id: -1,
      }),
    ).toBe(true);
    expect(
      hasIndex(messageSchema.indexes(), {
        tenantId: 1,
        isTemporary: 1,
        isCreatedByUser: 1,
        model: 1,
        createdAt: -1,
        _id: -1,
      }),
    ).toBe(true);
  });
});
