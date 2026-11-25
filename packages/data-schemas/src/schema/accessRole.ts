import { Schema } from 'mongoose';
import type { IAccessRole } from '~/types';

const accessRoleSchema: Schema<IAccessRole> = new Schema<IAccessRole>(
  {
    accessRoleId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    description: String,
    resourceType: {
      type: String,
      enum: [
        'agent',
        'codeEnvironment',
        'project',
        'file',
        'promptGroup',
        'mcpServer',
        'remoteAgent',
        'skill',
        'sharedLink',
      ],
      required: true,
      default: 'agent',
    },
    permBits: {
      type: Number,
      required: true,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

accessRoleSchema.index({ accessRoleId: 1, tenantId: 1 }, { unique: true });

export default accessRoleSchema;
