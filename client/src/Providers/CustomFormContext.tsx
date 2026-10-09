import React, { createContext, PropsWithChildren, ReactElement, useContext, useMemo } from 'react';
import type {
  Control,
  // FieldErrors,
  FieldValues,
  UseFormReset,
  UseFormRegister,
  UseFormGetValues,
  UseFormHandleSubmit,
  UseFormSetValue,
} from 'react-hook-form';

interface FormContextValue<TFieldValues extends FieldValues> {
  register: UseFormRegister<TFieldValues>;
  control: Control<TFieldValues>;
  // errors: FieldErrors<TFieldValues>;
  getValues: UseFormGetValues<TFieldValues>;
  setValue: UseFormSetValue<TFieldValues>;
  handleSubmit: UseFormHandleSubmit<TFieldValues>;
  reset: UseFormReset<TFieldValues>;
}

function createFormContext<TFieldValues extends FieldValues>() {
  const context = createContext<FormContextValue<TFieldValues> | undefined>(undefined);

  const useCustomFormContext = (): FormContextValue<TFieldValues> => {
    const value = useContext(context);
    if (!value) {
      throw new Error('useCustomFormContext must be used within a CustomFormProvider');
    }
    return value;
  };

  /** Non-throwing variant for components that may render outside the provider
   *  (e.g. message content in Share/search views). */
  const useOptionalCustomFormContext = (): FormContextValue<TFieldValues> | undefined =>
    useContext(context);

  const CustomFormProvider = ({
    register,
    control,
    setValue,
    // errors,
    getValues,
    handleSubmit,
    reset,
    children,
  }: PropsWithChildren<FormContextValue<TFieldValues>>): ReactElement => {
    const value = useMemo(
      () => ({ register, control, getValues, setValue, handleSubmit, reset }),
      [register, control, setValue, getValues, handleSubmit, reset],
    );

    return <context.Provider value={value}>{children}</context.Provider>;
  };

  return { CustomFormProvider, useCustomFormContext, useOptionalCustomFormContext };
}

export type { FormContextValue };
export { createFormContext };
