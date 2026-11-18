import type { Db } from 'mongodb';
import type { BrowserContext, Page } from '@playwright/test';

export type QueryKind = 'establish' | 'authorize' | 'revoke';
export type HarnessOptions = {
  reuse?: boolean;
  mode?: 'off' | 'record' | 'enforce';
  sessionExpiry?: number;
  maxSessionAgeMs?: number;
  loginMax?: number;
};

export type Harness = {
  baseURL: string;
  issuer: string;
  db: Db;
  directory: string;
  logPath: string;
  deliveries: { sid: string; at: number; status?: number }[];
  admin<T = Record<string, unknown>>(route: string, method?: string, body?: object): Promise<T>;
  startApp(options?: HarnessOptions): Promise<void>;
  stopApp(): Promise<void>;
  close(): Promise<void>;
  stopKeycloak(): Promise<void>;
  startKeycloak(): Promise<void>;
  stopMongo(): Promise<void>;
  startMongo(): Promise<void>;
  replay(index: number): Promise<{ status: number; body: unknown }>;
  gate: {
    arm(kind: QueryKind, sid?: string): void;
    wait(): Promise<{ kind: QueryKind; sid: string; waiting: true }>;
    release(): void;
  };
  login(context: BrowserContext, username?: 'a' | 'b'): Promise<Page>;
};

export function createHarness(options?: HarnessOptions): Promise<Harness>;
