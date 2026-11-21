import {
  getPreparedCodeOutputBuffer,
  cachePreparedCodeOutputBuffer,
  releasePreparedCodeOutputBuffer,
} from './cache';
import { CODE_OUTPUT_PREFLIGHT_MAX_BYTES, CODE_OUTPUT_PREFLIGHT_MAX_COUNT } from './preflight';

const route = { executionRouteKey: 'stateful:route' };

function lookup(req: object, name: string, id: string) {
  return getPreparedCodeOutputBuffer({
    req,
    ...route,
    file_path: `/mnt/data/${name}`,
    files: [{ id, name, storage_session_id: 'storage' }],
  });
}

describe('prepared code output cache', () => {
  it('returns a cached buffer once for its sandbox path and route', () => {
    const req = {};
    const buffer = Buffer.from('bytes');
    cachePreparedCodeOutputBuffer({
      req,
      ...route,
      id: 'f1',
      name: 'a.png',
      session_id: 'storage',
      buffer,
    });

    expect(
      getPreparedCodeOutputBuffer({
        req,
        executionRouteKey: 'other:route',
        file_path: '/mnt/data/a.png',
        files: [{ id: 'f1', name: 'a.png', storage_session_id: 'storage' }],
      }),
    ).toBeNull();
    expect(lookup(req, 'a.png', 'f1')).toBe(buffer);
    expect(lookup(req, 'a.png', 'f1')).toBeNull();
  });

  it('rejects traversal and absolute paths outside the sandbox mount', () => {
    const req = {};
    cachePreparedCodeOutputBuffer({
      req,
      ...route,
      id: 'f1',
      name: 'a.png',
      session_id: 'storage',
      buffer: Buffer.from('x'),
    });

    for (const file_path of ['/etc/a.png', '../a.png', '/mnt/data/../a.png', 'dir\\a.png']) {
      expect(
        getPreparedCodeOutputBuffer({
          req,
          ...route,
          file_path,
          files: [{ id: 'f1', name: 'a.png', storage_session_id: 'storage' }],
        }),
      ).toBeNull();
    }
  });

  it('releases a cached buffer so a later read downloads it again', () => {
    const req = {};
    cachePreparedCodeOutputBuffer({
      req,
      ...route,
      id: 'f1',
      name: 'a.png',
      session_id: 'storage',
      buffer: Buffer.from('x'),
    });

    releasePreparedCodeOutputBuffer({ req, ...route, id: 'f1', session_id: 'storage' });

    expect(lookup(req, 'a.png', 'f1')).toBeNull();
  });

  it('evicts the oldest entries to stay within the preflight count and byte ceilings', () => {
    const req = {};
    for (let index = 0; index <= CODE_OUTPUT_PREFLIGHT_MAX_COUNT; index++) {
      cachePreparedCodeOutputBuffer({
        req,
        ...route,
        id: `f${index}`,
        name: `f${index}.png`,
        session_id: 'storage',
        buffer: Buffer.alloc(1),
      });
    }
    expect(lookup(req, 'f0.png', 'f0')).toBeNull();
    expect(lookup(req, 'f1.png', 'f1')).not.toBeNull();

    const big = {};
    const half = Math.floor(CODE_OUTPUT_PREFLIGHT_MAX_BYTES / 2) + 1;
    cachePreparedCodeOutputBuffer({
      req: big,
      ...route,
      id: 'a',
      name: 'a.bin',
      session_id: 'storage',
      buffer: Buffer.alloc(half),
    });
    cachePreparedCodeOutputBuffer({
      req: big,
      ...route,
      id: 'b',
      name: 'b.bin',
      session_id: 'storage',
      buffer: Buffer.alloc(half),
    });
    expect(lookup(big, 'a.bin', 'a')).toBeNull();
    expect(lookup(big, 'b.bin', 'b')?.length).toBe(half);
  });
});
