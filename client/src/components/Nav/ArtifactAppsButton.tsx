import { Shapes } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, TooltipAnchor } from '@librechat/client';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import { useHasAccess, useLocalize } from '~/hooks';

interface ArtifactAppsButtonProps {
  side?: 'right' | 'bottom';
  onNavigate?: () => void;
}

/** Artifacts catalog entry in the sidebar. Self-gated so deployments without
 * artifact access do not render an inactive destination. */
export default function ArtifactAppsButton({
  side = 'right',
  onNavigate,
}: ArtifactAppsButtonProps) {
  const localize = useLocalize();
  const showArtifactCatalog = useHasAccess({
    permissionType: PermissionTypes.ARTIFACTS,
    permission: Permissions.USE,
  });

  if (!showArtifactCatalog) {
    return null;
  }

  return (
    <TooltipAnchor
      side={side}
      description={localize('com_nav_artifact_apps')}
      render={
        <Button asChild variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0">
          <Link
            to="/apps"
            data-testid="nav-artifact-apps-button"
            aria-label={localize('com_nav_artifact_apps')}
            onClick={(event) => {
              if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
              }
              onNavigate?.();
            }}
          >
            <Shapes className="h-5 w-5 text-text-primary" aria-hidden="true" />
          </Link>
        </Button>
      }
    />
  );
}
