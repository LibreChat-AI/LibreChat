/**
 * Registers the app's default message hosts: the row host (icons, files, copy, fork, feedback)
 * and the content-parts renderer. They import the message renderer, so instead of the app entry
 * each surface that draws message rows loads this first: the chat's message list, the shared
 * link, search results and the subagent thread panel.
 */
import '~/Providers/MessagesHostContext';
import '~/components/Chat/Messages/Content/register';
