import React from 'react';
import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

type TPagesProps = {
  pages: number;
  pageNumber: number;
  setPageNumber: (pageNumber: number) => void;
  nextPage: () => Promise<void>;
  previousPage: () => Promise<void>;
};

export default function Pages({
  pageNumber,
  pages,
  nextPage,
  previousPage,
  setPageNumber,
}: TPagesProps) {
  const localize = useLocalize();
  const clickHandler =
    (func: () => Promise<void>) => async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      await func();
    };

  if (pageNumber > pages) {
    setPageNumber(pages);
  }

  return pageNumber == 1 && pages == 1 ? null : (
    <div className="m-auto mb-2 mt-4 flex items-center justify-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        aria-label={localize('com_ui_prev')}
        onClick={clickHandler(previousPage)}
        className={
          'm-auto flex gap-2 text-text-primary disabled:text-text-tertiary' +
          (pageNumber <= 1 ? ' hidden-visibility' : '')
        }
        disabled={pageNumber <= 1}
      >
        &lt;
      </Button>
      <span className="flex-none text-text-tertiary">
        {pageNumber} / {pages}
      </span>
      <Button
        variant="ghost"
        size="sm"
        aria-label={localize('com_ui_next')}
        onClick={clickHandler(nextPage)}
        className={
          'm-auto flex gap-2 text-text-primary disabled:text-text-tertiary' +
          (pageNumber >= pages ? ' hidden-visibility' : '')
        }
        disabled={pageNumber >= pages}
      >
        &gt;
      </Button>
    </div>
  );
}
