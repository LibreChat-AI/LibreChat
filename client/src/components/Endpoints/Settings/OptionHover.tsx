import React from 'react';
import { HoverCardPortal, HoverCardContent } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { ESide } from '~/common';

type TOptionHoverProps = {
  endpoint: string;
  type: string;
  side: ESide;
};

const openAI = {
  max: 'com_endpoint_openai_max',
  temp: 'com_endpoint_openai_temp',
  topp: 'com_endpoint_openai_topp',
  freq: 'com_endpoint_openai_freq',
  pres: 'com_endpoint_openai_pres',
  resend: 'com_endpoint_openai_resend_files',
  detail: 'com_endpoint_openai_detail',
};

const types = {
  anthropic: {
    temp: 'com_endpoint_anthropic_temp',
    topp: 'com_endpoint_anthropic_topp',
    topk: 'com_endpoint_anthropic_topk',
    maxoutputtokens: 'com_endpoint_anthropic_maxoutputtokens',
    resend: openAI.resend,
    promptcache: 'com_endpoint_anthropic_prompt_cache',
  },
  google: {
    temp: 'com_endpoint_google_temp',
    topp: 'com_endpoint_google_topp',
    topk: 'com_endpoint_google_topk',
    maxoutputtokens: 'com_endpoint_google_maxoutputtokens',
  },
  openAI,
  azureOpenAI: openAI,
};

function OptionHover({ endpoint, type, side }: TOptionHoverProps) {
  const localize = useLocalize();
  const text = types[endpoint]?.[type];
  if (!text) {
    return null;
  }
  return (
    <HoverCardPortal>
      <HoverCardContent side={side} className="z-[999] w-80">
        <div className="space-y-2">
          <p className="text-sm text-text-secondary">{localize(text)}</p>
        </div>
      </HoverCardContent>
    </HoverCardPortal>
  );
}

export default OptionHover;
