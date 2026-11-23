import mongoose from 'mongoose';
import agentSchema from './agent';

const Agent = mongoose.models.SdkBindingAgent ?? mongoose.model('SdkBindingAgent', agentSchema);
const base = {
  id: 'agent_saved',
  provider: 'openAI',
  model: 'fixture',
  author: new mongoose.Types.ObjectId(),
};

describe('SDK runtime binding storage', () => {
  it('retains the binding without adding a nested identity', () => {
    const binding = { id: 'advisor', protocolVersion: 1 };
    const doc = new Agent({ ...base, sdk_runtime: binding });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.toObject().sdk_runtime).toEqual(binding);
  });
  it('rejects incomplete and incompatible bindings', () => {
    for (const binding of [{ id: 'advisor' }, { id: 'advisor', protocolVersion: 2 }]) {
      expect(new Agent({ ...base, sdk_runtime: binding }).validateSync()).toBeDefined();
    }
  });
  it('preserves the native default and explicit removal', () => {
    expect(new Agent(base).toObject().sdk_runtime).toBeUndefined();
    expect(new Agent({ ...base, sdk_runtime: null }).toObject().sdk_runtime).toBeNull();
  });
});
