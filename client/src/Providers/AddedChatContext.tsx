import { createContext, useContext } from 'react';
import type { AddedChatContract } from '~/hooks/Chat/contract';

export const AddedChatContext = createContext<AddedChatContract>({} as AddedChatContract);
export const useAddedChatContext = () => useContext(AddedChatContext);
