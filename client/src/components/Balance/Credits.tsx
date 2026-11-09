import { useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { CircleGauge } from 'lucide-react';
import { SettingsTabValues } from 'librechat-data-provider';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
  TooltipAnchor,
} from '@librechat/client';
import useDirection, { inlineSide } from '~/hooks/Nav/useDirection';
import { openSettingsAtom } from '~/components/Nav/Settings';
import useBalanceSummary from '~/hooks/useBalanceSummary';
import { useAuthContext } from '~/hooks/AuthContext';
import useLocalize from '~/hooks/useLocalize';
import Summary from './Summary';

/** Account-wide credits live beside the avatar, independently of conversation context. */
export default function Credits({ mobile = false }: { mobile?: boolean }) {
  const localize = useLocalize();
  const side = inlineSide(useDirection(), 'end');
  const { isAuthenticated } = useAuthContext();
  const { enabled, state, currency } = useBalanceSummary();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openingSettings = useRef(false);
  const openSettings = useSetAtom(openSettingsAtom);
  if (!enabled || !isAuthenticated || state.status === 'empty') {
    return null;
  }

  const label = localize('com_ui_account_usage');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipAnchor
        side={side}
        description={label}
        render={
          <PopoverTrigger asChild>
            <Button
              ref={triggerRef}
              variant="nav"
              size="icon"
              className="size-9"
              aria-label={label}
              data-testid="account-usage-button"
            >
              <CircleGauge className="size-5" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
        }
      />
      <PopoverPortal>
        <PopoverContent
          side={mobile ? 'bottom' : side}
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label={label}
          className="w-80 max-w-[calc(100vw-1rem)]"
          onCloseAutoFocus={(event) => {
            if (openingSettings.current) {
              event.preventDefault();
              openingSettings.current = false;
            }
          }}
        >
          <div className="border-border-light border-b px-4 py-3">
            <p className="text-text-secondary text-sm">{label}</p>
          </div>
          <div className="p-4">
            <Summary state={state} currency={currency} compact />
          </div>
          <div className="border-border-light border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => {
                openingSettings.current = true;
                setOpen(false);
                openSettings({
                  tab: SettingsTabValues.ACCOUNT,
                  section: 'billing',
                  trigger: triggerRef.current,
                });
              }}
            >
              {localize('com_ui_manage_usage')}
            </Button>
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
