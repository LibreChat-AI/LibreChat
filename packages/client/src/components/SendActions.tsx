import * as Ariakit from '@ariakit/react';
import type { ReactElement, ReactNode } from 'react';
import type { JSX } from 'react/jsx-runtime';

/** One alternate way to submit, offered from the send control rather than
 *  standing beside the field. */
export interface SendAction {
  key: string;
  label: string;
  /** The chord that still reaches this action, when one does. Omitted rather
   *  than guessed: advertising a key that has been rebound, yielded to a global
   *  shortcut, or disabled is worse than advertising none. */
  kbd?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}

const ROW_CLASS =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-text-primary hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return (
    <kbd className="ml-auto rounded-md bg-surface-tertiary px-1.5 py-0.5 font-sans text-xs text-text-secondary">
      {children}
    </kbd>
  );
}

/**
 * The alternate submissions a send control offers on hover or focus.
 *
 * Every chat surface that can submit more than one way shows the same list in
 * the same place — hung off the send control, never lined up beside the field,
 * where a row would repeat what submitting already does. The anchor is passed
 * in whole so each host keeps its own button: its ref (Enter's synthetic click
 * routes through it), its submit type, and its own identifying attributes.
 *
 * With no actions the anchor renders alone, so a host can pass a list that is
 * sometimes empty without branching.
 */
export function SendActions({
  anchor,
  actions,
  label,
}: {
  anchor: ReactElement;
  actions: SendAction[];
  label: string;
}): JSX.Element {
  if (actions.length === 0) return anchor;
  return (
    <Ariakit.HovercardProvider placement="top-end" showTimeout={100} hideTimeout={150}>
      <Ariakit.HovercardAnchor render={anchor} />
      <Ariakit.Hovercard
        portal
        gutter={8}
        unmountOnHide
        aria-label={label}
        className="z-50 min-w-[12rem] rounded-xl border border-border-light bg-surface-secondary p-1.5 text-text-primary shadow-lg outline-none"
      >
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={ROW_CLASS}
            aria-disabled={action.disabled === true}
            onClick={action.disabled === true ? undefined : action.onClick}
          >
            {action.icon}
            {action.label}
            {/* A disabled row's action refuses its chord too, so no hint. */}
            {action.kbd != null && action.disabled !== true && <Kbd>{action.kbd}</Kbd>}
          </button>
        ))}
      </Ariakit.Hovercard>
    </Ariakit.HovercardProvider>
  );
}

export default SendActions;
