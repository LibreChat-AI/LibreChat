import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

export function PaginationFooter({
  page,
  pages,
  isFetching,
  onPage,
}: {
  page: number;
  pages: number;
  isFetching: boolean;
  onPage: (page: number) => void;
}) {
  const localize = useLocalize();
  return (
    <div className="border-border-light text-text-secondary mt-3 flex items-center justify-between gap-3 border-t pt-3 text-sm">
      <span>{localize('com_insights_page_of', { page, pages })}</span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          {localize('com_ui_prev')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching || page >= pages}
          onClick={() => onPage(page + 1)}
        >
          {localize('com_ui_next')}
        </Button>
      </div>
    </div>
  );
}
