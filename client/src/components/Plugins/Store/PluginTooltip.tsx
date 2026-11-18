import { HoverCardPortal, HoverCardContent } from '@librechat/client';

type TPluginTooltipProps = {
  content: string;
  position: 'top' | 'bottom' | 'left' | 'right';
};

function PluginTooltip({ content, position }: TPluginTooltipProps) {
  return (
    <HoverCardPortal>
      <HoverCardContent side={position} className="w-80">
        <div className="space-y-2">
          <div className="text-text-secondary text-sm">{content}</div>
        </div>
      </HoverCardContent>
    </HoverCardPortal>
  );
}

export default PluginTooltip;
