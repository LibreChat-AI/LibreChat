import mongoose, { Document } from 'mongoose';
import type { OneOrMany } from './query';

export interface IAction extends Document {
  user: mongoose.Types.ObjectId;
  action_id: string;
  type: string;
  settings?: unknown;
  agent_id?: string;
  assistant_id?: string;
  metadata: {
    api_key?: string;
    auth: {
      authorization_type?: string;
      custom_auth_header?: string;
      type: 'service_http' | 'oauth' | 'none';
      authorization_content_type?: string;
      authorization_url?: string;
      client_url?: string;
      scope?: string;
      token_exchange_method: 'default_post' | 'basic_auth_header' | null;
    };
    domain: string;
    privacy_policy_url?: string;
    raw_spec?: string;
    oauth_client_id?: string;
    oauth_client_secret?: string;
  };
  tenantId?: string;
}

/**
 * Domain criteria for locating actions. Fields are combined with AND; an array
 * value matches any of its entries. Deliberately storage-agnostic — it names
 * domain concepts, not stored field names or query operators.
 */
export interface ActionQuery {
  actionId?: OneOrMany<string>;
  agentId?: OneOrMany<string>;
  assistantId?: OneOrMany<string>;
  user?: string;
}
