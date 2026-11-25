import React, { useState, useCallback, useMemo, useRef } from 'react';
import debounce from 'lodash/debounce';
import type { SetterOrUpdater } from 'recoil';
import type { TSetOption } from '~/common';
import { defaultDebouncedDelay } from '~/common';

/** A custom hook that accepts a setOption function and an option key (e.g., 'title').
It manages a local state for the option value, a debounced setter function for that value,
and returns the local state value, its setter, and an onChange handler suitable for inputs. */
function useDebouncedInput<T = unknown>({
  setOption,
  setter,
  optionKey,
  initialValue,
  delay = defaultDebouncedDelay,
}: {
  setOption?: TSetOption;
  setter?: SetterOrUpdater<T>;
  optionKey?: string | number;
  initialValue: T;
  delay?: number;
}): [
  (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement> | T, numeric?: boolean) => void,
  T,
  SetterOrUpdater<T>,
  () => void,
] {
  const [value, setValue] = useState<T>(initialValue);

  /** The callbacks are read through refs so the debounced function itself stays
   *  stable. Neither is memoized by its caller: `setOption` is a plain arrow in
   *  useSetIndexOptions and the dynamic settings pass `setter: () => ({})`
   *  inline, so depending on them rebuilt the debouncer on every render. Each
   *  render then produced a fresh instance while the previous one kept its
   *  timer, which left `flush()` pointing at an instance with nothing pending
   *  and let a superseded value land after a correction. */
  const setOptionRef = useRef(setOption);
  const setterRef = useRef(setter);
  setOptionRef.current = setOption;
  setterRef.current = setter;

  /** A debounced function to call the passed setOption with the optionKey and new value. */
  const setDebouncedOption = useMemo(
    () =>
      debounce((newValue: T) => {
        const currentSetOption = setOptionRef.current;
        if (currentSetOption && optionKey != null) {
          /** T is the caller's field type; TSetOption is typed against the whole
           *  conversation union, which does not narrow per key. The previous
           *  form passed the setter to debounce directly and inherited the same
           *  looseness. */
          (currentSetOption(optionKey) as (value: T) => void)(newValue);
          return;
        }
        setterRef.current?.(newValue);
      }, delay),
    [optionKey, delay],
  );

  /** An onChange handler that updates the local state and the debounced option */
  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement> | T, numeric?: boolean) => {
      let newValue: T =
        typeof e !== 'object'
          ? e
          : ((e as React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>).target
              .value as unknown as T);
      // Handle numeric conversion only if value is not undefined and not empty string
      if (numeric === true && newValue !== undefined && newValue !== '') {
        newValue = Number(newValue) as unknown as T;
      }
      setValue(newValue);
      setDebouncedOption(newValue);
    },
    [setDebouncedOption],
  );
  /** Lets a caller commit a pending edit immediately, e.g. on blur, so a Save
   *  clicked in the same gesture does not read the pre-edit value. */
  const flush = useCallback(() => {
    setDebouncedOption.flush();
  }, [setDebouncedOption]);

  return [onChange, value, setValue, flush];
}

export default useDebouncedInput;
