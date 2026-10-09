import { normalizeRumPath } from './routes';

describe('normalizeRumPath', () => {
  it('normalizes dynamic LibreChat route identifiers', () => {
    expect(normalizeRumPath('/c/65a5e0a7d1c2b3a4f5e6d789')).toBe('/c/:conversationId');
    expect(normalizeRumPath('/c/new')).toBe('/c/new');
    expect(normalizeRumPath('/share/65a5e0a7d1c2b3a4f5e6d789')).toBe('/share/:shareId');
    expect(normalizeRumPath('/assistants/asst_123')).toBe('/assistants/:assistantId');
  });

  it('normalizes generic UUID and ObjectId path segments', () => {
    expect(normalizeRumPath('/files/550e8400-e29b-41d4-a716-446655440000')).toBe('/files/:id');
    expect(normalizeRumPath('/files/65a5e0a7d1c2b3a4f5e6d789/preview')).toBe('/files/:id/preview');
  });

  it('preserves static routes', () => {
    expect(normalizeRumPath('/search')).toBe('/search');
    expect(normalizeRumPath('/')).toBe('/');
  });
});
