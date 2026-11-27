import { model, models } from 'mongoose';
import { codeEnvRefSchema } from './codeEnvRef';

it('preserves the uploaded sandbox filename through schema serialization', () => {
  const Ref = models.SandboxFilenameRef ?? model('SandboxFilenameRef', codeEnvRefSchema);
  const ref = new Ref({
    kind: 'user',
    id: 'user',
    storage_session_id: 'session',
    file_id: 'file',
    sandboxFilename: 'rows-alias.csv',
  });
  expect(ref.validateSync()).toBeUndefined();
  const restored = new Ref(ref.toObject());
  expect(restored.toObject().sandboxFilename).toBe('rows-alias.csv');
});
