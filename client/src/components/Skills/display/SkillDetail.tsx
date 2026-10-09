import React, { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { Button, TooltipAnchor } from '@librechat/client';
import { User, Pencil, Calendar, EarthIcon } from 'lucide-react';
import type { TSkill } from 'librechat-data-provider';
import { useLocalize, useAuthContext, useSkillPermissions, useSkillActiveState } from '~/hooks';
import SkillMarkdownRenderer from './SkillMarkdownRenderer';
import { ShareSkill, SkillToggle } from '../buttons';
import DeleteSkill from '../dialogs/DeleteSkill';
import { parseFrontmatter } from '../utils';
import ViewToggle from './ViewToggle';

interface SkillDetailProps {
  skill: TSkill;
  onEdit?: () => void;
  onDelete?: () => void;
}

const SKIP_KEYS = new Set(['name', 'description']);

export default function SkillDetail({ skill, onEdit, onDelete }: SkillDetailProps) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const permissions = useSkillPermissions(skill);
  const { isActive, toggle } = useSkillActiveState();
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');
  const skillEnabled = isActive(skill);

  const isPublic = skill.isPublic === true;
  const isShared = skill.author !== user?.id && Boolean(skill.authorName);
  const addedBy = isShared ? skill.authorName : localize('com_ui_you');
  const updatedDate = skill.updatedAt
    ? format(new Date(skill.updatedAt), 'MMM d, yyyy')
    : undefined;

  const { fields: frontmatterFields, body: cleanBody } = useMemo(
    () => parseFrontmatter(skill.body ?? '', SKIP_KEYS),
    [skill.body],
  );

  return (
    <article
      className="flex h-full min-w-0 flex-col gap-2 overflow-y-auto px-5 pb-5"
      aria-label={skill.name}
    >
      {/* Header row */}
      <div className="flex flex-col gap-3 pb-1 sm:flex-row sm:items-start sm:gap-4">
        <div className="min-w-0 flex-1 overflow-hidden sm:pt-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-xl font-bold text-text-primary" title={skill.name}>
              {skill.name}
            </h2>
            {isPublic && (
              <TooltipAnchor
                description={localize('com_ui_skill_sr_public')}
                side="top"
                render={
                  <EarthIcon
                    className="size-5 shrink-0 text-accent-primary"
                    aria-label={localize('com_ui_skill_sr_public')}
                  />
                }
              />
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
            <span className="flex items-center gap-1">
              <User className="size-3" aria-hidden="true" />
              {addedBy}
            </span>
            {updatedDate && (
              <span className="flex items-center gap-1">
                <Calendar className="size-3" aria-hidden="true" />
                {updatedDate}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-1">
          <SkillToggle enabled={skillEnabled} onChange={() => toggle(skill)} />
          <ShareSkill skill={skill} />
          {permissions.canEdit && onEdit && (
            <TooltipAnchor
              description={localize('com_ui_edit')}
              side="bottom"
              render={
                <Button
                  variant="outline"
                  size="icon"
                  className="size-9 border-border-medium"
                  aria-label={localize('com_ui_edit')}
                  onClick={onEdit}
                >
                  <Pencil className="size-5" aria-hidden="true" />
                </Button>
              }
            />
          )}
          {permissions.canDelete && onDelete && (
            <DeleteSkill skillId={skill._id} skillName={skill.name} onDelete={onDelete} />
          )}
        </div>
      </div>

      {/* Description */}
      <div className="flex flex-col gap-1">
        <h3 className="text-xs leading-4 text-text-secondary">{localize('com_ui_description')}</h3>
        <p className="whitespace-pre-wrap text-sm text-text-secondary">{skill.description}</p>
      </div>

      {/* Divider with view toggle */}
      <div className="flex items-center gap-3 py-1">
        <hr className="flex-1 border-border-medium" />
        <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
      </div>

      {/* Frontmatter metadata */}
      {viewMode === 'rendered' && frontmatterFields.length > 0 && (
        <div className="grid grid-cols-[max-content_1fr] items-baseline gap-x-8 gap-y-2 pb-2">
          {frontmatterFields.map(({ key, value }) => (
            <React.Fragment key={key}>
              <span className="text-xs text-text-secondary">{key}</span>
              <span className="text-sm text-text-primary">{value}</span>
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Content — fills remaining space, no card wrapper */}
      <div className="min-h-0 flex-1 overflow-auto">
        {viewMode === 'rendered' ? (
          <SkillMarkdownRenderer
            content={cleanBody}
            skillId={skill._id}
            currentFilePath="SKILL.md"
          />
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-text-primary">
            {skill.body ?? ''}
          </pre>
        )}
      </div>
    </article>
  );
}
