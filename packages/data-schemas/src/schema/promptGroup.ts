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
      required: true,
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

export default promptGroupSchema;
