import { AccessRoleIds, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import { createArtifactAppSharingPolicy } from './access';

type MockResponse = Response & {
  statusCode: number;
  body?: unknown;
};

function makeResponse(): MockResponse {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return response as MockResponse;
}

function makeRequest(body: Record<string, unknown>, resourceType = ResourceType.ARTIFACT_APP) {
  return {
    params: { resourceType, resourceId: 'artifact-resource-id' },
    body,
  } as unknown as Request<{ resourceType: string; resourceId: string }>;
}

describe('Artifact App sharing policy', () => {
  const getArtifactAppsByIds = jest.fn(async () => [{ createdBy: 'owner-user' }]);
  const policy = createArtifactAppSharingPolicy({ getArtifactAppsByIds });
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
  });

  it('allows viewer-only grants without changing the owner', async () => {
    const response = makeResponse();

    await policy(
      makeRequest({
        updated: [
          {
            type: PrincipalType.USER,
            id: 'viewer-user',
            accessRoleId: AccessRoleIds.ARTIFACT_APP_VIEWER,
          },
        ],
        removed: [],
        public: true,
        publicAccessRoleId: AccessRoleIds.ARTIFACT_APP_VIEWER,
      }),
      response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect(getArtifactAppsByIds).toHaveBeenCalledWith(['artifact-resource-id']);
  });

  it.each([AccessRoleIds.ARTIFACT_APP_EDITOR, AccessRoleIds.ARTIFACT_APP_OWNER])(
    'rejects a direct %s grant',
    async (accessRoleId) => {
      const response = makeResponse();

      await policy(
        makeRequest({
          updated: [{ type: PrincipalType.USER, id: 'target-user', accessRoleId }],
          removed: [],
        }),
        response,
        next,
      );

      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        error: 'Bad Request',
        message: 'Artifact Apps can only be shared with viewer access',
      });
      expect(getArtifactAppsByIds).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    },
  );

  it('rejects public owner access', async () => {
    const response = makeResponse();

    await policy(
      makeRequest({
        updated: [],
        removed: [],
        public: true,
        publicAccessRoleId: AccessRoleIds.ARTIFACT_APP_OWNER,
      }),
      response,
      next,
    );

    expect(response.statusCode).toBe(400);
    expect(getArtifactAppsByIds).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects role-wide grants even when they use viewer access', async () => {
    const response = makeResponse();

    await policy(
      makeRequest({
        updated: [
          {
            type: PrincipalType.ROLE,
            id: 'USER',
            accessRoleId: AccessRoleIds.ARTIFACT_APP_VIEWER,
          },
        ],
        removed: [],
      }),
      response,
      next,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: 'Bad Request',
      message: 'Artifact Apps cannot be shared with roles',
    });
    expect(getArtifactAppsByIds).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'remove',
      body: {
        updated: [],
        removed: [{ type: PrincipalType.USER, id: 'owner-user' }],
      },
    },
    {
      label: 'downgrade',
      body: {
        updated: [
          {
            type: PrincipalType.USER,
            id: 'owner-user',
            accessRoleId: AccessRoleIds.ARTIFACT_APP_VIEWER,
          },
        ],
        removed: [],
      },
    },
  ])('rejects an attempt to $label the canonical owner', async ({ body }) => {
    const response = makeResponse();

    await policy(makeRequest(body), response, next);

    expect(getArtifactAppsByIds).toHaveBeenCalledWith(['artifact-resource-id']);
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: 'Bad Request',
      message: 'Artifact App owner permissions cannot be changed',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not affect permission updates for other resource types', async () => {
    const response = makeResponse();

    await policy(makeRequest({}, ResourceType.AGENT), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(getArtifactAppsByIds).not.toHaveBeenCalled();
  });

  it('rejects public sharing when the artifact has been deleted', async () => {
    getArtifactAppsByIds.mockResolvedValueOnce([]);
    const response = makeResponse();

    await policy(
      makeRequest({
        updated: [],
        removed: [],
        public: true,
        publicAccessRoleId: AccessRoleIds.ARTIFACT_APP_VIEWER,
      }),
      response,
      next,
    );

    expect(response.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });
});
