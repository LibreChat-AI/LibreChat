import { Schema } from 'mongoose';
import { Constants } from 'librechat-data-provider';
import type { IPromptGroupDocument } from '~/types';

const promptGroupSchema: Schema<IPromptGroupDocument> = new Schema<IPromptGroupDocument>(
  {
    name: {
      type: String,
      required: true,
      index: true,
    },
    numberOfGenerations: {
      type: Number,
      default: 0,
    },
    oneliner: {
      type: String,
      default: '',
    },
    category: {
      type: String,
      default: '',
      index: true,
    },
    productionId: {
      type: Schema.Types.ObjectId,
      ref: 'Prompt',
      required: function (this: IPromptGroupDocument) {
        return (this.source ?? 'native') === 'native';
      },
      index: true,
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    authorName: {
      type: String,
      required: true,
    },
    command: {
      type: String,
      index: true,
      validate: {
        validator: function (v: string | undefined | null): boolean {
          return v === undefined || v === null || v === '' || /^[a-z0-9-]+$/.test(v);
        },
        message: (props: { value?: string } | undefined) =>
          `${props?.value ?? 'Value'} is not a valid command. Only lowercase alphanumeric characters and hyphens are allowed.`,
      },
      maxlength: [
        Constants.COMMANDS_MAX_LENGTH as number,
        `Command cannot be longer than ${Constants.COMMANDS_MAX_LENGTH} characters`,
      ],
    }, // Casting here bypasses the type error for the command field.
    /**
     * Provenance of this prompt group.
     *
     * - `native` — authored directly inside LibreChat.
     * - `langfuse` — mirrored from a configured Langfuse prompt.
     */
    source: {
      type: String,
      enum: ['native', 'langfuse'],
      default: 'native',
    },
    /** Name of the prompt in its Langfuse project. */
    sourcePromptName: {
      type: String,
      required: function (this: IPromptGroupDocument) {
        return this.source === 'langfuse';
      },
    },
    /** Langfuse project ID the prompt was mirrored from. */
    sourceProjectId: {
      type: String,
      required: function (this: IPromptGroupDocument) {
        return this.source === 'langfuse';
      },
    },
    /** Tenant's Langfuse destination key (e.g. `eu`) the prompt was mirrored from. */
    sourceDestination: {
      type: String,
      required: function (this: IPromptGroupDocument) {
        return this.source === 'langfuse';
      },
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

promptGroupSchema.index({ numberOfGenerations: -1, updatedAt: -1, _id: 1 });
promptGroupSchema.index(
  { tenantId: 1, sourceDestination: 1, sourceProjectId: 1, sourcePromptName: 1 },
  {
    unique: true,
    partialFilterExpression: { sourcePromptName: { $exists: true } },
  },
);

export default promptGroupSchema;
