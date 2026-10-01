import { useEffect, useMemo, useState } from 'react';
import { Button } from '@librechat/client';
import * as Popover from '@radix-ui/react-popover';
import { CalendarDays, ChevronDown } from 'lucide-react';

type DateRangePickerLabels = {
  apply: string;
  cancel: string;
  endDate: string;
  invalidRange: string;
  startDate: string;
};

type LocalizedDateRangePickerProps = {
  endDate?: Date;
  futureDatesDisabled?: boolean;
  labels: DateRangePickerLabels;
  locale: string;
  maxRangeLength?: number;
  onSelectDateRange: (startDate: Date, endDate: Date) => void;
  placeholder: string;
  startDate?: Date;
};

const millisecondsPerDay = 24 * 60 * 60 * 1000;

function toDateInputValue(date?: Date) {
  if (!date) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateInput(value: string, endOfDay = false) {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) {
    return undefined;
  }

  return endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day);
}

function addCalendarDays(value: string, days: number) {
  const date = parseDateInput(value);
  if (!date) {
    return '';
  }
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
}

function calendarDayDifference(startDate: Date, endDate: Date) {
  const start = Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const end = Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  return Math.round((end - start) / millisecondsPerDay);
}

function earliestDate(...dates: Array<string | undefined>) {
  return dates.filter((date): date is string => Boolean(date)).sort()[0];
}

export default function LocalizedDateRangePicker({
  endDate,
  futureDatesDisabled = false,
  labels,
  locale,
  maxRangeLength = -1,
  onSelectDateRange,
  placeholder,
  startDate,
}: LocalizedDateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [pendingStartDate, setPendingStartDate] = useState(() => toDateInputValue(startDate));
  const [pendingEndDate, setPendingEndDate] = useState(() => toDateInputValue(endDate));
  const today = toDateInputValue(new Date());

  useEffect(() => {
    if (!isOpen) {
      setPendingStartDate(toDateInputValue(startDate));
      setPendingEndDate(toDateInputValue(endDate));
    }
  }, [endDate, isOpen, startDate]);

  const formattedRange = useMemo(() => {
    if (!startDate || !endDate) {
      return placeholder;
    }

    const formatter = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    return `${formatter.format(startDate)} - ${formatter.format(endDate)}`;
  }, [endDate, locale, placeholder, startDate]);

  const parsedStartDate = parseDateInput(pendingStartDate);
  const parsedEndDate = parseDateInput(pendingEndDate, true);
  const rangeLength =
    parsedStartDate && parsedEndDate
      ? calendarDayDifference(parsedStartDate, parsedEndDate)
      : undefined;
  const matchesSelectedRange =
    pendingStartDate === toDateInputValue(startDate) &&
    pendingEndDate === toDateInputValue(endDate);
  const selectedRangeDuration =
    startDate && endDate ? endDate.getTime() - startDate.getTime() : undefined;
  const selectedRangeIsValid =
    matchesSelectedRange &&
    selectedRangeDuration != null &&
    selectedRangeDuration >= 0 &&
    (maxRangeLength < 0 || selectedRangeDuration <= maxRangeLength * millisecondsPerDay);
  const isValidRange =
    rangeLength != null &&
    rangeLength >= 0 &&
    (maxRangeLength < 0 || rangeLength < maxRangeLength || selectedRangeIsValid) &&
    (!futureDatesDisabled || pendingEndDate <= today);
  const latestEndDate =
    maxRangeLength > 0 && pendingStartDate
      ? addCalendarDays(pendingStartDate, maxRangeLength - 1)
      : undefined;
  const endDateMax = earliestDate(latestEndDate, futureDatesDisabled ? today : undefined);

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setPendingStartDate(toDateInputValue(startDate));
      setPendingEndDate(toDateInputValue(endDate));
    }
    setIsOpen(open);
  };

  const handleApply = () => {
    if (!parsedStartDate || !parsedEndDate || !isValidRange) {
      return;
    }
    if (matchesSelectedRange) {
      setIsOpen(false);
      return;
    }
    onSelectDateRange(parsedStartDate, parsedEndDate);
    setIsOpen(false);
  };

  return (
    <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <Button variant="outline" className="w-full min-w-0 justify-start px-3">
          <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">{formattedRange}</span>
          <ChevronDown className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="border-border-light bg-surface-primary text-text-primary z-50 w-[320px] max-w-[calc(100vw-2rem)] rounded-lg border p-4 shadow-lg"
        >
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-sm">{labels.startDate}</span>
                <input
                  type="date"
                  lang={locale}
                  max={futureDatesDisabled ? today : undefined}
                  value={pendingStartDate}
                  onChange={(event) => setPendingStartDate(event.target.value)}
                  className="border-border-medium bg-surface-primary text-text-primary focus:border-border-heavy h-9 min-w-0 rounded-md border px-2 text-sm outline-hidden"
                />
              </label>
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-sm">{labels.endDate}</span>
                <input
                  type="date"
                  lang={locale}
                  min={pendingStartDate || undefined}
                  max={endDateMax}
                  value={pendingEndDate}
                  onChange={(event) => setPendingEndDate(event.target.value)}
                  className="border-border-medium bg-surface-primary text-text-primary focus:border-border-heavy h-9 min-w-0 rounded-md border px-2 text-sm outline-hidden"
                />
              </label>
            </div>
            {!isValidRange && pendingStartDate && pendingEndDate && (
              <span className="text-status-error text-sm">{labels.invalidRange}</span>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setIsOpen(false)}>
                {labels.cancel}
              </Button>
              <Button size="sm" disabled={!isValidRange} onClick={handleApply}>
                {labels.apply}
              </Button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
