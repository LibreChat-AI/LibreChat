import { Search, X } from 'lucide-react';
import { Input } from '@librechat/client';
import { useLocalize } from '~/hooks';

interface ArtifactAppsSearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

const ArtifactAppsSearchBar = ({ value, onChange }: ArtifactAppsSearchBarProps) => {
  const localize = useLocalize();

  return (
    <div className="relative w-full max-w-4xl" role="search">
      <label htmlFor="artifact-search" className="sr-only">
        {localize('com_ui_artifact_apps_search_aria')}
      </label>
      <Input
        id="artifact-search"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={localize('com_ui_artifact_apps_search_placeholder')}
        className="h-12 rounded-xl border-border-medium bg-transparent pl-12 pr-12 text-lg text-text-primary shadow-md transition-[border-color,box-shadow] duration-200 placeholder:text-text-secondary focus:border-border-heavy focus:shadow-lg focus:ring-0"
        aria-label={localize('com_ui_artifact_apps_search_aria')}
        autoComplete="off"
        spellCheck="false"
      />
      <div className="absolute inset-y-0 left-0 flex items-center pl-4" aria-hidden="true">
        <Search className="size-5 text-text-secondary" />
      </div>
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="focus:ring-ring group absolute right-4 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2"
          aria-label={localize('com_ui_artifact_apps_clear_search')}
          title={localize('com_ui_artifact_apps_clear_search')}
        >
          <X
            className="size-5 text-text-secondary transition-colors duration-200 group-hover:text-text-primary"
            strokeWidth={2.5}
            aria-hidden="true"
          />
        </button>
      )}
    </div>
  );
};

export default ArtifactAppsSearchBar;
