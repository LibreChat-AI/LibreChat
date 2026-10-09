import { atom, PrimitiveAtom } from 'jotai';
import { NotificationSeverity } from '~/common';

export const chatDirectionAtom: PrimitiveAtom<string> & {
  init: string;
} = atom<string>('ltr');
export const fontSizeAtom: PrimitiveAtom<string> & {
  init: string;
} = atom<string>('text-base');

export type ToastState = {
  open: boolean;
  message: string;
  severity: NotificationSeverity;
  showIcon: boolean;
  /** Milliseconds until the toast closes itself, or `Infinity` to require a dismissal. */
  duration: number;
  /** Increments per shown toast, so each one gets its own close deadline. */
  id: number;
};

export const toastState: PrimitiveAtom<ToastState> & {
  init: ToastState;
} = atom<ToastState>({
  open: false,
  message: '',
  severity: NotificationSeverity.SUCCESS,
  showIcon: true,
  duration: 3000,
  id: 0,
});
