import { useEffect, useRef } from 'react';
import debounce from 'lodash/debounce';
import { useLocation } from 'react-router-dom';
import { useRecoilState, useSetRecoilState, useResetRecoilState } from 'recoil';
import type { Artifact } from '~/common';
import useClearArtifactNavigationRequest from '~/hooks/Artifacts/useClearArtifactNavigationRequest';
import ArtifactRow from '~/components/Chat/Messages/Content/Parts/ArtifactRow';
import { artifactRowKind } from '~/utils/artifacts';
import { logger, isArtifactRoute } from '~/utils';
import store from '~/store';

const ArtifactButton = ({ artifact }: { artifact: Artifact | null }) => {
  const location = useLocation();
  const setVisible = useSetRecoilState(store.artifactsVisibility);
  const [artifacts, setArtifacts] = useRecoilState(store.artifactsState);
  const [currentArtifactId, setCurrentArtifactId] = useRecoilState(store.currentArtifactId);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const isSelected = artifact?.id === currentArtifactId;
  const [visibleArtifacts, setVisibleArtifacts] = useRecoilState(store.visibleArtifacts);
  const clearArtifactNavigationRequest = useClearArtifactNavigationRequest();

  const debouncedSetVisibleRef = useRef(
    debounce((artifactToSet: Artifact) => {
      logger.log(
        'artifacts_visibility',
        'Setting artifact to visible state from Artifact button',
        artifactToSet,
      );
      setVisibleArtifacts((prev) => ({
        ...prev,
        [artifactToSet.id]: artifactToSet,
      }));
    }, 750),
  );

  useEffect(() => {
    if (artifact == null || artifact?.id == null || artifact.id === '') {
      return;
    }

    if (!isArtifactRoute(location.pathname)) {
      return;
    }

    const debouncedSetVisible = debouncedSetVisibleRef.current;
    debouncedSetVisible(artifact);
    return () => {
      debouncedSetVisible.cancel();
    };
  }, [artifact, location.pathname]);

  if (artifact === null || artifact === undefined) {
    return null;
  }

  const handleOpen = () => {
    clearArtifactNavigationRequest();
    if (isSelected) {
      resetCurrentArtifactId();
      setVisible(false);
      return;
    }

    setCurrentArtifactId(artifact.id);
    setVisible(true);

    if (artifacts?.[artifact.id] == null) {
      setArtifacts(visibleArtifacts);
    }
  };

  /* Model-authored artifacts have no file behind them — the panel's own
   * `DownloadArtifact` serializes the (possibly edited) content, which
   * needs the editor context this row doesn't sit in. */
  return (
    <ArtifactRow
      title={artifact.title ?? ''}
      kind={artifactRowKind(artifact)}
      isSelected={isSelected}
      onOpen={handleOpen}
      artifactId={artifact.id}
    />
  );
};

export default ArtifactButton;
