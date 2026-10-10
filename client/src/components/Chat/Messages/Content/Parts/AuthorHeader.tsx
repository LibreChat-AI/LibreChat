import { memo } from 'react';
import type { ReactNode } from 'react';

/**
 * Re-attributes response content to its author mid-message. A `SteerPart`
 * renders a full user turn inside the response, so the parts that resume
 * after it need the author's icon and label restated. The message-level
 * header only renders once, above the first part. Sits on the same left
 * edge as the message body.
 */
const AuthorHeader = memo(function AuthorHeader({
  icon,
  label,
}: {
  icon: ReactNode;
  label: string;
}) {
  return (
    <div className="relative flex min-h-7 w-full items-center gap-2" data-testid="author-header">
      <div
        className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full"
        aria-hidden="true"
      >
        {icon}
      </div>
      <h2 className="text-text-primary min-w-0 truncate text-sm font-semibold select-none">
        {label}
      </h2>
    </div>
  );
});

export default AuthorHeader;
