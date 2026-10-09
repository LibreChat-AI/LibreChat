import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import sessionSchema from '~/schema/session';

export function createSessionModel(mongoose: typeof import('mongoose')): Model<t.ISession> {
  applyTenantIsolation(sessionSchema);
  return mongoose.models.Session || mongoose.model<t.ISession>('Session', sessionSchema);
}
