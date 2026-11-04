import { Schema } from 'mongoose';
import type { IOpenIDSubject } from '~/types';

const openidSubjectSchema: Schema<IOpenIDSubject> = new Schema<IOpenIDSubject>({
  issuer: {
    type: String,
    required: true,
  },
  clientId: {
    type: String,
    required: true,
  },
  subject: {
    type: String,
    required: true,
  },
  boundaryIat: {
    type: Number,
    required: true,
  },
});

openidSubjectSchema.index({ issuer: 1, clientId: 1, subject: 1 }, { unique: true });

export default openidSubjectSchema;
