import { PLUGIN_MANIFEST_SCHEMA_ID } from './constants';
import { validateManifest } from './manifest';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { $schema: PLUGIN_MANIFEST_SCHEMA_ID, name: 'my-plugin', ...overrides };
}

describe('validateManifest', () => {
  it('accepts a minimal manifest', () => {
    const result = validateManifest(manifest());
    expect(result.status).toBe('ok');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('rejects a manifest that is not a JSON object', () => {
    for (const document of [[], null, 'plugin', 7]) {
      expect(validateManifest(document).status).toBe('rejected');
    }
  });

  describe('$schema selection', () => {
    it('rejects a manifest with no $schema', () => {
      const result = validateManifest({ name: 'my-plugin' });
      expect(result.status).toBe('rejected');
      expect(result.diagnostics[0].code).toBe('manifest_invalid');
    });

    it('reports an unsupported specification version', () => {
      const result = validateManifest(
        manifest({ $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json' }),
      );
      expect(result.status).toBe('rejected');
      expect(result.diagnostics[0].code).toBe('manifest_unsupported_version');
    });
  });

  describe('non-fatal exceptions', () => {
    it('reports and ignores unknown top-level fields', () => {
      const result = validateManifest(manifest({ mcpServers: {}, hooks: [] }));
      expect(result.status).toBe('ok');
      expect(result.diagnostics.map((issue) => issue.code)).toEqual([
        'manifest_unknown_field',
        'manifest_unknown_field',
      ]);
      expect(result.status === 'ok' && 'mcpServers' in result.manifest).toBe(false);
    });

    it('reports and ignores a non-object extensions field', () => {
      const result = validateManifest(manifest({ extensions: 'nope' }));
      expect(result.status).toBe('ok');
      expect(result.diagnostics[0].code).toBe('extensions_invalid');
      expect(result.status === 'ok' && result.manifest.extensions).toBeUndefined();
    });
  });

  describe('name constraints', () => {
    it.each(['a', 'my-plugin', 'acme.tools', 'lint3r', 'a1.b2-c3'])('accepts %s', (name) => {
      expect(validateManifest(manifest({ name })).status).toBe('ok');
    });

    it.each([
      ['My-Plugin', 'uppercase'],
      ['-start', 'leading hyphen'],
      ['end-', 'trailing hyphen'],
      ['.start', 'leading period'],
      ['has--double', 'consecutive hyphens'],
      ['too.many..dots', 'consecutive periods'],
      ['', 'empty'],
      ['under_score', 'underscore'],
      ['a'.repeat(65), 'too long'],
    ])('rejects %s (%s)', (name) => {
      expect(validateManifest(manifest({ name })).status).toBe('rejected');
    });

    it('accepts a 64 character name', () => {
      expect(validateManifest(manifest({ name: 'a'.repeat(64) })).status).toBe('ok');
    });
  });

  describe('metadata fields', () => {
    it('does not validate metadata semantics', () => {
      const result = validateManifest(
        manifest({
          version: 'not-semver',
          homepage: 'not a url',
          repository: 'also not a url',
          license: 'Definitely-Not-SPDX',
          author: { email: 'not-an-email', url: 'nope' },
        }),
      );
      expect(result.status).toBe('ok');
      expect(result.diagnostics).toHaveLength(0);
    });

    it('rejects metadata fields with the wrong JSON type', () => {
      expect(validateManifest(manifest({ version: 1 })).status).toBe('rejected');
      expect(validateManifest(manifest({ keywords: 'one' })).status).toBe('rejected');
      expect(validateManifest(manifest({ keywords: [1] })).status).toBe('rejected');
    });

    it('rejects an author object with unknown or non-string fields', () => {
      expect(validateManifest(manifest({ author: { name: 'A', role: 'owner' } })).status).toBe(
        'rejected',
      );
      expect(validateManifest(manifest({ author: { name: 7 } })).status).toBe('rejected');
    });
  });

  describe('extensions', () => {
    it('preserves namespace data without validating its contents', () => {
      const result = validateManifest(
        manifest({ extensions: { 'ai.librechat': { anything: [1, { deep: true }] } } }),
      );
      expect(result.status).toBe('ok');
      expect(result.status === 'ok' && result.manifest.extensions).toEqual({
        'ai.librechat': { anything: [1, { deep: true }] },
      });
    });

    it('rejects a namespace whose value is not an object', () => {
      const result = validateManifest(manifest({ extensions: { 'ai.librechat': true } }));
      expect(result.status).toBe('rejected');
    });
  });
});
