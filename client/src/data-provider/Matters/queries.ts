import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';

const BKL_PROXY_BASE = '/bkl';

export interface BklMatter {
  matter_uid: string;
  case_name?: string | null;
  case_alias?: string | null;
  case_number?: string | null;
  client?: string | null;
  matter_type?: string | null;
  open_date?: string | null;
  end_date?: string | null;
  doc_count?: number | null;
  special_group?: string[] | null;
  keywords?: string[] | null;
}

export interface BklMattersResponse {
  matters: BklMatter[];
  count: number;
}

async function fetchMatters(): Promise<BklMattersResponse> {
  const res = await fetch(`${BKL_PROXY_BASE}/api/bkl/matters`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`bkl matters fetch failed (${res.status})`);
  }
  return (await res.json()) as BklMattersResponse;
}

export function useBklMattersQuery(enabled = true): UseQueryResult<BklMattersResponse> {
  return useQuery<BklMattersResponse>(['bklMatters'], fetchMatters, {
    enabled,
    staleTime: 5 * 60 * 1000,
    cacheTime: 30 * 60 * 1000,
  });
}

export function filterMatters(matters: BklMatter[], query: string, limit = 30): BklMatter[] {
  const q = query.trim().toLowerCase();
  if (!q) return matters.slice(0, limit);

  const scored: Array<{ m: BklMatter; score: number }> = [];
  for (const m of matters) {
    let score = 0;
    const uid = (m.matter_uid || '').toLowerCase();
    const num = (m.case_number || '').toLowerCase();
    const alias = (m.case_alias || '').toLowerCase();
    const name = (m.case_name || '').toLowerCase();
    const client = (m.client || '').toLowerCase();
    if (uid.startsWith(q)) score += 100;
    else if (uid.includes(q)) score += 30;
    if (num.startsWith(q)) score += 90;
    else if (num.includes(q)) score += 25;
    if (alias.startsWith(q)) score += 80;
    else if (alias.includes(q)) score += 20;
    if (name.includes(q)) score += 15;
    if (client.includes(q)) score += 10;
    if (m.keywords?.some((k) => (k || '').toLowerCase().includes(q))) score += 5;
    if (score > 0) scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.m);
}

export function formatMatterLabel(m: BklMatter): string {
  const parts: string[] = [];
  if (m.case_alias) parts.push(m.case_alias);
  if (m.case_number) parts.push(m.case_number);
  if (m.matter_type) parts.push(m.matter_type);
  return parts.join(' · ') || m.matter_uid;
}

export interface BklDoc {
  doc_id: string;
  file_name?: string | null;
  /** 표시용 파일명 (서버 계산) */
  display_name?: string | null;
  imanage_doc_id?: string | null;
}

export interface BklDocsResponse {
  docs: BklDoc[];
}

async function fetchDocs(q: string): Promise<BklDocsResponse> {
  const res = await fetch(`${BKL_PROXY_BASE}/api/bkl/docs?q=${encodeURIComponent(q)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`bkl docs fetch failed (${res.status})`);
  }
  return (await res.json()) as BklDocsResponse;
}

export function useBklDocsQuery(q: string, enabled = true): UseQueryResult<BklDocsResponse> {
  return useQuery<BklDocsResponse>(['bklDocs', q], () => fetchDocs(q), {
    enabled: enabled && q.trim().length >= 2,
    staleTime: 60 * 1000,
  });
}
