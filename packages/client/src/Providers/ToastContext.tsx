import { createContext, useContext, ReactNode, Context } from 'react';
import { JSX } from 'react/jsx-runtime';
import useToast from '~/hooks/useToast';

type ToastContextType = {
  showToast: ReturnType<typeof useToast>['showToast'];
};

export const ToastContext: Context<ToastContextType> = createContext<ToastContextType>({
  showToast: () => undefined,
});

export function useToastContext(): ToastContextType {
  return useContext(ToastContext);
}

export default function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const { showToast } = useToast();

  return <ToastContext.Provider value={{ showToast }}>{children}</ToastContext.Provider>;
}
