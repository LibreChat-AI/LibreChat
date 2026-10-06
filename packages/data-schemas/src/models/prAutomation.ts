import { Model } from 'mongoose';
import type { IPRAutomationDocument } from '~/types/prAutomation';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import prAutomationSchema from '~/schema/prAutomation';

export function createPRAutomationModel(
  mongoose: typeof import('mongoose'),
): Model<IPRAutomationDocument> {
  applyTenantIsolation(prAutomationSchema);
  return (
    mongoose.models.PRAutomation ||
    mongoose.model<IPRAutomationDocument>('PRAutomation', prAutomationSchema)
  );
}
