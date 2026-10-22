export const OPENID_CHECK_RECEIPT = 'openid_check';
export type OpenIDSessionCheckStatus =
  | 'verified'
  | 'not_required'
  | 'login_required'
  | 'interaction_required'
  | 'unavailable';
export type OpenIDSessionCheckResponse =
  | { status: OpenIDSessionCheckStatus }
  | { status: 'redirect'; authorizationUrl: string };
