import type { IndexDefinition, IndexOptions } from 'mongoose';
import triggerDeliverySchema from './triggerDelivery';

describe('triggerDeliverySchema', () => {
  it('assigns a valid explicit name to the background delivery polling index', () => {
    const indexes = triggerDeliverySchema.indexes() as Array<[IndexDefinition, IndexOptions]>;
    const backgroundPollIndex = indexes.find(
      ([fields]) =>
        fields.user === 1 &&
        fields['envelope.event.source.type'] === 1 &&
        fields['envelope.event.source.id'] === 1 &&
        fields['envelope.target.conversationId'] === 1 &&
        fields.requiredWorkerCapability === 1 &&
        fields.status === 1 &&
        fields.updatedAt === -1 &&
        fields._id === -1,
    );

    expect(backgroundPollIndex).toBeDefined();
    expect(backgroundPollIndex?.[1]).toEqual(
      expect.objectContaining({ name: 'trigger_delivery_background_poll' }),
    );
    expect(backgroundPollIndex?.[1].name?.length).toBeLessThanOrEqual(128);
  });
});
