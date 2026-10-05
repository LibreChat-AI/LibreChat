import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import {
  Button,
  Input,
  Label,
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
} from '@librechat/client';
import { cn } from '~/utils';
import { useCropsClient } from '~/hooks/useCrops';
import placeholderImage from '../../../public/assets/place-holder-image.jpg';

// Swap for wherever your static fallback image actually lives (public/assets, CDN, etc.)
const DEFAULT_CROP_IMAGE_URL = placeholderImage;

interface CropPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: string[];
  onSelectionChange: (crops: string[]) => void;
  /** Crop names to hide entirely from the list (e.g. crops already chosen as primary). */
  excludeValues?: string[];
  max?: number;
  mode?: 'multi' | 'single';
  title?: string;
}

export function CropPickerModal({
  open,
  onOpenChange,
  selected,
  onSelectionChange,
  max = 0,
  mode = 'multi',
  title = 'Select crops',
}: CropPickerModalProps) {
  const [query, setQuery] = useState('');
  const [showOther, setShowOther] = useState(false);
  const [otherText, setOtherText] = useState('');

  const { data: crops = [], isLoading, isError } = useCropsClient();

  const allOptions = useMemo(
    () => crops.map((c) => ({ value: c.name, label: c.name, imageUrl: c.imageUrl })),
    [crops],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return allOptions;
    const q = query.toLowerCase();
    return allOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [query, allOptions]);

  function toggleCrop(value: string) {
    if (selected.includes(value)) {
      onSelectionChange(selected.filter((c) => c !== value));
    } else {
      if (mode === 'single') {
        onSelectionChange([value]);
        handleClose();
        return;
      }
      if (max > 0 && selected.length >= max) return;
      onSelectionChange([...selected, value]);
    }
  }

  function confirmOther() {
    const v = otherText.trim();
    if (!v) return;
    if (!selected.includes(v) && !(max > 0 && selected.length >= max)) {
      onSelectionChange([...selected, v]);
    }
    handleClose();
  }

  function handleClose() {
    setQuery('');
    setShowOther(false);
    setOtherText('');
    onOpenChange(false);
  }

  return (
    <OGDialog open={open} onOpenChange={handleClose}>
      <OGDialogContent
        className={cn(
          'flex max-h-[92dvh] w-11/12 max-w-2xl flex-col p-0 sm:max-h-[85vh] sm:p-0',
        )}
      >
        <OGDialogHeader className="shrink-0 border-b border-border-light px-4 py-3">
          <OGDialogTitle className="text-sm font-semibold sm:text-base">{title}</OGDialogTitle>
        </OGDialogHeader>

        <div className="shrink-0 px-4 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => { setQuery(e.target.value); setShowOther(false); }}
              placeholder="Search crops…"
              className="rounded-full bg-surface-tertiary pl-9"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {isLoading && (
            <p className="py-8 text-center text-xs text-text-tertiary sm:text-sm">Loading crops…</p>
          )}

          {!isLoading && isError && (
            <p className="py-8 text-center text-xs text-red-500 sm:text-sm">
              Failed to load crops. Please try again.
            </p>
          )}

          {!isLoading && !isError && showOther && (
            <div className="space-y-3 px-2 py-3">
              <Label htmlFor="other-crop-manual">Enter crop name</Label>
              <Input
                id="other-crop-manual"
                autoFocus
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder="e.g. exotic mushroom"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmOther(); } }}
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => { setShowOther(false); setOtherText(''); }}>
                  Back
                </Button>
                <Button type="button" disabled={!otherText.trim()} onClick={confirmOther}>
                  Use this crop
                </Button>
              </div>
            </div>
          )}

          {!isLoading && !isError && !showOther && filtered.length === 0 && (
            <p className="py-8 text-center text-xs text-text-tertiary sm:text-sm">
              No crops match your search
            </p>
          )}

          {!isLoading && !isError && !showOther && filtered.length > 0 && (
            <div className="xs:grid-cols-4 grid grid-cols-3 gap-x-2 gap-y-4 sm:gap-y-5">
              {filtered.map((c) => {
                const isSelected = selected.includes(c.value);
                return (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => toggleCrop(c.value)}
                    disabled={max > 0 && !isSelected && selected.length >= max}
                    className="flex flex-col items-center gap-1.5 disabled:opacity-40"
                    aria-pressed={isSelected}
                  >
                    <div className="relative">
                      <div
                        className={cn(
                          'flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border-2 transition-colors sm:h-20 sm:w-20',
                          isSelected
                            ? 'border-green-500'
                            : 'border-border-light hover:border-green-300',
                        )}
                      >
                        <img
                          src={c.imageUrl || DEFAULT_CROP_IMAGE_URL}
                          alt={c.label}
                          loading="lazy"
                          className="h-full w-full rounded-full object-cover"
                          onError={(e) => {
                            // Covers a stored imageUrl that 404s / is unreachable, not just a missing one.
                            const img = e.currentTarget as HTMLImageElement;
                            if (img.src !== DEFAULT_CROP_IMAGE_URL) img.src = DEFAULT_CROP_IMAGE_URL;
                          }}
                        />
                      </div>
                      {isSelected && (
                        <div className="absolute -bottom-0.5 -right-0.5 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-green-500 shadow">
                          <svg className="h-3.5 w-3.5 text-white" viewBox="0 0 12 12" fill="none">
                            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      )}
                    </div>
                    <span
                      className={cn(
                        'line-clamp-2 text-center text-[11px] leading-tight sm:text-xs',
                        isSelected
                          ? 'font-semibold text-green-700 dark:text-green-300'
                          : 'font-medium text-text-primary',
                      )}
                    >
                      {c.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {!showOther && (
          <div className="shrink-0 border-t border-border-light px-4 py-3">
            <button
              type="button"
              onClick={() => setShowOther(true)}
              className="flex w-full items-center justify-center rounded-md px-3 py-2 text-center text-xs font-medium text-green-700 hover:bg-surface-tertiary dark:text-green-300 sm:text-sm"
            >
              Can't find your crop? Enter manually
            </button>
          </div>
        )}

        {mode === 'multi' && selected.length > 0 && (
          <div className="shrink-0 border-t border-border-light bg-surface-primary px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-text-tertiary sm:text-sm">
                {selected.length} selected{max > 0 ? ` / ${max} max` : ''}
              </p>
              <Button onClick={handleClose} className="bg-green-600 hover:bg-green-700">
                Done
              </Button>
            </div>
          </div>
        )}
      </OGDialogContent>
    </OGDialog>
  );
}