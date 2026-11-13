import { createContext, useContext } from 'react';

type ConversationAssignment = {
  acknowledge: (conversationId: string) => void;
  settle: (conversationId: string | null) => void;
};

export const ConversationAssignmentContext = createContext<ConversationAssignment | undefined>(
  undefined,
);
export const useConversationAssignment = () => useContext(ConversationAssignmentContext);
