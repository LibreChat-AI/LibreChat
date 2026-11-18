import { createContext, useContext } from 'react';
import { readBrowserComposerRoute } from '~/common/composerRoute';

export const ComposerRouteContext = createContext(readBrowserComposerRoute);
export const useComposerRoute = () => useContext(ComposerRouteContext);
