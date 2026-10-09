import { logger } from '@librechat/data-schemas';
import { OAuthReconnectionManager } from '~/mcp/oauth/OAuthReconnectionManager';
import { GenerationJobManager } from '~/stream';
import { MCPManager } from '~/mcp/MCPManager';

type ConnectionStats = ReturnType<InstanceType<typeof MCPManager>['getConnectionStats']>;
type TrackerStats = ReturnType<InstanceType<typeof OAuthReconnectionManager>['getTrackerStats']>;
type RuntimeStats = ReturnType<(typeof GenerationJobManager)['getRuntimeStats']>;

const INTERVAL_MS = 60_000;
const SNAPSHOT_HISTORY_LIMIT = 120;

interface MemorySnapshot {
  ts: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  mcpConnections: ConnectionStats | null;
  oauthTracker: TrackerStats | null;
  generationJobs: RuntimeStats | null;
}

const snapshots: MemorySnapshot[] = [];
let interval: NodeJS.Timeout | null = null;

function toMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

function getMCPStats(): {
  mcpConnections: ConnectionStats | null;
  oauthTracker: TrackerStats | null;
} {
  let mcpConnections: ConnectionStats | null = null;
  let oauthTracker: TrackerStats | null = null;

  try {
    mcpConnections = MCPManager.getInstance().getConnectionStats();
  } catch {
    /* not initialized yet */
  }

  try {
    oauthTracker = OAuthReconnectionManager.getInstance().getTrackerStats();
  } catch {
    /* not initialized yet */
  }

  return { mcpConnections, oauthTracker };
}

function getJobStats(): { generationJobs: RuntimeStats | null } {
  try {
    return { generationJobs: GenerationJobManager.getRuntimeStats() };
  } catch {
    return { generationJobs: null };
  }
}

function collectSnapshot(): void {
  const mem = process.memoryUsage();
  const mcpStats = getMCPStats();
  const jobStats = getJobStats();

  const snapshot: MemorySnapshot = {
    ts: Date.now(),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers ?? 0,
    ...mcpStats,
    ...jobStats,
  };

  snapshots.push(snapshot);
  if (snapshots.length > SNAPSHOT_HISTORY_LIMIT) {
    snapshots.shift();
  }

  logger.debug('[MemDiag] Snapshot', {
    rss: `${toMB(mem.rss)} MB`,
    heapUsed: `${toMB(mem.heapUsed)} MB`,
    heapTotal: `${toMB(mem.heapTotal)} MB`,
    external: `${toMB(mem.external)} MB`,
    arrayBuffers: `${toMB(mem.arrayBuffers ?? 0)} MB`,
    mcp: mcpStats,
    jobs: jobStats,
    snapshotCount: snapshots.length,
  });

  if (snapshots.length < 3) {
    return;
  }

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const elapsedMin = (last.ts - first.ts) / 60_000;
  if (elapsedMin < 0.1) {
    return;
  }
  const rssDelta = last.rss - first.rss;
  const heapDelta = last.heapUsed - first.heapUsed;
  logger.debug('[MemDiag] Trend', {
    overMinutes: elapsedMin.toFixed(1),
    rssDelta: `${toMB(rssDelta)} MB`,
    heapDelta: `${toMB(heapDelta)} MB`,
    rssRate: `${toMB((rssDelta / elapsedMin) * 60)} MB/hr`,
    heapRate: `${toMB((heapDelta / elapsedMin) * 60)} MB/hr`,
  });
}

function forceGC(): boolean {
  if (global.gc) {
    global.gc();
    logger.info('[MemDiag] Forced garbage collection');
    return true;
  }
  logger.warn('[MemDiag] GC not exposed. Start with --expose-gc to enable.');
  return false;
}

function getSnapshots(): readonly MemorySnapshot[] {
  return snapshots;
}

function start(): void {
  if (interval) {
    return;
  }
  logger.info(`[MemDiag] Starting memory diagnostics (interval: ${INTERVAL_MS / 1000}s)`);
  collectSnapshot();
  interval = setInterval(collectSnapshot, INTERVAL_MS);
  if (interval.unref) {
    interval.unref();
  }
}

function stop(): void {
  if (!interval) {
    return;
  }
  clearInterval(interval);
  interval = null;
  logger.info('[MemDiag] Stopped memory diagnostics');
}

export const memoryDiagnostics: {
  start: typeof start;
  stop: typeof stop;
  forceGC: typeof forceGC;
  getSnapshots: typeof getSnapshots;
  collectSnapshot: typeof collectSnapshot;
} = { start, stop, forceGC, getSnapshots, collectSnapshot };
