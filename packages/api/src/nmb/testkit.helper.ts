import type { Request, Response } from 'express';
import type { ScannerClient } from './scanner';
import type { NmbConfig, ReviewItem, ScanResult } from './types';

export const SECRET = 'ACCT-9876543210-SECRET';

export const baseConfig: NmbConfig = {
  enabled: true,
  scannerUrl: 'http://scanner.test',
  serviceKey: 'svc-key',
  timeoutMs: 1000,
  roleDepartments: { RISK: 'Risk' },
  defaultDepartment: undefined,
  maskNote: true,
  regexBlocklist: false,
};

export function scanResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    decision: 'allow',
    conversation_id: 'u:user-1',
    findings: [],
    sanitized_content: 'hello',
    review_required_reason: null,
    review_id: null,
    ...over,
  };
}

export function reviewItem(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'rev_0123456789ab',
    user: 'user-1',
    department: 'Risk',
    conversation_id: 'u:user-1',
    source: 'text',
    decision_at_creation: 'review',
    reason: 'Policy requires human review for: secret:API_KEY_SECRET',
    findings: [],
    status: 'pending',
    reviewer: null,
    reviewer_note: null,
    blocklist_additions: [],
    created_at: '2026-11-09T10:00:00+00:00',
    updated_at: '2026-11-09T10:00:00+00:00',
    resolved_at: null,
    ...over,
  };
}

export function fakeScanner(over: Partial<Record<keyof ScannerClient, jest.Mock>> = {}) {
  const scanner = {
    scanText: jest.fn().mockResolvedValue(scanResult()),
    scanFile: jest.fn().mockResolvedValue(scanResult()),
    unmask: jest.fn().mockResolvedValue({ text: 'restored', restored: 1 }),
    listReviews: jest.fn().mockResolvedValue([]),
    getReview: jest.fn().mockResolvedValue(reviewItem()),
    getOriginal: jest.fn().mockResolvedValue({
      id: 'rev_0123456789ab',
      source: 'text',
      segments: [{ location: 'text', text: `pay ${SECRET} now` }],
    }),
    getResult: jest.fn().mockResolvedValue({
      id: 'rev_0123456789ab',
      status: 'approved-masked',
      sanitized_content: 'pay <ACCOUNT_001> now',
      sanitized_segments: null,
    }),
    approveMasked: jest.fn().mockResolvedValue(scanResult({ decision: 'mask', findings: [] })),
    reject: jest.fn().mockResolvedValue(reviewItem({ status: 'rejected' })),
    getBlocklist: jest.fn().mockResolvedValue([{ term: 'Project Falcon', source: 'base' }]),
    addBlocklist: jest.fn().mockResolvedValue(['x']),
    ...over,
  };
  return scanner as typeof scanner & ScannerClient;
}

export function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
      return res;
    },
  };
  return res as typeof res & Response;
}

export function mockReq(over: Record<string, unknown> = {}): Request {
  return {
    method: 'POST',
    path: '/',
    body: {},
    params: {},
    query: {},
    user: { id: 'user-1', role: 'USER', username: 'jdoe' },
    ...over,
  } as unknown as Request;
}
