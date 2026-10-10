import { Schema, model, deleteModel } from 'mongoose';
import { conversationPreset } from './defaults';

describe('conversation checkout persistence', () => {
  const Checkout = model(
    'CheckoutPersistenceTest',
    new Schema({ codeWorkspaces: conversationPreset.codeWorkspaces }),
  );

  afterAll(() => deleteModel('CheckoutPersistenceTest'));

  it.each(['source', 'isolated'] as const)(
    'round trips the %s checkout through the real schema',
    (checkout) => {
      const selection = { environmentId: 'machine', workspaceId: 'repo', checkout };
      const saved = new Checkout({ codeWorkspaces: [selection] });
      expect(saved.validateSync()).toBeUndefined();
      expect(saved.toObject().codeWorkspaces).toEqual([selection]);
    },
  );

  it('keeps legacy decisions field-less and rejects unknown modes', () => {
    const selection = { environmentId: 'machine', workspaceId: 'repo' };
    expect(new Checkout({ codeWorkspaces: [selection] }).toObject().codeWorkspaces).toEqual([
      selection,
    ]);
    expect(
      new Checkout({ codeWorkspaces: [{ ...selection, checkout: 'wrong' }] }).validateSync(),
    ).toBeDefined();
  });
});
