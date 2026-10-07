import { useMemo } from 'react';
import { Variable, ChevronRight } from 'lucide-react';
import { specialVariables } from 'librechat-data-provider';
import type { TSpecialVarLabel } from 'librechat-data-provider';
import { getSpecialVariableIcon } from '~/components/Prompts/utils';
import { extractUniqueVariables, cn } from '~/utils';
import { useLocalize } from '~/hooks';

interface ParsedVariable {
  name: string;
  options: string[];
  isDropdown: boolean;
  isSpecial: boolean;
}

const parseVariable = (variable: string): ParsedVariable => {
  const isSpecial = specialVariables[variable.toLowerCase()] != null;
  if (isSpecial) {
    return { name: variable.toLowerCase(), options: [], isDropdown: false, isSpecial: true };
  }

  const colonIndex = variable.indexOf(':');
  if (colonIndex > 0) {
    const name = variable.substring(0, colonIndex);
    const optionsPart = variable.substring(colonIndex + 1);
    const options = optionsPart.split('|').filter(Boolean);
    if (options.length > 1) {
      return { name, options, isDropdown: true, isSpecial: false };
    }
  }

  return { name: variable, options: [], isDropdown: false, isSpecial: false };
};

const DropdownVariableCard = ({ parsed }: { parsed: ParsedVariable }) => {
  const localize = useLocalize();

  return (
    <div
      className="border-border-medium bg-surface-secondary/50 hover:bg-surface-secondary rounded-lg border p-2.5"
      role="listitem"
      aria-label={localize('com_ui_variable_with_options', {
        name: parsed.name,
        count: parsed.options.length,
      })}
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="bg-surface-tertiary flex size-6 items-center justify-center rounded-md">
          <ChevronRight className="text-text-secondary size-3.5" aria-hidden="true" />
        </div>
        <span className="text-text-primary text-sm font-medium">{parsed.name}</span>
        <span className="bg-surface-tertiary text-text-secondary text-3xs rounded-full px-1.5 py-0.5 font-medium">
          {parsed.options.length} {localize('com_ui_options')}
        </span>
      </div>
      <div
        className="flex flex-wrap gap-1.5"
        role="list"
        aria-label={localize('com_ui_available_options')}
      >
        {parsed.options.map((option, index) => (
          <span
            key={index}
            className="border-border-medium text-text-secondary hover:bg-surface-secondary rounded-md border bg-transparent px-2 py-0.5 text-xs transition-colors"
            role="listitem"
          >
            {option}
          </span>
        ))}
      </div>
    </div>
  );
};

const SpecialVariableChip = ({ parsed }: { parsed: ParsedVariable }) => {
  const localize = useLocalize();
  const Icon = getSpecialVariableIcon(parsed.name);
  const labelKey = `com_ui_special_var_${parsed.name}` as TSpecialVarLabel;
  const descKey = `com_ui_special_var_desc_${parsed.name}` as TSpecialVarLabel;
  const displayLabel = localize(labelKey);
  const description = localize(descKey);

  return (
    <div
      className="group border-border-medium hover:bg-surface-secondary flex items-start gap-2 rounded-lg border bg-transparent p-2"
      role="listitem"
      aria-label={displayLabel}
    >
      <div className="bg-surface-tertiary flex size-6 shrink-0 items-center justify-center rounded-md">
        <Icon className="text-text-secondary size-3.5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <span className="text-text-primary text-xs font-medium">{displayLabel}</span>
        {description && <p className="text-text-secondary text-2xs mt-0.5">{description}</p>}
      </div>
    </div>
  );
};

const SimpleVariableChip = ({ parsed }: { parsed: ParsedVariable }) => (
  <span
    className="border-border-medium bg-surface-secondary/50 text-text-primary hover:bg-surface-tertiary inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium"
    role="listitem"
  >
    <Variable className="text-text-secondary size-3" aria-hidden="true" />
    <span className="max-w-32 truncate">{parsed.name}</span>
  </span>
);

const PromptVariables = ({
  promptText,
  inset = false,
}: {
  promptText: string;
  inset?: boolean;
}) => {
  const localize = useLocalize();
  const frame = inset ? 'border-border-inset-medium' : 'border-border-medium';

  const variables = useMemo(() => {
    return extractUniqueVariables(promptText || '');
  }, [promptText]);

  const { dropdownVariables, specialVars, simpleVariables } = useMemo(() => {
    const result = {
      dropdownVariables: [] as ParsedVariable[],
      specialVars: [] as ParsedVariable[],
      simpleVariables: [] as ParsedVariable[],
    };
    for (const v of variables) {
      const parsed = parseVariable(v);
      if (parsed.isDropdown) {
        result.dropdownVariables.push(parsed);
      } else if (parsed.isSpecial) {
        result.specialVars.push(parsed);
      } else {
        result.simpleVariables.push(parsed);
      }
    }
    return result;
  }, [variables]);

  if (variables.length === 0) {
    return null;
  }

  return (
    <div className={cn(frame, 'overflow-hidden rounded-xl border')}>
      <header className={cn(frame, 'flex items-center justify-between border-b p-3')}>
        <div className="flex items-center gap-2">
          <Variable className="text-text-secondary size-4" aria-hidden="true" />
          <h4 className="text-text-primary text-sm font-semibold">
            {localize('com_ui_variables')}
          </h4>
        </div>
        <span className="bg-surface-tertiary text-text-secondary flex size-6 items-center justify-center rounded-full text-xs font-medium tabular-nums">
          {variables.length}
        </span>
      </header>

      <div
        className="flex flex-col gap-4 p-3"
        role="list"
        aria-label={localize('com_ui_prompt_variables_list')}
      >
        {specialVars.length > 0 && (
          <section aria-label={localize('com_ui_special_variables')}>
            <h5 className="text-text-secondary text-2xs mb-2 font-medium tracking-wide uppercase">
              {localize('com_ui_special_variables')}
            </h5>
            <div className="grid gap-2 sm:grid-cols-2">
              {specialVars.map((parsed, index) => (
                <SpecialVariableChip key={`special-${index}`} parsed={parsed} />
              ))}
            </div>
          </section>
        )}

        {dropdownVariables.length > 0 && (
          <section aria-label={localize('com_ui_dropdown_variables')}>
            <h5 className="text-text-secondary text-2xs mb-2 font-medium tracking-wide uppercase">
              {localize('com_ui_dropdown_variables')}
            </h5>
            <div className="flex flex-col gap-2">
              {dropdownVariables.map((parsed, index) => (
                <DropdownVariableCard key={`dropdown-${index}`} parsed={parsed} />
              ))}
            </div>
          </section>
        )}

        {simpleVariables.length > 0 && (
          <section aria-label={localize('com_ui_text_variables')}>
            <h5 className="text-text-secondary text-2xs mb-2 font-medium tracking-wide uppercase">
              {localize('com_ui_text_variables')}
            </h5>
            <div className="flex flex-wrap gap-2">
              {simpleVariables.map((parsed, index) => (
                <SimpleVariableChip key={`simple-${index}`} parsed={parsed} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

export default PromptVariables;
