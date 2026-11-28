import type { ClickHouseParam, ClickHouseQueryClient, PgQueryClient, SqlParam } from './types';
import {
  auditClickHouseKeysSql,
  auditClickHouseSummarySql,
  auditPostgresKeysSql,
  runHistoryAudit,
} from './audit';

type PgKeyRow = {
  tenant_id: string;
  user_id: string;
  record_id: string;
  projection_version: string;
};

class ScriptedPg implements PgQueryClient {
  appliedSeq = '120';
  appliedVersion = '95';
  summary: Array<{ kind: string; row_count: string; min_version: string; max_version: string }> =
    [];

  keysByKind = new Map<string, PgKeyRow[]>();
  keyPageCalls = 0;

  async query<TRow>(
    text: string,
    values: readonly SqlParam[] = [],
  ): Promise<{ rows: TRow[]; rowCount: number | null }> {
    if (text.includes('FROM chat_search.watermark')) {
      return {
        rows: [
          {
            applied_seq: this.appliedSeq,
            applied_version: this.appliedVersion,
            lease_epoch: '3',
            gap_barrier_seq: null,
            gap_barrier_xmax: null,
          },
        ] as TRow[],
        rowCount: 1,
      };
    }
    if (text === auditPostgresKeysSql) {
      this.keyPageCalls += 1;
      const kind = String(values[0]);
      const after = String(values[4]);
      const limit = Number(values[5]);
      const rows = (this.keysByKind.get(kind) ?? [])
        .filter((row) => row.record_id > after)
        .sort((a, b) => (a.record_id < b.record_id ? -1 : 1))
        .slice(0, limit);
      return { rows: rows as TRow[], rowCount: rows.length };
    }
    if (text.includes('FROM chat_search.documents')) {
      return { rows: this.summary as TRow[], rowCount: this.summary.length };
    }
    throw new Error(`unscripted query: ${text.slice(0, 50)}`);
  }
}

class ScriptedClickHouse implements ClickHouseQueryClient {
  summary: Array<{ kind: string; row_count: string; min_version: string; max_version: string }> =
    [];

  keys: Array<{
    tenant_id: string;
    user_id: string;
    record_id: string;
    version: string;
    is_deleted: string;
  }> = [];

  appliedVersionSeen: string | null = null;

  async insert(): Promise<unknown> {
    return undefined;
  }

  async query(params: {
    query: string;
    query_params?: Record<string, ClickHouseParam>;
    format: 'JSONEachRow';
  }): Promise<{ json<TRow>(): Promise<TRow[]> }> {
    if (params.query === auditClickHouseSummarySql) {
      this.appliedVersionSeen = String(params.query_params?.applied_version);
      return { json: async <TRow>() => this.summary as unknown as TRow[] };
    }
    if (params.query === auditClickHouseKeysSql) {
      const wanted = new Set((params.query_params?.record_ids as readonly string[]) ?? []);
      const rows = this.keys.filter((row) => wanted.has(row.record_id));
      return { json: async <TRow>() => rows as unknown as TRow[] };
    }
    throw new Error('unscripted clickhouse query');
  }
}

function pgKey(recordId: string, version: string): PgKeyRow {
  return {
    tenant_id: '__BASE__',
    user_id: 'u1',
    record_id: recordId,
    projection_version: version,
  };
}

function chKey(recordId: string, version: string, isDeleted = '0') {
  return {
    tenant_id: '__BASE__',
    user_id: 'u1',
    record_id: recordId,
    version,
    is_deleted: isDeleted,
  };
}

describe('runHistoryAudit', () => {
  it('reports a clean gate when every PostgreSQL key is present at the same version', async () => {
    const pg = new ScriptedPg();
    const clickhouse = new ScriptedClickHouse();

    pg.summary = [{ kind: 'message', row_count: '2', min_version: '1', max_version: '9' }];
    pg.keysByKind.set('message', [pgKey('m1', '5'), pgKey('m2', '9')]);
    clickhouse.summary = [{ kind: 'message', row_count: '2', min_version: '1', max_version: '9' }];
    clickhouse.keys = [chKey('m1', '5'), chKey('m2', '9')];

    const report = await runHistoryAudit({ pg, clickhouse }, { kinds: ['message'] });

    expect(report.clean).toBe(true);
    expect(report.appliedSeq).toBe(BigInt(120));
    expect(report.appliedVersion).toBe(BigInt(95));
    expect(clickhouse.appliedVersionSeen).toBe('95');

    const [messages] = report.kinds;
    expect(messages.postgres).toEqual({
      rowCount: 2,
      minVersion: BigInt(1),
      maxVersion: BigInt(9),
    });
    expect(messages.clickhouse).toEqual({
      rowCount: 2,
      minVersion: BigInt(1),
      maxVersion: BigInt(9),
    });
    expect(messages.missingKeys).toEqual([]);
    expect(messages.staleKeys).toEqual([]);
    expect(messages.sampled).toBe(false);
  });

  it('fails the gate and names the key when a version below the watermark is absent', async () => {
    const pg = new ScriptedPg();
    const clickhouse = new ScriptedClickHouse();

    pg.summary = [{ kind: 'message', row_count: '2', min_version: '1', max_version: '9' }];
    pg.keysByKind.set('message', [pgKey('m1', '5'), pgKey('m2', '9')]);
    clickhouse.summary = [{ kind: 'message', row_count: '1', min_version: '5', max_version: '5' }];
    clickhouse.keys = [chKey('m1', '5')];

    const report = await runHistoryAudit({ pg, clickhouse }, { kinds: ['message'] });

    expect(report.clean).toBe(false);
    expect(report.kinds[0].missingKeys).toHaveLength(1);
    expect(report.kinds[0].missingKeys[0]).toContain('m2');
  });

  it('flags a key whose ClickHouse version trails PostgreSQL', async () => {
    const pg = new ScriptedPg();
    const clickhouse = new ScriptedClickHouse();

    pg.keysByKind.set('message', [pgKey('m1', '9')]);
    clickhouse.keys = [chKey('m1', '4')];

    const report = await runHistoryAudit({ pg, clickhouse }, { kinds: ['message'] });

    expect(report.clean).toBe(false);
    expect(report.kinds[0].staleKeys[0]).toContain('m1');
    expect(report.kinds[0].missingKeys).toEqual([]);
  });

  it('treats a ClickHouse tombstone as absence for a live PostgreSQL row', async () => {
    const pg = new ScriptedPg();
    const clickhouse = new ScriptedClickHouse();

    pg.keysByKind.set('message', [pgKey('m1', '5')]);
    clickhouse.keys = [chKey('m1', '6', '1')];

    const report = await runHistoryAudit({ pg, clickhouse }, { kinds: ['message'] });

    expect(report.kinds[0].missingKeys[0]).toContain('m1');
  });

  it('marks the report as sampled when the page budget is exhausted', async () => {
    const pg = new ScriptedPg();
    const clickhouse = new ScriptedClickHouse();

    const keys: PgKeyRow[] = [];
    for (let i = 0; i < 10; i++) {
      keys.push(pgKey(`m${i}`, '1'));
      clickhouse.keys.push(chKey(`m${i}`, '1'));
    }
    pg.keysByKind.set('message', keys);

    const report = await runHistoryAudit(
      { pg, clickhouse },
      { kinds: ['message'], pageSize: 2, maxPages: 3 },
    );

    expect(report.kinds[0].sampled).toBe(true);
    expect(pg.keyPageCalls).toBe(3);
  });

  it('caps the number of reported gap keys', async () => {
    const pg = new ScriptedPg();
    const clickhouse = new ScriptedClickHouse();

    const keys: PgKeyRow[] = [];
    for (let i = 0; i < 20; i++) {
      keys.push(pgKey(`m${String(i).padStart(2, '0')}`, '1'));
    }
    pg.keysByKind.set('message', keys);

    const report = await runHistoryAudit(
      { pg, clickhouse },
      { kinds: ['message'], maxReportedKeys: 5 },
    );

    expect(report.kinds[0].missingKeys).toHaveLength(5);
    expect(report.clean).toBe(false);
  });

  it('reports zeroed summaries for a kind neither store knows about', async () => {
    const report = await runHistoryAudit(
      { pg: new ScriptedPg(), clickhouse: new ScriptedClickHouse() },
      { kinds: ['shared-link'] },
    );

    expect(report.kinds[0].postgres).toEqual({ rowCount: 0, minVersion: null, maxVersion: null });
    expect(report.kinds[0].clickhouse).toEqual({ rowCount: 0, minVersion: null, maxVersion: null });
    expect(report.clean).toBe(true);
  });
});
