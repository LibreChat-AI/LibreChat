import React, { useId } from 'react';
import { Label } from '@librechat/client';
import CategoryIcon from '../utils/CategoryIcon';
import { useLocalize } from '~/hooks';

export default function ListCard({
  category,
  name,
  snippet,
  onClick,
  children,
  icon,
}: {
  category: string;
  name: string;
  snippet: string;
  onClick?: () => void;
  children?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  const id = useId();
  const localize = useLocalize();
  const snippetId = `${id}-snippet`;
  const titleId = `${id}-title`;

  const ariaLabel = category
    ? localize('com_ui_prompt_group_button', { name, category })
    : localize('com_ui_prompt_group_button_no_category', { name });

  return (
    <div className="relative flex w-full cursor-pointer flex-col gap-2 rounded-xl px-3 pt-3 pb-4 text-start align-top text-[15px]">
      {onClick && (
        <button
          type="button"
          className="focus-visible:ring-ring-primary absolute inset-0 z-0 rounded-xl focus:outline-hidden focus-visible:ring-2"
          onClick={onClick}
          aria-label={ariaLabel}
          aria-describedby={snippetId}
        />
      )}
      <div className="flex w-full justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-row items-center gap-2 overflow-hidden">
          <CategoryIcon category={category} className="icon-md shrink-0" aria-hidden="true" />
          <Label
            id={titleId}
            className="text-text-primary min-w-0 truncate text-sm font-medium select-none"
            title={name}
          >
            {name}
          </Label>
          {icon}
        </div>
        <div className="relative z-10">{children}</div>
      </div>
      <div
        id={snippetId}
        className="ellipsis text-text-secondary max-w-full pt-1 text-sm text-balance select-none"
      >
        {snippet}
      </div>
    </div>
  );
}
