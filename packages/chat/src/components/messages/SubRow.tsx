import { cn } from '@librechat/client';
import type { ReactNode, ReactElement } from 'react';

type TSubRowProps = {
  children: ReactNode;
  classes?: string;
  subclasses?: string;
  onClick?: () => void;
};

export default function SubRow({ children, classes = '', onClick }: TSubRowProps): ReactElement {
  return (
    <div
      className={cn('mt-1 flex justify-start gap-3 empty:hidden lg:flex', classes)}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
