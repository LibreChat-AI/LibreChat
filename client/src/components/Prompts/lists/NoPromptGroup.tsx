import { Button } from '@librechat/client';
import { useNavigate } from 'react-router-dom';
import { useLocalize } from '~/hooks';

export default function NoPromptGroup() {
  const navigate = useNavigate();
  const localize = useLocalize();
  return (
    <div className="relative min-h-full w-full px-4">
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-text-primary text-center font-bold">
          <h1 className="text-text-primary text-lg font-bold md:text-2xl">
            {localize('com_ui_prompt_preview_not_shared')}
          </h1>
          <Button
            className="mt-4"
            onClick={() => {
              navigate('/prompts');
            }}
            aria-label={localize('com_ui_back_to_prompts')}
          >
            {localize('com_ui_back_to_prompts')}
          </Button>
        </div>
      </div>
    </div>
  );
}
