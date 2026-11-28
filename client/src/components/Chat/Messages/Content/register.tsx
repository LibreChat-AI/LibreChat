import { contentPartsRenderer } from '@librechat/chat/components';
import { setAppContentParts } from './Parts/slots';
import { contentSlots } from './ContentParts';

/** Fills the parts host's content slot with the chat package's renderer and this app's slots. */
setAppContentParts(contentPartsRenderer(contentSlots));
