import { Plus } from 'lucide-react';
import { Button, FilterInput, useMediaQuery } from '@librechat/client';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { useLocalize } from '~/hooks';

type ProjectsNavBarProps = {
  onCreate: () => void;
  search: string;
  onSearchChange: (search: string) => void;
};

export default function ProjectsNavBar({ onCreate, search, onSearchChange }: ProjectsNavBarProps) {
  const localize = useLocalize();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  return (
    <header className="border-border-light bg-presentation sticky top-0 z-10 border-b">
      <div className="flex min-h-14 w-full flex-wrap items-center gap-2 px-4 py-2.5 md:min-h-16 md:flex-nowrap md:px-6">
        {isSmallScreen ? <OpenSidebar className="size-9 shrink-0" /> : null}
        <h1 className="sr-only">{localize('com_ui_projects')}</h1>
        <FilterInput
          inputId="projects-search"
          type="text"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          label={localize('com_ui_search_projects')}
          surface="presentation"
          containerClassName="order-last w-full min-w-0 md:order-none md:w-auto md:max-w-md md:flex-1"
        />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button type="button" variant="default" size="sm" onClick={onCreate} className="shrink-0">
            <Plus className="size-4" aria-hidden="true" />
            {localize('com_ui_new_project')}
          </Button>
        </div>
      </div>
    </header>
  );
}
