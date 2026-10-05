import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { useLocation, useNavigate } from 'react-router-dom';
import { artifactNavigationRequestAtom } from '~/components/ArtifactApps/navigation';

export default function useClearArtifactNavigationRequest(): () => void {
  const location = useLocation();
  const navigate = useNavigate();
  const setArtifactNavigationRequest = useSetAtom(artifactNavigationRequestAtom);

  return useCallback(() => {
    setArtifactNavigationRequest(null);
    const params = new URLSearchParams(location.search);
    const hadArtifactRequest = params.has('artifact');
    params.delete('artifact');
    params.delete('artifactId');
    params.delete('artifactMessageId');
    if (!hadArtifactRequest) {
      return;
    }
    const search = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : '',
        hash: location.hash,
      },
      { replace: true, state: location.state },
    );
  }, [
    location.hash,
    location.pathname,
    location.search,
    location.state,
    navigate,
    setArtifactNavigationRequest,
  ]);
}
