import { useMemo } from 'react';
import { Label, Radio } from '@librechat/client';
import { useFormContext, useWatch } from 'react-hook-form';
import type { MCPServerFormData } from '../hooks/useMCPServerForm';
import { useLocalize } from '~/hooks';

export default function TransportSection() {
  const localize = useLocalize();
  const { setValue } = useFormContext<MCPServerFormData>();

  const transportType = useWatch<MCPServerFormData, 'type'>({
    name: 'type',
  });

  const handleTransportChange = (value: string) => {
    setValue('type', value as 'streamable-http' | 'sse');
  };

  const transportOptions = useMemo(
    () => [
      { value: 'streamable-http', label: localize('com_ui_mcp_type_streamable_http') },
      { value: 'sse', label: localize('com_ui_mcp_type_sse') },
    ],
    [localize],
  );

  return (
    <fieldset className="space-y-2">
      <legend>
        <Label id="transport-label" className="text-sm font-medium">
          {localize('com_ui_mcp_transport')}
        </Label>
      </legend>
      <Radio
        options={transportOptions}
        value={transportType}
        onChange={handleTransportChange}
        fullWidth
        wrap
        aria-labelledby="transport-label"
      />
    </fieldset>
  );
}
