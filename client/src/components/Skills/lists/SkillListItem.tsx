import { memo, useState, useMemo, useCallback } from 'react';
import { FixedSizeTree } from 'react-vtree';
import { useNavigate } from 'react-router-dom';
import { ScrollText, ChevronDown, ChevronRight, Folder, Pin } from 'lucide-react';
import type { FixedSizeNodeData, TreeWalkerValue, TreeWalker } from 'react-vtree';
import type { TSkillSummary, TSkillFile } from 'librechat-data-provider';
import { useListSkillFilesQuery } from '~/data-provider';
import { Collapse } from '~/components/ui';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface SkillListItemProps {
  skill: TSkillSummary;
  isActive: boolean;
  isExpanded: boolean;
  activeFile: string | null;
  onToggleExpand: (skillId: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Tree data model                                                            */
/* -------------------------------------------------------------------------- */

interface TreeEntry {
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: TreeEntry[];
}

interface FileNodeData extends FixedSizeNodeData {
  name: string;
  nodeType: 'file' | 'folder';
  path: string;
  depth: number;
  isLeaf: boolean;
}

interface NodeMeta {
  entry: TreeEntry;
  depth: number;
}

interface TreeItemCallbacks {
  onFileClick: (path: string) => void;
  onToggle: (id: string, isOpen: boolean) => void;
  activeFile: string | null;
}

const ITEM_SIZE = 28;
const MAX_HEIGHT = 350;

/** Build a nested tree from flat TSkillFile paths. Always includes SKILL.md. */
function buildFileTree(files: TSkillFile[]): TreeEntry[] {
  const root: TreeEntry[] = [];
  const folderMap = new Map<string, TreeEntry>();

  root.push({ name: 'SKILL.md', type: 'file', path: 'SKILL.md' });

  const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  for (const file of sorted) {
    const segments = file.relativePath.split('/').filter(Boolean);
    if (segments.length === 0) {
      continue;
    }
    if (segments.length === 1) {
      root.push({ name: segments[0], type: 'file', path: file.relativePath });
    } else {
      let parentList = root;
      let parentPath = '';
      for (let i = 0; i < segments.length - 1; i++) {
        const folderName = segments[i];
        const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
        let folder = folderMap.get(folderPath);
        if (!folder) {
          folder = { name: folderName, type: 'folder', path: folderPath, children: [] };
          folderMap.set(folderPath, folder);
          parentList.push(folder);
        }
        parentList = folder.children!;
        parentPath = folderPath;
      }
      parentList.push({
        name: segments[segments.length - 1],
        type: 'file',
        path: file.relativePath,
      });
    }
  }

  return root;
}

/** Count visible nodes for dynamic height calculation. */
function countVisible(entries: TreeEntry[], openIds: Set<string>): number {
  let n = 0;
  for (const entry of entries) {
    n++;
    if (entry.type === 'folder' && openIds.has(entry.path) && entry.children) {
      n += countVisible(entry.children, openIds);
    }
  }
  return n;
}

function getNodeData(entry: TreeEntry, depth: number): TreeWalkerValue<FileNodeData, NodeMeta> {
  return {
    data: {
      id: entry.path,
      isOpenByDefault: false,
      name: entry.name,
      nodeType: entry.type,
      path: entry.path,
      depth,
      isLeaf: entry.type === 'file',
    },
    entry,
    depth,
  };
}

/* -------------------------------------------------------------------------- */
/* Node renderer                                                              */
/* -------------------------------------------------------------------------- */

function FileTreeNode({
  data,
  isOpen,
  setOpen,
  style,
  treeData,
}: {
  style?: React.CSSProperties;
  data: FileNodeData;
  isOpen: boolean;
  setOpen: (state: boolean) => Promise<void>;
  treeData?: TreeItemCallbacks;
}) {
  const isFolder = data.nodeType === 'folder';
  const isFileActive = !isFolder && treeData?.activeFile === data.path;
  const indent = data.depth * 16 + (isFolder ? 8 : 24);

  return (
    <button
      type="button"
      style={{ ...style, paddingLeft: `${indent}px` }}
      onClick={(e) => {
        e.stopPropagation();
        if (isFolder) {
          const next = !isOpen;
          setOpen(next);
          treeData?.onToggle(data.id, next);
        } else {
          treeData?.onFileClick(data.path);
        }
      }}
      className={cn(
        'flex w-full select-none items-center gap-1.5 rounded-lg text-sm transition-colors',
        isFileActive
          ? 'bg-surface-active font-medium text-text-primary'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      )}
      aria-expanded={isFolder ? isOpen : undefined}
    >
      {isFolder && (
        <>
          <ChevronRight
            className={cn(
              'size-3 shrink-0 transition-transform duration-150',
              isOpen && 'rotate-90',
            )}
            aria-hidden="true"
          />
          <Folder className="size-3.5 shrink-0" aria-hidden="true" />
        </>
      )}
      <span className="min-w-0 truncate">{data.name}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Inline virtualized file tree                                               */
/* -------------------------------------------------------------------------- */

function InlineFileTree({
  files,
  activeFile,
  onFileClick,
}: {
  files: TSkillFile[];
  activeFile: string | null;
  onFileClick: (path: string) => void;
}) {
  const treeEntries = useMemo(() => buildFileTree(files), [files]);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  const visibleCount = useMemo(() => countVisible(treeEntries, openIds), [treeEntries, openIds]);

  const height = Math.min(visibleCount * ITEM_SIZE, MAX_HEIGHT);

  const handleToggle = useCallback((id: string, isOpen: boolean) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (isOpen) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const callbacks = useMemo<TreeItemCallbacks>(
    () => ({ onFileClick, onToggle: handleToggle, activeFile }),
    [onFileClick, handleToggle, activeFile],
  );

  type WalkerReturn = ReturnType<TreeWalker<FileNodeData, NodeMeta>>;

  const treeWalker = useMemo<TreeWalker<FileNodeData, NodeMeta>>(() => {
    const walker: TreeWalker<FileNodeData, NodeMeta> = function* (): WalkerReturn {
      for (const entry of treeEntries) {
        yield getNodeData(entry, 0);
      }
      while (true) {
        const parent: TreeWalkerValue<FileNodeData, NodeMeta> = yield;
        for (const child of parent.entry.children ?? []) {
          yield getNodeData(child, parent.depth + 1);
        }
      }
    };
    return walker;
  }, [treeEntries]);

  if (treeEntries.length === 0) {
    return null;
  }

  return (
    <FixedSizeTree<FileNodeData>
      treeWalker={treeWalker}
      itemSize={ITEM_SIZE}
      height={height}
      width="100%"
      itemData={callbacks}
    >
      {FileTreeNode}
    </FixedSizeTree>
  );
}

/* -------------------------------------------------------------------------- */
/* Main component                                                             */
/* -------------------------------------------------------------------------- */

function SkillListItem({
  skill,
  isActive,
  isExpanded,
  activeFile,
  onToggleExpand,
}: SkillListItemProps) {
  const navigate = useNavigate();
  const localize = useLocalize();

  // Fetch files for active skill (always, since cached fileCount may be stale)
  // or expanded skills. The response is small (metadata only, no content).
  const filesQuery = useListSkillFilesQuery(skill._id, {
    enabled: isActive || (skill.fileCount > 0 && isExpanded),
  });
  const files = useMemo(() => filesQuery.data?.files ?? [], [filesQuery.data]);
  const hasFiles = files.length > 0 || skill.fileCount > 0;
  const expanded = hasFiles && isExpanded;

  const handleSkillClick = useCallback(() => {
    navigate(`/skills/${skill._id}`);
    if (hasFiles && !isExpanded) {
      onToggleExpand(skill._id);
    }
  }, [navigate, skill._id, hasFiles, isExpanded, onToggleExpand]);

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleExpand(skill._id);
    },
    [skill._id, onToggleExpand],
  );

  const handleFileClick = useCallback(
    (path: string) => {
      navigate(`/skills/${skill._id}?file=${encodeURIComponent(path)}`);
    },
    [navigate, skill._id],
  );

  return (
    <div className="flex flex-col gap-px">
      {/* Skill row */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleSkillClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleSkillClick();
          }
        }}
        className={cn(
          'flex w-full cursor-pointer select-none items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm text-text-primary transition-colors',
          isActive && !activeFile && 'bg-surface-active',
          !isActive && 'hover:bg-surface-hover',
        )}
        aria-current={isActive ? 'true' : undefined}
        aria-expanded={hasFiles ? expanded : undefined}
      >
        <span className="flex size-6 shrink-0 items-center justify-center">
          <span className="flex size-6 items-center justify-center rounded-md border border-border-light bg-surface-primary shadow-sm">
            <ScrollText className="size-3.5 text-text-secondary" aria-hidden="true" />
          </span>
        </span>

        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate">{skill.name}</span>
          {skill.alwaysApply === true && (
            <Pin
              className="size-3 shrink-0 text-status-info"
              aria-label={localize('com_ui_skills_always_apply_pin_title')}
            />
          )}
        </span>

        {hasFiles && (
          <button
            type="button"
            onClick={handleChevronClick}
            className="-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-text-secondary hover:text-text-primary"
            aria-label="Toggle files"
            tabIndex={-1}
          >
            <ChevronDown
              className={cn(
                'size-3.5 transition-transform duration-200',
                !expanded && '-rotate-90',
              )}
            />
          </button>
        )}
      </div>

      {/* Inline file tree */}
      <Collapse open={expanded && hasFiles} className="ml-5">
        <InlineFileTree files={files} activeFile={activeFile} onFileClick={handleFileClick} />
      </Collapse>
    </div>
  );
}

export default memo(SkillListItem);
