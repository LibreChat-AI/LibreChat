import { Spinner, useMediaQuery } from '@librechat/client';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { Navigate, useNavigate, useParams, useLocation, useSearchParams } from 'react-router-dom';
import SkillFileViewer from '~/components/Skills/display/SkillFileViewer';
import { CreateSkillForm, SkillForm } from '~/components/Skills/forms';
import { useHasAccess, useAuthContext, useLocalize } from '~/hooks';
import SkillDetail from '~/components/Skills/display/SkillDetail';
import SkillState from '~/components/Skills/display/SkillState';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { useGetSkillByIdQuery } from '~/data-provider';

/**
 * Skill detail / edit / create route content.
 *
 * Reader-first: the default `/skills/:skillId` shows the read-only
 * `SkillDetail` view (rendered markdown, metadata, source toggle).
 * Edit is reached via `/skills/:skillId/edit` or the Edit button.
 * Create is reached via `/skills/new`.
 */
export default function SkillsView() {
  const { skillId } = useParams();
  const location = useLocation();
  const localize = useLocalize();
  const { user, roles } = useAuthContext();

  const hasAccess = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });
  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.CREATE,
  });

  const isCreate = location.pathname.endsWith('/new');
  const isEdit = location.pathname.endsWith('/edit');

  const rolesLoaded = user?.role != null && roles?.[user.role] != null;
  if (!rolesLoaded) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-presentation">
        <Spinner className="text-text-secondary" aria-label={localize('com_ui_loading')} />
      </div>
    );
  }

  if (!hasAccess) {
    return <Navigate to="/c/new" replace />;
  }

  if (isCreate && !hasCreateAccess) {
    return <Navigate to="/skills" replace />;
  }

  if (isCreate) {
    return <CreateView />;
  }

  // No skill selected — empty state
  if (!skillId) {
    return (
      <div className="flex h-full w-full flex-col bg-presentation">
        <MobileSidebarToggle />
        <div className="flex flex-1 flex-col items-center justify-center">
          <SkillState
            title={localize('com_ui_skill_no_selection')}
            description={localize('com_ui_skill_no_selection_desc')}
          />
        </div>
      </div>
    );
  }

  return isEdit ? <EditView skillId={skillId} /> : <DetailView skillId={skillId} />;
}

function CreateView() {
  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-presentation">
      <MobileSidebarToggle />
      <CreateSkillForm />
    </div>
  );
}

/** Read-only detail view — the default when clicking a skill. */
function DetailView({ skillId }: { skillId: string }) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeFile = searchParams.get('file');
  const skillQuery = useGetSkillByIdQuery(skillId, { enabled: !!skillId });

  // Show file content when a file is selected from the sidebar tree
  if (activeFile) {
    return (
      <div className="flex h-full w-full flex-col bg-presentation">
        <MobileSidebarToggle />
        <SkillFileViewer
          key={`${skillId}:${activeFile}`}
          skillId={skillId}
          relativePath={activeFile}
          skill={skillQuery.data}
        />
      </div>
    );
  }

  if (skillQuery.isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-presentation">
        <Spinner className="text-text-secondary" aria-label={localize('com_ui_loading')} />
      </div>
    );
  }

  if (skillQuery.isError || !skillQuery.data) {
    return (
      <div className="flex h-full w-full flex-col bg-presentation">
        <MobileSidebarToggle />
        <SkillState
          variant="error"
          title={localize('com_ui_skill_not_found')}
          description={localize('com_ui_skill_not_found_description')}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-presentation">
      <MobileSidebarToggle />
      <SkillDetail
        skill={skillQuery.data}
        onEdit={() => navigate(`/skills/${skillId}/edit`)}
        onDelete={() => navigate('/skills', { replace: true })}
      />
    </div>
  );
}

/** Edit form — reached via the Edit button or `/skills/:id/edit` URL. */
function EditView({ skillId }: { skillId: string }) {
  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-presentation">
      <MobileSidebarToggle />
      <SkillForm skillId={skillId} />
    </div>
  );
}

/** Sidebar reopen affordance for small screens, where the drawer is the only navigation. */
function MobileSidebarToggle() {
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  if (!isSmallScreen) {
    return null;
  }
  return (
    <div className="flex shrink-0 items-center px-4 pt-3">
      <OpenSidebar />
    </div>
  );
}
