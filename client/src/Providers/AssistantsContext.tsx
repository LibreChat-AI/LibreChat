import { createContext, useContext } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { defaultAssistantFormValues } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { AssistantForm } from '~/common';

type AssistantsContextType = UseFormReturn<AssistantForm>;

export const AssistantsContext = createContext<AssistantsContextType>({} as AssistantsContextType);

export function useAssistantsContext() {
  const context = useContext(AssistantsContext);

  if (context === undefined) {
    throw new Error('useAssistantsContext must be used within an AssistantsProvider');
  }

  return context;
}

export default function AssistantsProvider({ children }) {
  const methods = useForm<AssistantForm>({
    defaultValues: defaultAssistantFormValues,
  });

  return <FormProvider {...methods}>{children}</FormProvider>;
}
