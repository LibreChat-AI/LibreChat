import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

export const showSkillsPopoverFamily = atomFamily((_index: string | number | null) => atom(false));
