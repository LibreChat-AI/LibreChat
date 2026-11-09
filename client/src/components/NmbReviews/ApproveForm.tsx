import { useMemo, useState } from 'react';
import { Button, Checkbox, Label, Textarea } from '@librechat/client';
import type { TNmbFinding, TNmbOriginal, TNmbBlocklistChoice } from 'librechat-data-provider';
import { escapeRegex, findingValue } from '~/components/Nmb/highlight';
import { useLocalize } from '~/hooks';

type Choice = { checked: boolean; mode: 'literal' | 'regex' };

/**
 * Approve as masked. Per finding the reviewer decides whether its value or pattern joins the
 * masked-data list, so it is masked automatically from now on. Values come from the original the
 * reviewer already opened and are sent back only as the reviewer's own choice.
 */
export default function ApproveForm({
  original,
  findings,
  regexEnabled,
  busy,
  onApprove,
}: {
  original: TNmbOriginal;
  findings: TNmbFinding[];
  regexEnabled: boolean;
  busy: boolean;
  onApprove: (body: { note?: string; additions: TNmbBlocklistChoice[] }) => void;
}) {
  const localize = useLocalize();
  const [note, setNote] = useState('');
  const [choices, setChoices] = useState<Record<number, Choice>>({});

  const rows = useMemo(
    () =>
      findings
        .map((finding, index) => ({
          finding,
          index,
          value: findingValue(finding, original.segments),
        }))
        .filter((row) => row.value.length > 0),
    [findings, original.segments],
  );

  const submit = () => {
    const additions: TNmbBlocklistChoice[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const choice = choices[row.index];
      if (!choice?.checked) {
        continue;
      }
      const value = choice.mode === 'regex' ? escapeRegex(row.value) : row.value;
      const key = `${choice.mode}:${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        additions.push({ value, mode: choice.mode });
      }
    }
    onApprove({ note: note.trim() || undefined, additions });
  };

  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-sm font-semibold">{localize('com_nmb_add_to_masked_list')}</h4>
      {rows.length === 0 ? (
        <p className="text-text-secondary text-sm">{localize('com_nmb_nothing_to_add')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(({ finding, index, value }) => {
            const choice = choices[index] ?? { checked: false, mode: 'literal' };
            const id = `nmb-add-${index}`;
            return (
              <li
                key={index}
                className="border-border-light flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm"
              >
                <Checkbox
                  id={id}
                  checked={choice.checked}
                  onCheckedChange={(checked) =>
                    setChoices((prev) => ({
                      ...prev,
                      [index]: { ...choice, checked: checked === true },
                    }))
                  }
                  aria-label={localize('com_nmb_add_finding_aria', { 0: finding.entity })}
                />
                <Label htmlFor={id} className="min-w-0 flex-1 truncate font-mono">
                  <span className="text-text-secondary mr-2 font-sans">{finding.entity}</span>
                  {value}
                </Label>
                <select
                  className="border-border-light bg-surface-primary rounded-md border px-2 py-1"
                  value={choice.mode}
                  disabled={!choice.checked}
                  aria-label={localize('com_nmb_match_mode')}
                  onChange={(e) =>
                    setChoices((prev) => ({
                      ...prev,
                      [index]: {
                        ...choice,
                        mode: e.target.value === 'regex' ? 'regex' : 'literal',
                      },
                    }))
                  }
                >
                  <option value="literal">{localize('com_nmb_mode_literal')}</option>
                  {regexEnabled && <option value="regex">{localize('com_nmb_mode_regex')}</option>}
                </select>
              </li>
            );
          })}
        </ul>
      )}
      <Textarea
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
        placeholder={localize('com_nmb_note_placeholder')}
        aria-label={localize('com_nmb_note_placeholder')}
      />
      <div>
        <Button type="button" onClick={submit} disabled={busy}>
          {localize('com_nmb_approve_masked')}
        </Button>
      </div>
    </div>
  );
}
