import type {
  ChangeEvent,
  CSSProperties,
  Dispatch,
  ReactNode,
  Ref,
  RefObject,
  SetStateAction,
} from 'react';
import type { EndpointFileConfig, TConversation, TFile } from 'librechat-data-provider';
import type { ExtendedFile } from '../core/files';

/** A section of the composer palette's catalog. */
export type PaletteSection = 'tool' | 'skill' | 'mcp';

/** A "Show all" dialog the palette can hand the list over to. */
export type PaletteCatalogSection = 'skill' | 'mcp' | 'files';

/** A refinement drawn on a palette row, such as a tool's configure action. */
export interface PaletteModeView {
  id: string;
  label: string;
  active: boolean;
  onSelect: () => void;
  icon?: ReactNode;
}

/** Connection state drawn on a row. `tone` is a semantic status class. */
export interface PaletteStatusView {
  label: string;
  tone: string;
}

/**
 * One catalog row the palette can list. Tools, skills and servers share this shape; the host
 * builds it from app data and the palette only searches, sorts and draws it.
 */
export interface PaletteEntryView {
  key: string;
  itemType: string;
  itemId: string;
  label: string;
  description?: string;
  icon: ReactNode;
  section: PaletteSection;
  active: boolean;
  favoritable?: boolean;
  onSelect: () => void;
  modes?: PaletteModeView[];
  status?: PaletteStatusView;
}

/** One upload destination. */
export interface PaletteAttachView {
  id: string;
  label: string;
  icon: ReactNode;
  /** A primary destination stays visible when the rest are folded. */
  primary?: boolean;
  onSelect: () => void;
}

/** What the palette tells its host while it is asking for rows. */
export interface PaletteSourcesInput {
  index: number;
  /** The popup is mounted, including through its leave transition. */
  mounted: boolean;
  open: boolean;
  search: string;
  canAttach: boolean;
  catalog: PaletteCatalogSection | null;
  closeCatalog: () => void;
  catalogReturnRef: RefObject<HTMLElement | null>;
  agentId?: string | null;
  endpoint?: string | null;
  endpointType?: string;
  endpointFileConfig?: EndpointFileConfig;
  useResponsesApi?: boolean;
  conversationId: string;
  conversation: TConversation | null;
  files: Map<string, ExtendedFile>;
  setFiles: (update: SetStateAction<Map<string, ExtendedFile>>) => void;
  setFilesLoading: Dispatch<SetStateAction<boolean>>;
  /** Catalog rows, including the fields only the show-all dialog reads. */
  entries: readonly PaletteEntryView[];
}

/** Data and dialogs the palette cannot load itself. */
export interface PaletteSources {
  /** Translates a key. A method so a host's narrower key union still fits. */
  localize(phraseKey: string, options?: { 0?: string | number }): string;
  favoriteKeys: ReadonlySet<string>;
  toggleFavorite(itemType: string, itemId: string): void;
  attachEntries: readonly PaletteAttachView[];
  fileInputRef: Ref<HTMLInputElement>;
  onFileChange(event: ChangeEvent<HTMLInputElement>): void;
  recentFiles: readonly TFile[];
  attachFile(file: TFile): void;
  /** The sections whose full list the host shows in a "Show all" dialog, drawn through
   *  `overlays`. A section outside it has no dialog to hand over to, so the palette lists it whole
   *  instead of capping it behind a button that opens nothing. */
  catalogs: readonly PaletteCatalogSection[];
  /** The upload picker dialogs and the show-all catalog. */
  overlays: ReactNode;
}

/** The virtualized list drops its row cache through this. */
export interface PaletteListHandle {
  recomputeRowHeights: (index?: number) => void;
}

/** What the palette gives the host's windowed list. */
export interface PaletteListProps {
  listRef: Ref<PaletteListHandle | null>;
  rowCount: number;
  rowHeight: (info: { index: number }) => number;
  rowRenderer: (info: { index: number; key: string; style: CSSProperties }) => ReactNode;
  height: number;
  scrollToIndex?: number;
  id: string;
  ariaLabel: string;
  className?: string;
}

const NO_FAVORITES: ReadonlySet<string> = new Set();
const EMPTY_FILE_INPUT: RefObject<HTMLInputElement> = { current: null };

const EMPTY_PALETTE_SOURCES: PaletteSources = {
  localize: (phraseKey, options) =>
    options?.['0'] != null ? `${phraseKey}:${options['0']}` : phraseKey,
  favoriteKeys: NO_FAVORITES,
  toggleFavorite: () => undefined,
  attachEntries: [],
  fileInputRef: EMPTY_FILE_INPUT,
  onFileChange: () => undefined,
  recentFiles: [],
  attachFile: () => undefined,
  catalogs: [],
  overlays: null,
};

/** Sources for a host that has no catalog: the palette still opens, with nothing to list but the
 *  rows its caller passed. The same object every time, so a list keyed on it does not rebuild. */
export function emptyPaletteSources(): PaletteSources {
  return EMPTY_PALETTE_SOURCES;
}
