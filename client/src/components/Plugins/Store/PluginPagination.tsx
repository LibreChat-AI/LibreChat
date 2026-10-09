import React from 'react';
import { useLocalize } from '~/hooks';

type TPluginPaginationProps = {
  currentPage: number;
  maxPage: number;
  onChangePage: (page: number) => void;
};

const PluginPagination: React.FC<TPluginPaginationProps> = ({
  currentPage,
  maxPage,
  onChangePage,
}) => {
  const localize = useLocalize();
  const pages = [...Array(maxPage).keys()].map((i) => i + 1);

  const handlePageChange = (page: number) => {
    if (page < 1 || page > maxPage) {
      return;
    }
    onChangePage(page);
  };

  return (
    <div className="flex gap-2 text-sm text-text-secondary">
      <div
        role="button"
        tabIndex={0}
        aria-label="Previous page"
        onClick={() => handlePageChange(currentPage - 1)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            onChangePage(currentPage - 1);
          }
        }}
        className={`flex cursor-default items-center text-sm ${
          currentPage === 1
            ? 'text-text-secondary opacity-50'
            : 'text-text-secondary hover:text-text-primary'
        }`}
        style={{ userSelect: 'none' }}
      >
        <svg
          stroke="currentColor"
          fill="none"
          strokeWidth="2"
          viewBox="0 0 24 24"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          height="1em"
          width="1em"
          xmlns="http://www.w3.org/2000/svg"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        {localize('com_ui_prev')}
      </div>
      {pages.map((page) => (
        <div
          role="button"
          key={page}
          tabIndex={0}
          className={`flex h-5 w-5 items-center justify-center text-sm ${
            currentPage === page
              ? 'text-link hover:text-link'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          style={{ userSelect: 'none' }}
          onClick={() => onChangePage(page)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              onChangePage(page);
            }
          }}
        >
          {page}
        </div>
      ))}
      <div
        role="button"
        aria-label="Next page"
        tabIndex={0}
        onClick={() => handlePageChange(currentPage + 1)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            onChangePage(currentPage + 1);
          }
        }}
        className={`flex cursor-default items-center text-sm ${
          currentPage === maxPage
            ? 'text-text-secondary opacity-50'
            : 'text-text-secondary hover:text-text-primary'
        }`}
        style={{ userSelect: 'none' }}
      >
        {localize('com_ui_next')}
        <svg
          stroke="currentColor"
          fill="none"
          strokeWidth="2"
          viewBox="0 0 24 24"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          height="1em"
          width="1em"
          xmlns="http://www.w3.org/2000/svg"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </div>
    </div>
  );
};

export default PluginPagination;
