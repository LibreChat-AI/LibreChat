import type { TenantScope } from './policy';
import {
  tenantFilter,
  scopeReplacement,
  currentTenantScope,
  resolveTenantScope,
  TenantIsolationError,
  stampTenantOnDocument,
  sanitizeTenantMutation,
  tenantWritePredicate,
  resetTenantStrictCache,
} from './policy';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';

/**
 * The tenant policy is engine-neutral: these tests run with no database and no
 * Mongoose model. A storage engine that satisfies this contract inherits tenant
 * isolation without reimplementing any of its rules.
 */

const SCOPED: TenantScope = { kind: 'scoped', tenantId: 'tenant-a' };
const SYSTEM: TenantScope = { kind: 'system' };
const UNSCOPED: TenantScope = { kind: 'unscoped' };

const withStrict = async (value: boolean, fn: () => void | Promise<void>): Promise<void> => {
  const previous = process.env.TENANT_ISOLATION_STRICT;
  process.env.TENANT_ISOLATION_STRICT = String(value);
  resetTenantStrictCache();
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.TENANT_ISOLATION_STRICT;
    } else {
      process.env.TENANT_ISOLATION_STRICT = previous;
    }
    resetTenantStrictCache();
  }
};

afterEach(() => {
  resetTenantStrictCache();
});

describe('currentTenantScope', () => {
  it('reports unscoped with no ambient context', () => {
    expect(currentTenantScope()).toEqual({ kind: 'unscoped' });
  });

  it('reports the active tenant', async () => {
    const scope = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      currentTenantScope(),
    );
    expect(scope).toEqual({ kind: 'scoped', tenantId: 'tenant-a' });
  });

  it('reports system for the cross-tenant sentinel', async () => {
    const scope = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      currentTenantScope(),
    );
    expect(scope).toEqual({ kind: 'system' });
  });

  it('never throws in strict mode', async () => {
    await withStrict(true, () => {
      expect(currentTenantScope()).toEqual({ kind: 'unscoped' });
    });
  });
});

describe('resolveTenantScope', () => {
  it('fails closed in strict mode and names the operation', async () => {
    await withStrict(true, () => {
      expect(() => resolveTenantScope('Query')).toThrow(
        '[TenantIsolation] Query attempted without tenant context in strict mode',
      );
      expect(() => resolveTenantScope('Query')).toThrow(TenantIsolationError);
    });
  });

  it('passes through when not strict', async () => {
    await withStrict(false, () => {
      expect(resolveTenantScope('Query')).toEqual({ kind: 'unscoped' });
    });
  });

  it('lets an active tenant through strict mode', async () => {
    await withStrict(true, async () => {
      const scope = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        resolveTenantScope('Query'),
      );
      expect(scope).toEqual({ kind: 'scoped', tenantId: 'tenant-a' });
    });
  });

  it('lets the system sentinel through strict mode', async () => {
    await withStrict(true, async () => {
      const scope = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
        resolveTenantScope('Query'),
      );
      expect(scope).toEqual({ kind: 'system' });
    });
  });
});

describe('tenantFilter', () => {
  it('restricts to the active tenant', () => {
    expect(tenantFilter(SCOPED)).toEqual({ tenantId: 'tenant-a' });
  });

  it('does not restrict system or unscoped reads', () => {
    expect(tenantFilter(SYSTEM)).toBeUndefined();
    expect(tenantFilter(UNSCOPED)).toBeUndefined();
  });
});

describe('sanitizeTenantMutation (guard mode)', () => {
  it('refuses a cross-tenant $set', () => {
    expect(() =>
      sanitizeTenantMutation(SCOPED, { $set: { tenantId: 'tenant-b' } }, 'guard'),
    ).toThrow('[TenantIsolation] Cross-tenant tenantId mutation is not allowed');
  });

  it('refuses a cross-tenant top-level value', () => {
    expect(() => sanitizeTenantMutation(SCOPED, { tenantId: 'tenant-b' }, 'guard')).toThrow(
      TenantIsolationError,
    );
  });

  it('strips a matching tenantId rather than writing it', () => {
    const result = sanitizeTenantMutation(
      SCOPED,
      { $set: { tenantId: 'tenant-a', name: 'x' } },
      'guard',
    );
    expect(result.update).toEqual({ $set: { name: 'x' } });
    expect(result.changed).toBe(true);
    expect(result.emptied).toBe(false);
  });

  it('drops an operator left empty by stripping', () => {
    const result = sanitizeTenantMutation(SCOPED, { $set: { tenantId: 'tenant-a' } }, 'guard');
    expect(result.update).toEqual({});
    expect(result.emptied).toBe(true);
  });

  it('always strips $unset and $rename without throwing', () => {
    const result = sanitizeTenantMutation(
      SCOPED,
      { $unset: { tenantId: '' }, $rename: { tenantId: 'other' } },
      'guard',
    );
    expect(result.update).toEqual({});
    expect(result.emptied).toBe(true);
  });

  it('strips silently when no tenant is active', () => {
    const result = sanitizeTenantMutation(UNSCOPED, { $set: { tenantId: 'tenant-b' } }, 'guard');
    expect(result.update).toEqual({});
  });

  it('leaves untouched payloads by reference', () => {
    const update = { $set: { name: 'x' } };
    const result = sanitizeTenantMutation(SCOPED, update, 'guard');
    expect(result.update).toBe(update);
    expect(result.changed).toBe(false);
  });

  it('never mutates the caller payload', () => {
    const update = { $set: { tenantId: 'tenant-a', name: 'x' }, $inc: { n: 1 } };
    sanitizeTenantMutation(SCOPED, update, 'guard');
    expect(update).toEqual({ $set: { tenantId: 'tenant-a', name: 'x' }, $inc: { n: 1 } });
  });

  it('leaves a system-scoped payload alone so cross-tenant writes stay possible', () => {
    const update = { $set: { tenantId: 'tenant-b', name: 'x' } };
    const result = sanitizeTenantMutation(SYSTEM, update, 'guard');
    expect(result.update).toBe(update);
    expect(result.changed).toBe(false);
  });

  it('treats a missing payload as empty', () => {
    expect(sanitizeTenantMutation(SCOPED, null, 'guard')).toEqual({
      update: {},
      emptied: false,
      changed: false,
    });
  });
});

describe('sanitizeTenantMutation (strip mode)', () => {
  it('strips a cross-tenant value instead of throwing', () => {
    const result = sanitizeTenantMutation(
      SCOPED,
      { $set: { tenantId: 'tenant-b', name: 'x' } },
      'strip',
    );
    expect(result.update).toEqual({ $set: { name: 'x' } });
  });

  it('strips every operator and the top level', () => {
    const result = sanitizeTenantMutation(
      SCOPED,
      {
        tenantId: 'tenant-b',
        $set: { tenantId: 'tenant-b' },
        $setOnInsert: { tenantId: 'tenant-b' },
        $unset: { tenantId: '' },
        $rename: { tenantId: 'x' },
      },
      'strip',
    );
    expect(result.update).toEqual({});
    expect(result.emptied).toBe(true);
  });
});

describe('scopeReplacement', () => {
  it('stamps the active tenant when the replacement omits it', () => {
    const result = scopeReplacement(SCOPED, { name: 'x' });
    expect(result.replacement).toEqual({ name: 'x', tenantId: 'tenant-a' });
    expect(result.changed).toBe(true);
  });

  it('accepts a replacement naming the active tenant', () => {
    const replacement = { name: 'x', tenantId: 'tenant-a' };
    const result = scopeReplacement(SCOPED, replacement);
    expect(result.replacement).toBe(replacement);
    expect(result.changed).toBe(false);
  });

  it('refuses a replacement naming another tenant', () => {
    expect(() => scopeReplacement(SCOPED, { tenantId: 'tenant-b' })).toThrow(
      '[TenantIsolation] Modifying tenantId via replacement is not allowed',
    );
  });

  it('refuses any asserted tenantId when no tenant is active', () => {
    expect(() => scopeReplacement(UNSCOPED, { tenantId: 'tenant-b' })).toThrow(
      TenantIsolationError,
    );
  });

  it('leaves system replacements alone', () => {
    const replacement = { name: 'x', tenantId: 'tenant-b' };
    const result = scopeReplacement(SYSTEM, replacement);
    expect(result.replacement).toBe(replacement);
    expect(result.changed).toBe(false);
  });

  it('never mutates the caller replacement', () => {
    const replacement = { name: 'x' };
    scopeReplacement(SCOPED, replacement);
    expect(replacement).toEqual({ name: 'x' });
  });
});

describe('tenantWritePredicate', () => {
  it('matches the active tenant or an explicitly legacy value', () => {
    expect(tenantWritePredicate(SCOPED, false, undefined)).toEqual({
      tenantId: { $in: ['tenant-a', null, ''] },
    });
  });

  it('allows a modified tenantId that still names the active tenant', () => {
    expect(tenantWritePredicate(SCOPED, true, 'tenant-a')).toEqual({
      tenantId: { $in: ['tenant-a', null, ''] },
    });
  });

  it('rejects a cross-tenant tenantId modification outside system scope', () => {
    expect(() => tenantWritePredicate(SCOPED, true, 'tenant-b')).toThrow(TenantIsolationError);
    expect(() => tenantWritePredicate(UNSCOPED, true, 'tenant-a')).toThrow(TenantIsolationError);
  });

  it('yields nothing for system or unscoped saves', () => {
    expect(tenantWritePredicate(SYSTEM, true, 'tenant-b')).toBeUndefined();
    expect(tenantWritePredicate(UNSCOPED, false, undefined)).toBeUndefined();
  });
});

describe('stampTenantOnDocument', () => {
  it('stamps the active tenant onto a new document', () => {
    const document: Record<string, unknown> = { name: 'x' };
    stampTenantOnDocument(SCOPED, document);
    expect(document.tenantId).toBe('tenant-a');
  });

  it('leaves a matching tenantId in place', () => {
    const document: Record<string, unknown> = { tenantId: 'tenant-a' };
    stampTenantOnDocument(SCOPED, document);
    expect(document.tenantId).toBe('tenant-a');
  });

  it('tolerates a mismatched tenantId when not strict', async () => {
    await withStrict(false, () => {
      const document: Record<string, unknown> = { tenantId: 'tenant-b' };
      stampTenantOnDocument(SCOPED, document);
      expect(document.tenantId).toBe('tenant-b');
    });
  });

  it('refuses a mismatched tenantId in strict mode', async () => {
    await withStrict(true, () => {
      expect(() => stampTenantOnDocument(SCOPED, { tenantId: 'tenant-b' })).toThrow(
        '[TenantIsolation] Document tenantId does not match current tenant context',
      );
    });
  });

  it('does not stamp system or unscoped writes', () => {
    const systemDocument: Record<string, unknown> = { name: 'x' };
    stampTenantOnDocument(SYSTEM, systemDocument);
    expect(systemDocument.tenantId).toBeUndefined();

    const unscopedDocument: Record<string, unknown> = { name: 'x' };
    stampTenantOnDocument(UNSCOPED, unscopedDocument);
    expect(unscopedDocument.tenantId).toBeUndefined();
  });
});
