import React from 'react';
import axios from 'axios';
import { RecoilRoot } from 'recoil';
import { ToastProvider } from '@librechat/client';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Tools,
  QueryKeys,
  FileSources,
  EModelEndpoint,
  defaultOrderQuery,
} from 'librechat-data-provider';
import type {
  Assistant,
  AssistantListResponse,
  Action,
  TFileUpload,
} from 'librechat-data-provider';
import {
  useUpdateAction,
  useDeleteAction,
  useCreateAssistantMutation,
  useUpdateAssistantMutation,
  useDeleteAssistantMutation,
  useUploadAssistantAvatarMutation,
} from '../../mutations';
import { useUploadFileMutation, useDeleteFilesMutation } from '../../Files/mutations';
import { invalidateAssistantDetails } from '../cache';
import store from '~/store';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return {
    ...actual,
    __esModule: true,
    default: {
      ...actual.default,
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
    },
  };
});

const endpoint = EModelEndpoint.assistants;
const id = 'asst-1';
const model = 'gpt-4o';
const assistant: Assistant = {
  id,
  model,
  object: 'assistant',
  created_at: 1,
  name: 'Updated',
  description: null,
  instructions: null,
  metadata: { avatar: 'avatar.png' },
  conversation_starters: ['Hello'],
  tools: [
    {
      type: Tools.function,
      function: { name: 'example.com_get', description: '', parameters: {} },
    },
  ],
};
const otherAssistant: Assistant = { ...assistant, id: 'asst-2' };
const action: Action = {
  action_id: 'action-1',
  assistant_id: id,
  version: 2,
  metadata: { domain: 'example.com' },
};
const uploadedFile: TFileUpload = {
  file_id: 'file-1',
  temp_file_id: 'temp-1',
  user: 'user-1',
  filename: 'knowledge.txt',
  filepath: 'file-1',
  bytes: 1,
  type: 'text/plain',
  source: FileSources.openai,
  embedded: false,
  object: 'file',
  usage: 1,
};
const keys = [
  [QueryKeys.assistant, endpoint, id],
  [QueryKeys.assistant, endpoint, id, 1, model],
  [QueryKeys.assistant, endpoint, id, '2', model],
  [QueryKeys.assistant, endpoint, id, 2, 'another-model'],
  [QueryKeys.assistant, endpoint, id, 2, null],
  [QueryKeys.assistant, endpoint, id, 2, ''],
];
const isolatedKeys = [
  [QueryKeys.assistant, EModelEndpoint.azureAssistants, id, 2, model],
  [QueryKeys.assistant, endpoint, otherAssistant.id, 2, model],
];
const listKey = [QueryKeys.assistants, endpoint, defaultOrderQuery];
const docsKey = [QueryKeys.assistantDocs, endpoint];
const list: AssistantListResponse = {
  object: 'list',
  data: [{ ...assistant, name: 'Original', file_ids: [] }, otherAssistant],
  first_id: id,
  last_id: otherAssistant.id,
  has_more: false,
};

function setup(cachedList = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: () => undefined },
  });
  for (const key of [...keys, ...isolatedKeys]) {
    queryClient.setQueryData(key, assistant);
  }
  if (cachedList) {
    queryClient.setQueryData(listKey, {
      ...list,
      data: list.data.map((item) => ({ ...item })),
    });
    queryClient.setQueryData(docsKey, [{ assistant_id: id }, { assistant_id: otherAssistant.id }]);
    queryClient.setQueryData([QueryKeys.actions], [action]);
  }
  const onSuccess = jest.fn((..._args: unknown[]) => {
    expect(keys.every((key) => queryClient.getQueryState(key)?.isInvalidated === true)).toBe(true);
  });
  const context = { marker: 'snapshot' };
  const onMutate = jest.fn().mockReturnValue(context);
  const onError = jest.fn();
  const onSettled = jest.fn();
  const options = { onSuccess, onMutate, onError, onSettled };
  const wrapper = ({ children }: React.PropsWithChildren) => (
    <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, false)}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </RecoilRoot>
  );
  const view = renderHook(
    () => ({
      create: useCreateAssistantMutation(options),
      update: useUpdateAssistantMutation(options),
      delete: useDeleteAssistantMutation(options),
      avatar: useUploadAssistantAvatarMutation(options),
      actionsUpdate: useUpdateAction(options),
      actionsDelete: useDeleteAction(options),
      upload: useUploadFileMutation(options),
      unlink: useDeleteFilesMutation({ ...options, silent: true }),
    }),
    { wrapper },
  );
  return { ...view, queryClient, onSuccess, onMutate, onError, onSettled, context };
}

type Hooks = ReturnType<typeof setup>['result']['current'];
const requests: Array<{
  name: keyof Hooks;
  run: (hooks: Hooks) => Promise<unknown>;
  transport: jest.Mock;
}> = [
  {
    name: 'create',
    run: (hooks) => hooks.create.mutateAsync({ endpoint, model, version: 2 }),
    transport: jest.mocked(axios.post),
  },
  {
    name: 'update',
    run: (hooks) =>
      hooks.update.mutateAsync({
        assistant_id: id,
        data: { endpoint, metadata: { avatar: '' }, append_current_datetime: true },
      }),
    transport: jest.mocked(axios.patch),
  },
  {
    name: 'delete',
    run: (hooks) => hooks.delete.mutateAsync({ endpoint, model, assistant_id: id }),
    transport: jest.mocked(axios.delete),
  },
  {
    name: 'avatar',
    run: (hooks) =>
      hooks.avatar.mutateAsync({
        endpoint,
        model,
        assistant_id: id,
        version: 2,
        formData: new FormData(),
        postCreation: true,
      }),
    transport: jest.mocked(axios.post),
  },
  {
    name: 'actionsUpdate',
    run: (hooks) =>
      hooks.actionsUpdate.mutateAsync({
        endpoint,
        model,
        assistant_id: id,
        version: 2,
        functions: [],
        metadata: action.metadata,
        action_id: action.action_id,
      }),
    transport: jest.mocked(axios.post),
  },
  {
    name: 'actionsDelete',
    run: (hooks) =>
      hooks.actionsDelete.mutateAsync({
        endpoint,
        model,
        assistant_id: id,
        action_id: action.action_id,
      }),
    transport: jest.mocked(axios.delete),
  },
  {
    name: 'upload',
    run: (hooks) => {
      const formData = new FormData();
      formData.set('endpoint', endpoint);
      formData.set('assistant_id', id);
      return hooks.upload.mutateAsync(formData);
    },
    transport: jest.mocked(axios.post),
  },
  {
    name: 'unlink',
    run: (hooks) =>
      hooks.unlink.mutateAsync({
        assistant_id: id,
        files: [
          { file_id: 'file-1', filepath: 'file-1', embedded: false, source: FileSources.openai },
        ],
      }),
    transport: jest.mocked(axios.delete),
  },
];

beforeEach(() => {
  jest.mocked(axios.post).mockImplementation(async (url) => {
    if (String(url).includes('/actions/')) {
      return { data: [{ user: 'user-1', assistant_id: id }, assistant, action] };
    }
    if (String(url).includes('/files') && !String(url).includes('/avatar')) {
      return { data: uploadedFile };
    }
    return { data: assistant };
  });
  jest.mocked(axios.patch).mockResolvedValue({ data: assistant });
  jest.mocked(axios.delete).mockImplementation(async (url) => ({
    data: String(url).includes('/files') ? { message: 'Deleted' } : undefined,
  }));
});

describe.each(requests)('$name detail invalidation', ({ name, run, transport }) => {
  it.each([false, true])('invalidates before callbacks with list cached=%s', async (cachedList) => {
    const view = setup(cachedList);
    try {
      await act(async () => {
        await run(view.result.current);
      });
      expect(view.onSuccess).toHaveBeenCalledTimes(1);
      expect(view.onSuccess.mock.calls[0][2]).toBe(view.context);
      expect(view.onMutate).toHaveBeenCalledTimes(1);
      expect(view.onError).not.toHaveBeenCalled();
      for (const key of isolatedKeys) {
        expect(view.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
      }
      if (!cachedList) {
        expect(view.queryClient.getQueryData(listKey)).toBeUndefined();
      } else if (name === 'create') {
        expect(view.queryClient.getQueryData<AssistantListResponse>(listKey)?.data[0]).toEqual(
          assistant,
        );
      } else if (name === 'update' || name === 'actionsUpdate') {
        expect(view.queryClient.getQueryData<AssistantListResponse>(listKey)?.data).toEqual([
          assistant,
          otherAssistant,
        ]);
        if (name === 'update') {
          expect(view.queryClient.getQueryData(docsKey)).toEqual([
            { assistant_id: id, conversation_starters: ['Hello'], append_current_datetime: true },
            { assistant_id: otherAssistant.id },
          ]);
        }
      } else if (name === 'delete') {
        expect(view.queryClient.getQueryData<AssistantListResponse>(listKey)?.data).toEqual([
          otherAssistant,
        ]);
        expect(view.onSuccess.mock.calls[0][2]).toBe(view.context);
      } else if (name === 'actionsDelete') {
        expect(
          view.queryClient.getQueryData<AssistantListResponse>(listKey)?.data[0].tools,
        ).toEqual([]);
        expect(view.queryClient.getQueryData([QueryKeys.actions])).toEqual([]);
      } else if (name === 'upload') {
        expect(
          view.queryClient.getQueryData<AssistantListResponse>(listKey)?.data[0].file_ids,
        ).toEqual(['file-1']);
      }
      if (name !== 'upload' && name !== 'unlink') {
        expect(view.onSettled).toHaveBeenCalledTimes(1);
      }
    } finally {
      view.unmount();
      view.queryClient.clear();
    }
  });

  it('leaves detail queries valid on transport failure and preserves error callbacks', async () => {
    const error = new Error('Transport unavailable');
    transport.mockRejectedValueOnce(error);
    const view = setup();
    try {
      await act(async () => {
        await expect(run(view.result.current)).rejects.toBe(error);
      });
      for (const key of keys) {
        expect(view.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
      }
      expect(view.onSuccess).not.toHaveBeenCalled();
      if (name !== 'upload' && name !== 'unlink') {
        expect(view.onSettled).toHaveBeenCalledWith(
          undefined,
          error,
          expect.anything(),
          view.context,
        );
      }
      expect(view.onError).toHaveBeenCalledWith(error, expect.anything(), view.context);
    } finally {
      view.unmount();
      view.queryClient.clear();
    }
  });
});

it('invalidates all matching suffixes synchronously without manufacturing missing queries', () => {
  const view = setup();
  try {
    invalidateAssistantDetails(view.queryClient, endpoint, id);
    for (const key of keys) {
      expect(view.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    invalidateAssistantDetails(view.queryClient, endpoint, 'missing');
    expect(
      view.queryClient.getQueryState([QueryKeys.assistant, endpoint, 'missing']),
    ).toBeUndefined();
  } finally {
    view.unmount();
    view.queryClient.clear();
  }
});

it('keeps a cached empty list distinct from a missing list', async () => {
  const view = setup(true);
  view.queryClient.setQueryData(listKey, { ...list, data: [] });
  try {
    await act(async () => {
      await view.result.current.update.mutateAsync({ assistant_id: id, data: { endpoint } });
    });
    expect(view.queryClient.getQueryData<AssistantListResponse>(listKey)?.data).toEqual([]);
    expect(view.queryClient.getQueryData(docsKey)).toEqual([
      { assistant_id: id, conversation_starters: ['Hello'] },
      { assistant_id: otherAssistant.id },
    ]);
    expect(view.onSuccess).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    view.queryClient.clear();
  }
});

it.each([
  [FileSources.azure, 'file-1'],
  [FileSources.local, EModelEndpoint.azureAssistants],
])('scopes attachment unlinking to the Azure provider (%s, %s)', async (source, filepath) => {
  const view = setup();
  view.onSuccess.mockImplementation(() => undefined);
  try {
    await act(async () => {
      await view.result.current.unlink.mutateAsync({
        assistant_id: id,
        files: [{ file_id: 'file-1', filepath, embedded: false, source }],
      });
    });
    for (const key of keys) {
      expect(view.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    }
    expect(view.queryClient.getQueryState(isolatedKeys[0])?.isInvalidated).toBe(true);
    expect(view.queryClient.getQueryState(isolatedKeys[1])?.isInvalidated).toBe(false);
    expect(view.onSuccess).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    view.queryClient.clear();
  }
});

it('does not guess an assistant provider when unlinking files without provider identity', async () => {
  const view = setup();
  view.onSuccess.mockImplementation(() => undefined);
  try {
    await act(async () => {
      await view.result.current.unlink.mutateAsync({
        assistant_id: id,
        files: [
          { file_id: 'file-1', filepath: 'file-1', embedded: false, source: FileSources.local },
        ],
      });
    });
    for (const key of [...keys, ...isolatedKeys]) {
      expect(view.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    }
  } finally {
    view.unmount();
    view.queryClient.clear();
  }
});

it('does not invalidate assistant resources for message-only uploads', async () => {
  const view = setup();
  view.onSuccess.mockImplementation(() => undefined);
  const formData = new FormData();
  formData.set('endpoint', endpoint);
  formData.set('assistant_id', id);
  formData.set('message_file', 'true');
  try {
    await act(async () => {
      await view.result.current.upload.mutateAsync(formData);
    });
    for (const key of keys) {
      expect(view.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    }
    expect(view.onSuccess).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    view.queryClient.clear();
  }
});
