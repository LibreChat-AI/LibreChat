import { useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import useLocalize from '~/hooks/useLocalize';

export function NoImage() {
  return (
    <div className="border-border-medium flex h-full w-full items-center justify-center rounded-full border-2 border-dashed">
      <svg
        stroke="currentColor"
        fill="none"
        strokeWidth="2"
        viewBox="0 0 24 24"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-4xl"
        height="1em"
        width="1em"
        xmlns="http://www.w3.org/2000/svg"
      >
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </div>
  );
}

export const AssistantAvatar = ({
  url,
  progress = 1,
}: {
  url?: string;
  progress: number; // between 0 and 1
}) => {
  const radius = 55; // Radius of the SVG circle
  const circumference = 2 * Math.PI * radius;

  // Calculate the offset based on the loading progress
  const offset = circumference - progress * circumference;
  const circleCSSProperties = {
    transition: 'stroke-dashoffset 0.3s linear',
  };

  return (
    <div>
      <div className="relative h-20 w-20 overflow-hidden rounded-full">
        <img
          src={url}
          className="bg-avatar-placeholder h-full w-full rounded-full object-cover"
          alt="GPT"
          width="80"
          height="80"
          style={{ opacity: progress < 1 ? 0.4 : 1 }}
        />
        {progress < 1 && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/5 text-white">
            <svg width="120" height="120" viewBox="0 0 120 120" className="h-6 w-6">
              <circle
                className="origin-[50%_50%] -rotate-90 stroke-gray-400"
                strokeWidth="10"
                fill="transparent"
                r="55"
                cx="60"
                cy="60"
              />
              <circle
                className="origin-[50%_50%] -rotate-90 transition-[stroke-dashoffset]"
                stroke="currentColor"
                strokeWidth="10"
                strokeDasharray={`${circumference} ${circumference}`}
                strokeDashoffset={offset}
                fill="transparent"
                r="55"
                cx="60"
                cy="60"
                style={circleCSSProperties}
              />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
};

export function AvatarMenu({
  handleFileChange,
}: {
  handleFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const localize = useLocalize();

  const onItemClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    fileInputRef.current?.click();
  };

  return (
    <Popover.Portal>
      <Popover.Content
        className="dark:bg-gray-850 flex max-w-xs min-w-[100px] flex-col rounded-xl border border-gray-400 bg-white shadow-lg dark:border-gray-700 dark:text-white"
        sideOffset={5}
      >
        <div
          role="menuitem"
          className="group m-1.5 flex cursor-pointer gap-2 rounded p-2.5 text-sm hover:bg-gray-100 focus:ring-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 dark:hover:bg-gray-800 dark:hover:bg-white/5"
          tabIndex={-1}
          data-orientation="vertical"
          onClick={onItemClick}
        >
          {localize('com_ui_upload_image')}
        </div>
        {/* <Popover.Close
          role="menuitem"
          className="group m-1.5 flex cursor-pointer gap-2 rounded p-2.5 text-sm hover:bg-black/5 focus:ring-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 dark:hover:bg-white/5"
          tabIndex={-1}
          data-orientation="vertical"
        >
          Use DALL·E
        </Popover.Close> */}
        <input
          accept="image/png,.png,image/jpeg,.jpg,.jpeg,image/gif,.gif,image/webp,.webp"
          multiple={false}
          type="file"
          style={{ display: 'none' }}
          onChange={handleFileChange}
          ref={fileInputRef}
          tabIndex={-1}
        />
      </Popover.Content>
    </Popover.Portal>
  );
}
