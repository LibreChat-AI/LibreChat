import { TMessage } from 'librechat-data-provider';
import MessageQuotes from './MessageQuotes';
import SkillPills from './SkillPills';
import Files from './Files';

const Container = ({ children, message }: { children: React.ReactNode; message?: TMessage }) => (
  <div
    className="text-message flex min-h-[20px] flex-col items-start gap-3 overflow-visible [.text-message+&]:mt-5"
    dir="auto"
  >
    {message?.isCreatedByUser === true && <MessageQuotes quotes={message.quotes} />}
    {/* Not user-only: an assistant message can carry attachments (voice-mode
        audio) that no content part renders. This is the path for messages
        with no content at all; `ContentParts` covers the rest. */}
    {message?.files != null && message.files.length > 0 && <Files files={message.files} />}
    {message?.isCreatedByUser === true && (
      <>
        <SkillPills skills={message.alwaysAppliedSkills} source="always-apply" />
        <SkillPills skills={message.manualSkills} source="manual" />
      </>
    )}
    {children}
  </div>
);

export default Container;
