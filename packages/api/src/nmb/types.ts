/** Wire types for the nmb-scanner HTTP contract (docs/nmb/INTERFACE.md). */

export type ScanDecisionKind = 'allow' | 'mask' | 'review' | 'reject';
export type FindingAction = 'MASK' | 'BLOCK' | 'ALLOW';
export type ReviewStatus = 'pending' | 'approved-masked' | 'rejected';

export interface ScanFinding {
  entity: string;
  type: string;
  location: { segment: string; start: number; end: number };
  score: number;
  action: FindingAction;
  value_hash: string;
  placeholder?: string | null;
}

export interface ScanResult {
  decision: ScanDecisionKind;
  conversation_id: string;
  findings: ScanFinding[];
  sanitized_content: string | null;
  review_required_reason: string | null;
  review_id: string | null;
  document?: Record<string, unknown> | null;
  sanitized_segments?: Array<{ location: string; text: string }> | null;
  summary?: Record<string, unknown>;
}

export interface ReviewItem {
  id: string;
  user: string;
  department: string | null;
  conversation_id: string;
  source: 'text' | 'file';
  decision_at_creation: 'review' | 'reject';
  reason: string | null;
  findings: ScanFinding[];
  status: ReviewStatus;
  reviewer: string | null;
  reviewer_note: string | null;
  blocklist_additions: string[];
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ReviewOriginal {
  id: string;
  source: 'text' | 'file';
  segments: Array<{ location: string; text: string }>;
}

export interface ReviewResult {
  id: string;
  status: ReviewStatus;
  sanitized_content: string | null;
  sanitized_segments: Array<{ location: string; text: string }> | null;
}

export interface ScanContext {
  /** Placeholder namespace. Derived from the authenticated session, never from the request body. */
  scope: string;
  user: string;
  department?: string;
  roles: string[];
}

export interface ReviewActionBody {
  reviewer: string;
  roles: string[];
  note?: string;
  blocklist_additions?: string[];
}

export interface BlocklistEntry {
  term?: string;
  regex?: string;
  entity?: string;
  source?: 'base' | 'runtime';
}

export interface NmbConfig {
  enabled: boolean;
  scannerUrl: string;
  serviceKey: string;
  timeoutMs: number;
  /** LibreChat role name -> department sent to the scanner. */
  roleDepartments: Record<string, string>;
  defaultDepartment?: string;
  /** Append a one-line note telling the model that `<TYPE_nnn>` tokens are redactions. */
  maskNote: boolean;
  /** Scanner has the `regexes` blocklist extension (not in INTERFACE.md yet). */
  regexBlocklist: boolean;
}
