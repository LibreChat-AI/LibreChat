import type { Atom, PrimitiveAtom } from 'jotai';
import type { atomFamily } from 'jotai/utils';

/** One atom per key, created on first read; `getParams`/`remove` let tests and teardown drop them. */
export type Family<
  Value,
  AtomType extends Atom<Value> = PrimitiveAtom<Value>,
  Param = string,
> = ReturnType<typeof atomFamily<Param, AtomType>>;
