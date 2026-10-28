import { cn } from '~/utils';

/**
 * The CI status dot that sits on the corner of the picture or icon it describes. The ring is
 * painted in the surface the dot sits on, so the caller names that surface.
 */
export default function CiDot({
  dotClass,
  ringClassName = 'ring-presentation',
}: {
  dotClass: string;
  ringClassName?: string;
}) {
  return (
    <span
      data-testid="pull-request-ci-dot"
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2',
        ringClassName,
        dotClass,
      )}
    />
  );
}
