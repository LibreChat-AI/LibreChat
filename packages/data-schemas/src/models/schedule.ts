import { Model } from 'mongoose';
import type { IScheduleDocument, IScheduleRunDocument } from '~/types/schedule';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import scheduleRunSchema from '~/schema/scheduleRun';
import scheduleSchema from '~/schema/schedule';

export function createScheduleModel(mongoose: typeof import('mongoose')): Model<IScheduleDocument> {
  applyTenantIsolation(scheduleSchema);
  return mongoose.models.Schedule || mongoose.model<IScheduleDocument>('Schedule', scheduleSchema);
}

export function createScheduleRunModel(
  mongoose: typeof import('mongoose'),
): Model<IScheduleRunDocument> {
  applyTenantIsolation(scheduleRunSchema);
  return (
    mongoose.models.ScheduleRun ||
    mongoose.model<IScheduleRunDocument>('ScheduleRun', scheduleRunSchema)
  );
}
