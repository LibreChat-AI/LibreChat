import { createContext, useContext, useEffect, useMemo } from 'react';
import { atom, useAtom } from 'jotai';
import { useRecoilValue } from 'recoil';
import type { PrimitiveAtom } from 'jotai';
import store from '~/store';

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

/** Set by a tool group or activity phase holding exactly one tool call: its
 *  header is already the summary, so a second collapsed row inside it adds a
 *  click without adding information. `undefined` means no enclosing phase has
 *  decided, so a group falls back to its own call count; a phase's decision
 *  wins over the groups inside it. */
export const SoleToolContext = createContext<boolean | undefined>(undefined);

/** Set by a tool group for its own rows: true when the group holds exactly one
 *  tool call, whatever the phase around it holds. `SoleToolContext` lets the
 *  phase decide whether a card opens by default; this one decides whether the
 *  card's own row is redundant under the group header it sits beneath. */
export const LoneGroupContext = createContext<boolean>(false);

/** Whether a tool card opens by default: the user's "auto-expand tools"
 *  preference, or being the only call inside its group. */
export function useToolAutoExpand() {
  const autoExpand = useRecoilValue(store.autoExpandTools);
  const soleTool = useContext(SoleToolContext);
  return autoExpand || soleTool === true;
}

/** Asks the enclosing tool-call part to load its stored content in place of a server preview.
 *  `null` outside a part that holds a preview. */
export const ToolContentRequestContext = createContext<(() => void) | null>(null);

/** True while the enclosing part still shows a server preview, so content actions (copy) would
 *  hand out shortened text. False outside a previewed part. */
export const ToolContentPendingContext = createContext(false);

export function useToolContentPending(): boolean {
  return useContext(ToolContentPendingContext);
}

/** Requests the part's full content while `active`: its card is open or its panel is showing. */
export function useToolContentRequest(active: boolean) {
  const request = useContext(ToolContentRequestContext);
  useEffect(() => {
    if (active) {
      request?.();
    }
  }, [active, request]);
}

/** A tool card's disclosure. The reader's explicit choice lives in the
 *  per-tool atom, so it survives the card remounting when a live batch
 *  regroups. Until they choose, the card follows `useToolAutoExpand` and
 *  closes again if a sole call's group gains a second call. */
export function useToolExpansion(canExpand: boolean) {
  const autoExpand = useToolAutoExpand();
  const [override, setOverride] = useAtom(useToolDisclosure());
  const expanded = override ?? (autoExpand && canExpand);
  useToolContentRequest(expanded);
  return [expanded, setOverride] as const;
}
