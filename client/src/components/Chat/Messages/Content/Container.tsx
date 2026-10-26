import { TMessage } from 'librechat-data-provider';
import MessageQuotes from './MessageQuotes';
import SkillPills from './SkillPills';
import Files from './Files';

const Container = ({
  children,
  message,
  hideFiles = false,
}: {
  children: React.ReactNode;
  message?: TMessage;
  /** The message editor renders the files itself, as chips that can be removed. */
  hideFiles?: boolean;
}) => (
  <div
    data-message-text
    className="flex min-h-[1.25rem] flex-col items-start gap-3 overflow-visible [[data-message-text]+&]:mt-5"
    dir="auto"
  >
    {message?.isCreatedByUser === true && (
      <>
        <MessageQuotes quotes={message.quotes} />
        {!hideFiles && <Files message={message} />}
        <SkillPills skills={message.alwaysAppliedSkills} source="always-apply" />
        <SkillPills skills={message.manualSkills} source="manual" />
      </>
    )}
    {children}
  </div>
);

export default Container;
