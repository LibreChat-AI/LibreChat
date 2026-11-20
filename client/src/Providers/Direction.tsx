import { useTranslation } from 'react-i18next';
import * as RadixToast from '@radix-ui/react-toast';
import { DirectionProvider, useDirection } from '@radix-ui/react-direction';
import type { ReactNode } from 'react';

/**
 * Radix primitives read their direction from this context, never from `<html dir>`, and fall back
 * to `ltr`. Without it Tabs, Select and menus render `dir="ltr"` subtrees and map arrow keys as LTR
 * inside a right-to-left interface.
 */
export default function Direction({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return <DirectionProvider dir={i18n.dir()}>{children}</DirectionProvider>;
}

/** Swiping a toast away runs toward the inline end, which is the left edge in a right-to-left UI. */
export function ToastSwipeProvider({ children }: { children: ReactNode }) {
  const dir = useDirection();
  return (
    <RadixToast.Provider swipeDirection={dir === 'rtl' ? 'left' : 'right'}>
      {children}
    </RadixToast.Provider>
  );
}
