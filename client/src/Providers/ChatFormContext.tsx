import type { ChatFormValues } from '~/common';
import { createFormContext } from './CustomFormContext';

const { CustomFormProvider, useCustomFormContext, useOptionalCustomFormContext } =
  createFormContext<ChatFormValues>();

export {
  CustomFormProvider as ChatFormProvider,
  useCustomFormContext as useChatFormContext,
  useOptionalCustomFormContext as useOptionalChatFormContext,
};
