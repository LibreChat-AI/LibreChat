import { useState } from 'react';
import { EmptyState } from '@librechat/client';
import { useSearchParams } from 'react-router-dom';
import { ChevronRight, Sparkles } from 'lucide-react';
import type { TSkillSummary } from 'librechat-data-provider';
import SkillListItem from './SkillListItem';
import { Collapse } from '~/components/ui';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface SkillListProps {
  skills: TSkillSummary[];
  activeSkillId?: string;
  sectionOpen: boolean;
  onSectionOpenChange: (open: boolean) => void;
}

/** Collapsible skill list. Active/inactive toggling lives in the detail view. */
export default function SkillList({
  skills,
  activeSkillId,
  sectionOpen,
  onSectionOpenChange,
}: SkillListProps) {
  const localize = useLocalize();
  const [searchParams] = useSearchParams();
  const activeFile = searchParams.get('file');
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(activeSkillId ?? null);

  return (
    <div className="flex flex-col gap-px">
      {/* Section header */}
      <div className="flex items-center justify-between px-2 pb-2">
        <button
          type="button"
          onClick={() => onSectionOpenChange(!sectionOpen)}
          className="flex cursor-pointer items-center gap-1.5"
          aria-expanded={sectionOpen}
        >
          <ChevronRight
            className={cn(
              'text-text-secondary size-3 shrink-0 transition-transform duration-200',
              sectionOpen ? 'rotate-90' : 'rtl:rotate-180',
            )}
            aria-hidden="true"
          />
          <span className="text-text-secondary text-xs">{localize('com_ui_my_skills')}</span>
        </button>
      </div>

      {/* Skill items */}
      <Collapse open={sectionOpen}>
        <div className="flex flex-col gap-px">
          {skills.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={localize('com_ui_skills_empty')}
              description={localize('com_ui_skills_empty_hint')}
            />
          ) : (
            skills.map((skill) => (
              <SkillListItem
                key={skill._id}
                skill={skill}
                isActive={skill._id === activeSkillId}
                isExpanded={skill._id === expandedSkillId}
                activeFile={skill._id === activeSkillId ? activeFile : null}
                onToggleExpand={(id) => setExpandedSkillId((prev) => (prev === id ? null : id))}
              />
            ))
          )}
        </div>
      </Collapse>
    </div>
  );
}
