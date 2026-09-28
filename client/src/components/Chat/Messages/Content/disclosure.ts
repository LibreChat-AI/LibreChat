import { createContext, useContext, useMemo } from 'react';
import { atom } from 'jotai';
import type { PrimitiveAtom } from 'jotai';

export type ReasoningDisclosures = Map<number, PrimitiveAtom<boolean | undefined>>;

/** Owned by one message, above the layouts that can move its reasoning. */
export const ReasoningDisclosureContext = createContext<ReasoningDisclosures | null>(null);

export function reasoningDisclosure(disclosures: ReasoningDisclosures, index: number) {
  let disclosure = disclosures.get(index);
  if (disclosure == null) {
    disclosure = atom<boolean | undefined>(undefined);
    disclosures.set(index, disclosure);
  }
  return disclosure;
}

export function useReasoningDisclosure(index: number) {
  const disclosures = useContext(ReasoningDisclosureContext);
  return useMemo(
    () =>
      disclosures == null
        ? atom<boolean | undefined>(undefined)
        : reasoningDisclosure(disclosures, index),
    [disclosures, index],
  );
}

/** Panel spacing is genuine feature layout, so it stays here. The chevron
 *  appearance lives in `@librechat/client` as `disclosureChevronVariants`. */
export const toolPanelSpacingClassName = 'mb-2 mt-0';

export type ToolDisclosures = Map<string, PrimitiveAtom<boolean | undefined>>;

/** Kept above part keys and activity layouts; never shared between message views. */
export const ToolDisclosureContext = createContext<ToolDisclosures | null>(null);
export const ToolDisclosureKeyContext = createContext<string | undefined>(undefined);

export function useToolDisclosure() {
  const disclosures = useContext(ToolDisclosureContext);
  const key = useContext(ToolDisclosureKeyContext);
  return useMemo(() => {
    if (disclosures == null || key == null) {
      return atom<boolean | undefined>(undefined);
    }
    let disclosure = disclosures.get(key);
    if (disclosure == null) {
      disclosure = atom<boolean | undefined>(undefined);
      disclosures.set(key, disclosure);
    }
    return disclosure;
  }, [disclosures, key]);
}
