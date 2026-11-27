import { useMemo } from 'react';
import { Alert, Button } from '@librechat/client';
import type { SkillItem } from '../../items/types';
import SkillMarkdownRenderer from '~/components/Skills/display/SkillMarkdownRenderer';
import { parseFrontmatter } from '~/components/Skills/utils';
import { useGetSkillByIdQuery } from '~/data-provider';
import Loading from '~/components/Channels/Loading';
import { useLocalize } from '~/hooks';

interface Props {
  item: SkillItem;
}

const NO_KEYS = new Set<string>();

/** The skill's own instructions: its SKILL.md body, fetched on open since list rows carry only a summary. */
export default function SkillSection({ item }: Props) {
  const localize = useLocalize();
  const skill = useGetSkillByIdQuery(item.skill._id);
  const body = useMemo(
    () => parseFrontmatter(skill.data?.body ?? '', NO_KEYS).body.trim(),
    [skill.data?.body],
  );

  return (
    <div className="flex flex-col gap-4">
      {item.description ? (
        <p className="text-text-secondary text-sm leading-relaxed whitespace-pre-wrap">
          {item.description}
        </p>
      ) : (
        <p className="text-text-tertiary text-sm italic">
          {localize('com_ui_tools_no_description')}
        </p>
      )}
      {skill.isLoading && <Loading />}
      {skill.isError && (
        <div className="flex flex-col items-start gap-2">
          <Alert variant="error">{localize('com_ui_skill_content_error')}</Alert>
          <Button type="button" variant="outline" onClick={() => void skill.refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {body && (
        <div className="border-border-light bg-surface-secondary max-h-80 overflow-y-auto rounded-xl border px-4 py-3">
          <SkillMarkdownRenderer
            content={body}
            skillId={item.skill._id}
            currentFilePath="SKILL.md"
          />
        </div>
      )}
    </div>
  );
}
