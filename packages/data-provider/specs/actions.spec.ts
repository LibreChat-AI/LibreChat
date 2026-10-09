import { z } from 'zod';
import axios from 'axios';
import type { OpenAPIV3 } from 'openapi-types';
import type { ParametersSchema } from '../src/actions';
import type { FlowchartSchema } from './openapiSpecs';
import {
  createURL,
  resolveRef,
  ActionRequest,
  openapiToFunction,
  FunctionSignature,
  extractDomainFromUrl,
  validateActionDomain,
  validateAndParseOpenAPISpec,
} from '../src/actions';
import {
  getWeatherOpenapiSpec,
  whimsicalOpenapiSpec,
  scholarAIOpenapiSpec,
  formOpenAPISpec,
  swapidev,
} from './openapiSpecs';
import { AuthorizationTypeEnum, AuthTypeEnum } from '../src/types/agents';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
mockedAxios.create.mockReturnValue(mockedAxios);

describe('FunctionSignature', () => {
  it('creates a function signature and converts to JSON tool', () => {
    const signature = new FunctionSignature('testFunction', 'A test function', {
      param1: { type: 'string' },
    } as unknown as ParametersSchema);
    expect(signature.name).toBe('testFunction');
    expect(signature.description).toBe('A test function');
    expect(signature.toObjectTool()).toEqual({
      type: 'function',
      function: {
        name: 'testFunction',
        description: 'A test function',
        parameters: {
          param1: { type: 'string' },
        },
      },
    });
  });
});

describe('ActionRequest', () => {
  // Mocking responses for each method
  beforeEach(() => {
    mockedAxios.get.mockResolvedValue({ data: { success: true, method: 'GET' } });
    mockedAxios.post.mockResolvedValue({ data: { success: true, method: 'POST' } });
    mockedAxios.put.mockResolvedValue({ data: { success: true, method: 'PUT' } });
    mockedAxios.delete.mockResolvedValue({ data: { success: true, method: 'DELETE' } });
    mockedAxios.patch.mockResolvedValue({ data: { success: true, method: 'PATCH' } });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should make a GET request', async () => {
    const actionRequest = new ActionRequest(
      'https://example.com',
      '/test',
      'GET',
      'testOp',
      false,
      'application/json',
    );
    actionRequest.setParams({ param1: 'value1' });
    const response = await actionRequest.execute();
    expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/test', expect.anything());
    expect(response.data).toEqual({ success: true, method: 'GET' });
  });

  describe('ActionRequest', () => {
    beforeEach(() => {
      mockedAxios.get.mockClear();
      mockedAxios.post.mockClear();
      mockedAxios.put.mockClear();
      mockedAxios.delete.mockClear();
      mockedAxios.patch.mockClear();
    });

    it('handles GET requests', async () => {
      mockedAxios.get.mockResolvedValue({ data: { success: true } });
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/get',
        'GET',
        'testGet',
        false,
        'application/json',
      );
      actionRequest.setParams({ param: 'test' });
      const response = await actionRequest.execute();
      expect(mockedAxios.get).toHaveBeenCalled();
      expect(response.data.success).toBe(true);
    });

    it('handles POST requests', async () => {
      mockedAxios.post.mockResolvedValue({ data: { success: true } });
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/post',
        'POST',
        'testPost',
        false,
        'application/json',
      );
      actionRequest.setParams({ param: 'test' });
      const response = await actionRequest.execute();
      expect(mockedAxios.post).toHaveBeenCalled();
      expect(response.data.success).toBe(true);
    });

    it('handles PUT requests', async () => {
      mockedAxios.put.mockResolvedValue({ data: { success: true } });
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/put',
        'PUT',
        'testPut',
        false,
        'application/json',
      );
      actionRequest.setParams({ param: 'test' });
      const response = await actionRequest.execute();
      expect(mockedAxios.put).toHaveBeenCalled();
      expect(response.data.success).toBe(true);
    });

    it('handles DELETE requests', async () => {
      mockedAxios.delete.mockResolvedValue({ data: { success: true } });
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/delete',
        'DELETE',
        'testDelete',
        false,
        'application/json',
      );
      actionRequest.setParams({ param: 'test' });
      const response = await actionRequest.execute();
      expect(mockedAxios.delete).toHaveBeenCalled();
      expect(response.data.success).toBe(true);
    });

    it('handles PATCH requests', async () => {
      mockedAxios.patch.mockResolvedValue({ data: { success: true } });
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/patch',
        'PATCH',
        'testPatch',
        false,
        'application/json',
      );
      actionRequest.setParams({ param: 'test' });
      const response = await actionRequest.execute();
      expect(mockedAxios.patch).toHaveBeenCalled();
      expect(response.data.success).toBe(true);
    });

    it('throws an error for unsupported HTTP methods', async () => {
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/invalid',
        'INVALID',
        'testInvalid',
        false,
        'application/json',
      );
      await expect(actionRequest.execute()).rejects.toThrow('Unsupported HTTP method: invalid');
    });

    it('replaces path parameters with values from toolInput', async () => {
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/stocks/{stocksTicker}/bars/{multiplier}',
        'GET',
        'getAggregateBars',
        false,
        'application/json',
      );

      const executor = actionRequest.createExecutor();
      executor.setParams({
        stocksTicker: 'AAPL',
        multiplier: 5,
        startDate: '2023-01-01',
        endDate: '2023-12-31',
      });

      expect(executor.path).toBe('/stocks/AAPL/bars/5');
      expect(executor.params).toEqual({
        startDate: '2023-01-01',
        endDate: '2023-12-31',
      });

      await executor.execute();
      expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/stocks/AAPL/bars/5', {
        headers: expect.anything(),
        params: {
          startDate: '2023-01-01',
          endDate: '2023-12-31',
        },
      });
    });

    it('handles GET requests with header and query parameters', async () => {
      mockedAxios.get.mockResolvedValue({ data: { success: true } });

      const data: Record<string, unknown> = {
        'api-version': '2025-01-01',
        'some-header': 'header-var',
      };

      const loc: Record<string, 'query' | 'path' | 'header' | 'body'> = {
        'api-version': 'query',
        'some-header': 'header',
      };

      const actionRequest = new ActionRequest(
        'https://example.com',
        '/get',
        'GET',
        'testGET',
        false,
        '',
        loc,
      );
      const executer = actionRequest.setParams(data);
      const response = await executer.execute();
      expect(mockedAxios.get).toHaveBeenCalled();

      const [url, config] = mockedAxios.get.mock.calls[0];
      expect(url).toBe('https://example.com/get');
      expect(config?.headers).toEqual({
        'some-header': 'header-var',
      });
      expect(config?.params).toEqual({
        'api-version': '2025-01-01',
      });
      expect(response.data.success).toBe(true);
    });

    it('handles GET requests with header and path parameters', async () => {
      mockedAxios.get.mockResolvedValue({ data: { success: true } });

      const data: Record<string, unknown> = {
        'user-id': '1',
        'some-header': 'header-var',
      };

      const loc: Record<string, 'query' | 'path' | 'header' | 'body'> = {
        'user-id': 'path',
        'some-header': 'header',
      };

      const actionRequest = new ActionRequest(
        'https://example.com',
        '/getwithpath/{user-id}',
        'GET',
        'testGETwithpath',
        false,
        '',
        loc,
      );
      const executer = actionRequest.setParams(data);
      const response = await executer.execute();
      expect(mockedAxios.get).toHaveBeenCalled();

      const [url, config] = mockedAxios.get.mock.calls[0];
      expect(url).toBe('https://example.com/getwithpath/1');
      expect(config?.headers).toEqual({
        'some-header': 'header-var',
      });
      expect(config?.params).toEqual({});
      expect(response.data.success).toBe(true);
    });

    it('handles POST requests with body, header and query parameters', async () => {
      mockedAxios.post.mockResolvedValue({ data: { success: true } });

      const data: Record<string, unknown> = {
        'api-version': '2025-01-01',
        message: 'a body parameter',
        'some-header': 'header-var',
      };

      const loc: Record<string, 'query' | 'path' | 'header' | 'body'> = {
        'api-version': 'query',
        message: 'body',
        'some-header': 'header',
      };

      const actionRequest = new ActionRequest(
        'https://example.com',
        '/post',
        'POST',
        'testPost',
        false,
        'application/json',
        loc,
      );
      const executer = actionRequest.setParams(data);
      const response = await executer.execute();
      expect(mockedAxios.post).toHaveBeenCalled();

      const [url, body, config] = mockedAxios.post.mock.calls[0];
      expect(url).toBe('https://example.com/post');
      expect(body).toEqual({ message: 'a body parameter' });
      expect(config?.headers).toEqual({
        'some-header': 'header-var',
        'Content-Type': 'application/json',
      });
      expect(config?.params).toEqual({
        'api-version': '2025-01-01',
      });
      expect(response.data.success).toBe(true);
    });

    it('handles PUT requests with body, header and query parameters', async () => {
      mockedAxios.put.mockResolvedValue({ data: { success: true } });

      const data: Record<string, unknown> = {
        'api-version': '2025-01-01',
        message: 'a body parameter',
        'some-header': 'header-var',
      };

      const loc: Record<string, 'query' | 'path' | 'header' | 'body'> = {
        'api-version': 'query',
        message: 'body',
        'some-header': 'header',
      };

      const actionRequest = new ActionRequest(
        'https://example.com',
        '/put',
        'PUT',
        'testPut',
        false,
        'application/json',
        loc,
      );
      const executer = actionRequest.setParams(data);
      const response = await executer.execute();
      expect(mockedAxios.put).toHaveBeenCalled();

      const [url, body, config] = mockedAxios.put.mock.calls[0];
      expect(url).toBe('https://example.com/put');
      expect(body).toEqual({ message: 'a body parameter' });
      expect(config?.headers).toEqual({
        'some-header': 'header-var',
        'Content-Type': 'application/json',
      });
      expect(config?.params).toEqual({
        'api-version': '2025-01-01',
      });
      expect(response.data.success).toBe(true);
    });

    it('handles PATCH requests with body, header and query parameters', async () => {
      mockedAxios.patch.mockResolvedValue({ data: { success: true } });

      const data: Record<string, unknown> = {
        'api-version': '2025-01-01',
        message: 'a body parameter',
        'some-header': 'header-var',
      };

      const loc: Record<string, 'query' | 'path' | 'header' | 'body'> = {
        'api-version': 'query',
        message: 'body',
        'some-header': 'header',
      };

      const actionRequest = new ActionRequest(
        'https://example.com',
        '/patch',
        'PATCH',
        'testPatch',
        false,
        'application/json',
        loc,
      );
      const executer = actionRequest.setParams(data);
      const response = await executer.execute();
      expect(mockedAxios.patch).toHaveBeenCalled();

      const [url, body, config] = mockedAxios.patch.mock.calls[0];
      expect(url).toBe('https://example.com/patch');
      expect(body).toEqual({ message: 'a body parameter' });
      expect(config?.headers).toEqual({
        'some-header': 'header-var',
        'Content-Type': 'application/json',
      });
      expect(config?.params).toEqual({
        'api-version': '2025-01-01',
      });
      expect(response.data.success).toBe(true);
    });

    it('handles DELETE requests with body, header and query parameters', async () => {
      mockedAxios.delete.mockResolvedValue({ data: { success: true } });

      const data: Record<string, unknown> = {
        'api-version': '2025-01-01',
        'message-id': '1',
        'some-header': 'header-var',
      };

      const loc: Record<string, 'query' | 'path' | 'header' | 'body'> = {
        'api-version': 'query',
        'message-id': 'body',
        'some-header': 'header',
      };

      const actionRequest = new ActionRequest(
        'https://example.com',
        '/delete',
        'DELETE',
        'testDelete',
        false,
        'application/json',
        loc,
      );
      const executer = actionRequest.setParams(data);
      const response = await executer.execute();
      expect(mockedAxios.delete).toHaveBeenCalled();

      const [url, config] = mockedAxios.delete.mock.calls[0];
      expect(url).toBe('https://example.com/delete');
      expect(config?.data).toEqual({ 'message-id': '1' });
      expect(config?.headers).toEqual({
        'some-header': 'header-var',
        'Content-Type': 'application/json',
      });
      expect(config?.params).toEqual({
        'api-version': '2025-01-01',
      });
      expect(response.data.success).toBe(true);
    });
  });

  it('throws an error for unsupported HTTP method', async () => {
    const actionRequest = new ActionRequest(
      'https://example.com',
      '/test',
      'INVALID',
      'testOp',
      false,
      'application/json',
    );
    await expect(actionRequest.execute()).rejects.toThrow('Unsupported HTTP method: invalid');
  });

  describe('SSRF-safe agent passthrough', () => {
    beforeEach(() => {
      mockedAxios.get.mockResolvedValue({ data: { success: true } });
      mockedAxios.post.mockResolvedValue({ data: { success: true } });
    });

    it('should pass httpAgent and httpsAgent to axios.create when provided', async () => {
      const mockHttpAgent = { keepAlive: true };
      const mockHttpsAgent = { keepAlive: true };

      const actionRequest = new ActionRequest(
        'https://example.com',
        '/test',
        'GET',
        'testOp',
        false,
        'application/json',
      );
      const executor = actionRequest.createExecutor();
      executor.setParams({ key: 'value' });
      await executor.execute({ httpAgent: mockHttpAgent, httpsAgent: mockHttpsAgent });

      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          httpAgent: mockHttpAgent,
          httpsAgent: mockHttpsAgent,
          maxRedirects: 0,
        }),
      );
    });

    it('should not include agent keys when no options are provided', async () => {
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/test',
        'GET',
        'testOp',
        false,
        'application/json',
      );
      const executor = actionRequest.createExecutor();
      executor.setParams({ key: 'value' });
      await executor.execute();

      const createArg = mockedAxios.create.mock.calls[
        mockedAxios.create.mock.calls.length - 1
      ][0] as Record<string, unknown>;
      expect(createArg).not.toHaveProperty('httpAgent');
      expect(createArg).not.toHaveProperty('httpsAgent');
    });

    it('should pass agents through for POST requests', async () => {
      const mockAgent = { ssrf: true };

      const actionRequest = new ActionRequest(
        'https://example.com',
        '/test',
        'POST',
        'testOp',
        false,
        'application/json',
      );
      const executor = actionRequest.createExecutor();
      executor.setParams({ body: 'data' });
      await executor.execute({ httpAgent: mockAgent, httpsAgent: mockAgent });

      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          httpAgent: mockAgent,
          httpsAgent: mockAgent,
        }),
      );
      expect(mockedAxios.post).toHaveBeenCalled();
    });
  });

  describe('ActionRequest Concurrent Execution', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockedAxios.get.mockImplementation(async (url, config) => ({
        data: { url, params: config?.params, headers: config?.headers },
      }));
    });

    it('maintains isolated state between concurrent executions with different parameters', async () => {
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/math/sqrt/{number}',
        'GET',
        'getSqrt',
        false,
        'application/json',
      );

      // Simulate concurrent requests with different numbers
      const numbers = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
      const requests = numbers.map((num) => ({
        number: num.toString(),
        precision: '2',
      }));

      const responses = await Promise.all(
        requests.map((params) => {
          const executor = actionRequest.createExecutor();
          return executor.setParams(params).execute();
        }),
      );

      // Verify each response used the correct path parameter
      responses.forEach((response, index) => {
        const expectedUrl = `https://example.com/math/sqrt/${numbers[index]}`;
        expect(response.data.url).toBe(expectedUrl);
        expect(response.data.params).toEqual({ precision: '2' });
      });

      // Verify the correct number of calls were made
      expect(mockedAxios.get).toHaveBeenCalledTimes(numbers.length);
    });

    it('maintains isolated authentication state between concurrent executions', async () => {
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/secure/resource/{id}',
        'GET',
        'getResource',
        false,
        'application/json',
      );

      const requests = [
        {
          params: { id: '1' },
          auth: {
            auth: {
              type: AuthTypeEnum.ServiceHttp,
              authorization_type: AuthorizationTypeEnum.Bearer,
            },
            api_key: 'token1',
          },
        },
        {
          params: { id: '2' },
          auth: {
            auth: {
              type: AuthTypeEnum.ServiceHttp,
              authorization_type: AuthorizationTypeEnum.Bearer,
            },
            api_key: 'token2',
          },
        },
      ];

      const responses = await Promise.all(
        requests.map(async ({ params, auth }) => {
          const executor = actionRequest.createExecutor();
          return (await executor.setParams(params).setAuth(auth)).execute();
        }),
      );

      // Verify each response had its own auth token
      responses.forEach((response, index) => {
        const expectedUrl = `https://example.com/secure/resource/${index + 1}`;
        expect(response.data.url).toBe(expectedUrl);
        expect(response.data.headers).toMatchObject({
          Authorization: `Bearer token${index + 1}`,
        });
      });
    });

    it('handles mixed authentication types concurrently', async () => {
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/api/{version}/data',
        'GET',
        'getData',
        false,
        'application/json',
      );

      const requests = [
        {
          params: { version: 'v1' },
          auth: {
            auth: {
              type: AuthTypeEnum.ServiceHttp,
              authorization_type: AuthorizationTypeEnum.Bearer,
            },
            api_key: 'bearer_token',
          },
        },
        {
          params: { version: 'v2' },
          auth: {
            auth: {
              type: AuthTypeEnum.ServiceHttp,
              authorization_type: AuthorizationTypeEnum.Basic,
            },
            api_key: 'basic:auth',
          },
        },
        {
          params: { version: 'v3' },
          auth: {
            auth: {
              type: AuthTypeEnum.ServiceHttp,
              authorization_type: AuthorizationTypeEnum.Custom,
              custom_auth_header: 'X-API-Key',
            },
            api_key: 'custom_key',
          },
        },
      ];

      const responses = await Promise.all(
        requests.map(async ({ params, auth }) => {
          const executor = actionRequest.createExecutor();
          return (await executor.setParams(params).setAuth(auth)).execute();
        }),
      );

      // Verify each response had the correct auth type and headers
      expect(responses[0].data.headers).toMatchObject({
        Authorization: 'Bearer bearer_token',
      });

      expect(responses[1].data.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from('basic:auth').toString('base64')}`,
      });

      expect(responses[2].data.headers).toMatchObject({
        'X-API-Key': 'custom_key',
      });
    });

    it('maintains parameter integrity during concurrent path parameter replacement', async () => {
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/users/{userId}/posts/{postId}',
        'GET',
        'getUserPost',
        false,
        'application/json',
      );

      const requests = [
        { userId: '1', postId: 'a', filter: 'recent' },
        { userId: '2', postId: 'b', filter: 'popular' },
        { userId: '3', postId: 'c', filter: 'trending' },
      ];

      const responses = await Promise.all(
        requests.map((params) => {
          const executor = actionRequest.createExecutor();
          return executor.setParams(params).execute();
        }),
      );

      responses.forEach((response, index) => {
        const expectedUrl = `https://example.com/users/${requests[index].userId}/posts/${requests[index].postId}`;
        expect(response.data.url).toBe(expectedUrl);
        expect(response.data.params).toEqual({ filter: requests[index].filter });
      });
    });

    it('preserves original ActionRequest state after multiple executions', async () => {
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/original/{param}',
        'GET',
        'testOp',
        false,
        'application/json',
      );

      // Store original values
      const originalPath = actionRequest.path;
      const originalDomain = actionRequest.domain;
      const originalMethod = actionRequest.method;

      // Perform multiple concurrent executions
      await Promise.all([
        actionRequest.createExecutor().setParams({ param: '1' }).execute(),
        actionRequest.createExecutor().setParams({ param: '2' }).execute(),
        actionRequest.createExecutor().setParams({ param: '3' }).execute(),
      ]);

      // Verify original ActionRequest remains unchanged
      expect(actionRequest.path).toBe(originalPath);
      expect(actionRequest.domain).toBe(originalDomain);
      expect(actionRequest.method).toBe(originalMethod);
    });

    it('shares immutable configuration between executors from the same ActionRequest', () => {
      const actionRequest = new ActionRequest(
        'https://example.com',
        '/api/{version}/data',
        'GET',
        'getData',
        false,
        'application/json',
      );

      // Create multiple executors
      const executor1 = actionRequest.createExecutor();
      const executor2 = actionRequest.createExecutor();
      const executor3 = actionRequest.createExecutor();

      // Test that the configuration properties are shared
      [executor1, executor2, executor3].forEach((executor) => {
        expect(executor.getConfig()).toBeDefined();
        expect(executor.getConfig()).toEqual({
          domain: 'https://example.com',
          basePath: '/api/{version}/data',
          method: 'GET',
          operation: 'getData',
          isConsequential: false,
          contentType: 'application/json',
        });
      });

      // Verify that config objects are the exact same instance (shared reference)
      expect(executor1.getConfig()).toBe(executor2.getConfig());
      expect(executor2.getConfig()).toBe(executor3.getConfig());

      // Verify that modifying mutable state doesn't affect other executors
      executor1.setParams({ version: 'v1' });
      executor2.setParams({ version: 'v2' });
      executor3.setParams({ version: 'v3' });

      expect(executor1.path).toBe('/api/v1/data');
      expect(executor2.path).toBe('/api/v2/data');
      expect(executor3.path).toBe('/api/v3/data');

      // Verify that the original config remains unchanged
      expect(executor1.getConfig().basePath).toBe('/api/{version}/data');
      expect(executor2.getConfig().basePath).toBe('/api/{version}/data');
      expect(executor3.getConfig().basePath).toBe('/api/{version}/data');
    });
  });
});

describe('Authentication Handling', () => {
  it('correctly sets Basic Auth header', async () => {
    const actionRequest = new ActionRequest(
      'https://example.com',
      '/test',
      'GET',
      'testOp',
      false,
      'application/json',
    );

    const api_key = 'user:pass';
    const encodedCredentials = Buffer.from('user:pass').toString('base64');

    const executor = actionRequest.createExecutor();
    await executor.setParams({ param1: 'value1' }).setAuth({
      auth: {
        type: AuthTypeEnum.ServiceHttp,
        authorization_type: AuthorizationTypeEnum.Basic,
      },
      api_key,
    });

    await executor.execute();
    expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/test', {
      headers: expect.objectContaining({
        Authorization: `Basic ${encodedCredentials}`,
        'Content-Type': 'application/json',
      }),
      params: { param1: 'value1' },
    });
  });

  it('correctly sets Bearer token', async () => {
    const actionRequest = new ActionRequest(
      'https://example.com',
      '/test',
      'GET',
      'testOp',
      false,
      'application/json',
    );

    const executor = actionRequest.createExecutor();
    await executor.setParams({ param1: 'value1' }).setAuth({
      auth: {
        type: AuthTypeEnum.ServiceHttp,
        authorization_type: AuthorizationTypeEnum.Bearer,
      },
      api_key: 'token123',
    });

    await executor.execute();
    expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/test', {
      headers: expect.objectContaining({
        Authorization: 'Bearer token123',
        'Content-Type': 'application/json',
      }),
      params: { param1: 'value1' },
    });
  });

  it('correctly sets API Key', async () => {
    const actionRequest = new ActionRequest(
      'https://example.com',
      '/test',
      'GET',
      'testOp',
      false,
      'application/json',
    );

    const executor = actionRequest.createExecutor();
    await executor.setParams({ param1: 'value1' }).setAuth({
      auth: {
        type: AuthTypeEnum.ServiceHttp,
        authorization_type: AuthorizationTypeEnum.Custom,
        custom_auth_header: 'X-API-KEY',
      },
      api_key: 'abc123',
    });

    await executor.execute();
    expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/test', {
      headers: expect.objectContaining({
        'X-API-KEY': 'abc123',
        'Content-Type': 'application/json',
      }),
      params: { param1: 'value1' },
    });
  });
});

describe('resolveRef', () => {
  it('correctly resolves $ref references in the OpenAPI spec', () => {
    const openapiSpec = whimsicalOpenapiSpec;
    const flowchartRequestRef = (
      openapiSpec.paths['/ai.chatgpt.render-flowchart']?.post
        ?.requestBody as OpenAPIV3.RequestBodyObject
    ).content['application/json'].schema;

    expect(flowchartRequestRef).toBeDefined();

    const resolvedSchemaObject = resolveRef(
      flowchartRequestRef as OpenAPIV3.ReferenceObject,
      openapiSpec.components,
    ) as OpenAPIV3.SchemaObject;

    expect(resolvedSchemaObject).toBeDefined();
    expect(resolvedSchemaObject.type).toBe('object');
    expect(resolvedSchemaObject.properties).toBeDefined();

    const properties = resolvedSchemaObject.properties as FlowchartSchema;
    expect(properties.mermaid).toBeDefined();
    expect(properties.mermaid.type).toBe('string');
  });
});

describe('resolveRef general cases', () => {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'TestSpec', version: '1.0.0' },
    paths: {},
    components: {
      schemas: {
        TestSchema: { type: 'string' },
      },
      parameters: {
        TestParam: {
          name: 'myParam',
          in: 'query',
          required: false,
          schema: { $ref: '#/components/schemas/TestSchema' },
        },
      },
      requestBodies: {
        TestRequestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TestSchema' },
            },
          },
        },
      },
    },
  } satisfies OpenAPIV3.Document;

  it('resolves schema refs correctly', () => {
    const schemaRef: OpenAPIV3.ReferenceObject = { $ref: '#/components/schemas/TestSchema' };
    const resolvedSchema = resolveRef<OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject>(
      schemaRef,
      spec.components,
    );
    expect(resolvedSchema.type).toEqual('string');
  });

  it('resolves parameter refs correctly, then schema within parameter', () => {
    const paramRef: OpenAPIV3.ReferenceObject = { $ref: '#/components/parameters/TestParam' };
    const resolvedParam = resolveRef<OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject>(
      paramRef,
      spec.components,
    );
    expect(resolvedParam.name).toEqual('myParam');
    expect(resolvedParam.in).toEqual('query');
    expect(resolvedParam.required).toBe(false);

    const paramSchema = resolveRef<OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject>(
      resolvedParam.schema as OpenAPIV3.ReferenceObject,
      spec.components,
    );
    expect(paramSchema.type).toEqual('string');
  });

  it('resolves requestBody refs correctly, then schema within requestBody', () => {
    const requestBodyRef: OpenAPIV3.ReferenceObject = {
      $ref: '#/components/requestBodies/TestRequestBody',
    };
    const resolvedRequestBody = resolveRef<OpenAPIV3.ReferenceObject | OpenAPIV3.RequestBodyObject>(
      requestBodyRef,
      spec.components,
    );

    expect(resolvedRequestBody.content['application/json']).toBeDefined();

    const schemaInRequestBody = resolveRef<OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject>(
      resolvedRequestBody.content['application/json'].schema as OpenAPIV3.ReferenceObject,
      spec.components,
    );

    expect(schemaInRequestBody.type).toEqual('string');
  });
});

describe('openapiToFunction', () => {
  it('converts OpenAPI spec to function signatures and request builders', () => {
    const { functionSignatures, requestBuilders } = openapiToFunction(getWeatherOpenapiSpec);
    expect(functionSignatures.length).toBe(1);
    expect(functionSignatures[0].name).toBe('GetCurrentWeather');

    const parameters = functionSignatures[0].parameters as ParametersSchema & {
      properties: {
        location: {
          type: 'string';
        };
        locations: {
          type: 'array';
          items: {
            type: 'object';
            properties: {
              city: {
                type: 'string';
              };
              state: {
                type: 'string';
              };
              countryCode: {
                type: 'string';
              };
              time: {
                type: 'string';
              };
            };
          };
        };
      };
    };

    expect(parameters).toBeDefined();
    expect(parameters.properties.locations).toBeDefined();
    expect(parameters.properties.locations.type).toBe('array');
    expect(parameters.properties.locations.items.type).toBe('object');

    expect(parameters.properties.locations.items.properties.city.type).toBe('string');
    expect(parameters.properties.locations.items.properties.state.type).toBe('string');
    expect(parameters.properties.locations.items.properties.countryCode.type).toBe('string');
    expect(parameters.properties.locations.items.properties.time.type).toBe('string');

    expect(requestBuilders).toHaveProperty('GetCurrentWeather');
    expect(requestBuilders.GetCurrentWeather).toBeInstanceOf(ActionRequest);
    expect(requestBuilders.GetCurrentWeather.contentType).toBe('application/json');
  });

  it('preserves OpenAPI spec content-type', () => {
    const { functionSignatures, requestBuilders } = openapiToFunction(formOpenAPISpec);
    expect(functionSignatures.length).toBe(1);
    expect(functionSignatures[0].name).toBe('SubmitForm');

    const parameters = functionSignatures[0].parameters as ParametersSchema & {
      properties: {
        'entry.123': {
          type: 'string';
        };
        'entry.456': {
          type: 'string';
        };
      };
    };

    expect(parameters).toBeDefined();
    expect(parameters.properties['entry.123']).toBeDefined();
    expect(parameters.properties['entry.123'].type).toBe('string');
    expect(parameters.properties['entry.456']).toBeDefined();
    expect(parameters.properties['entry.456'].type).toBe('string');

    expect(requestBuilders).toHaveProperty('SubmitForm');
    expect(requestBuilders.SubmitForm).toBeInstanceOf(ActionRequest);
    expect(requestBuilders.SubmitForm.contentType).toBe('application/x-www-form-urlencoded');
  });

  describe('openapiToFunction with $ref resolution', () => {
    it('correctly converts OpenAPI spec to function signatures and request builders, resolving $ref references', () => {
      const { functionSignatures, requestBuilders } = openapiToFunction(whimsicalOpenapiSpec);

      expect(functionSignatures.length).toBeGreaterThan(0);

      const postRenderFlowchartSignature = functionSignatures.find(
        (sig) => sig.name === 'postRenderFlowchart',
      );
      expect(postRenderFlowchartSignature).toBeDefined();
      expect(postRenderFlowchartSignature?.name).toBe('postRenderFlowchart');
      expect(postRenderFlowchartSignature?.parameters).toBeDefined();

      expect(requestBuilders).toHaveProperty('postRenderFlowchart');
      const postRenderFlowchartRequestBuilder = requestBuilders['postRenderFlowchart'];
      expect(postRenderFlowchartRequestBuilder).toBeDefined();
      expect(postRenderFlowchartRequestBuilder.method).toBe('post');
      expect(postRenderFlowchartRequestBuilder.path).toBe('/ai.chatgpt.render-flowchart');
    });
  });
});

const invalidServerURL = 'Could not find a valid URL in `servers`';

describe('validateAndParseOpenAPISpec', () => {
  it('validates a correct OpenAPI spec successfully', () => {
    const validSpec = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0.0' },
      servers: [{ url: 'https://test.api' }],
      paths: { '/test': {} },
      components: { schemas: {} },
    });

    const result = validateAndParseOpenAPISpec(validSpec);
    expect(result.status).toBe(true);
    expect(result.message).toBe('OpenAPI spec is valid.');
  });

  it('returns an error for spec with no servers', () => {
    const noServerSpec = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0.0' },
      paths: { '/test': {} },
      components: { schemas: {} },
    });

    const result = validateAndParseOpenAPISpec(noServerSpec);
    expect(result.status).toBe(false);
    expect(result.message).toBe(invalidServerURL);
  });

  it('returns an error for spec with empty server URL', () => {
    const emptyURLSpec = `{
      "openapi": "3.1.0",
      "info": {
        "title": "Untitled",
        "description": "Your OpenAPI specification",
        "version": "v1.0.0"
      },
      "servers": [
        {
          "url": ""
        }
      ],
      "paths": {},
      "components": {
        "schemas": {}
      }
    }`;

    const result = validateAndParseOpenAPISpec(emptyURLSpec);
    expect(result.status).toBe(false);
    expect(result.message).toBe(invalidServerURL);
  });

  it('returns an error for spec with no paths', () => {
    const noPathsSpec = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0.0' },
      servers: [{ url: 'https://test.api' }],
      components: { schemas: {} },
    });

    const result = validateAndParseOpenAPISpec(noPathsSpec);
    expect(result.status).toBe(false);
    expect(result.message).toBe('No paths found in the OpenAPI spec.');
  });

  it('detects missing components in spec', () => {
    const missingComponentSpec = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0.0' },
      servers: [{ url: 'https://test.api' }],
      paths: {
        '/test': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Missing' } },
                },
              },
            },
          },
        },
      },
    });

    const result = validateAndParseOpenAPISpec(missingComponentSpec);
    expect(result.status).toBe(true);
    expect(result.message).toContain('reference to unknown component Missing');
    expect(result.spec).toBeDefined();
  });

  it('handles invalid spec formats', () => {
    const invalidSpec = 'not a valid spec';

    const result = validateAndParseOpenAPISpec(invalidSpec);
    expect(result.status).toBe(false);
    expect(result.message).toBe(invalidServerURL);
  });

  it('handles YAML spec and correctly converts to Function Signatures', () => {
    const result = validateAndParseOpenAPISpec(scholarAIOpenapiSpec);
    expect(result.status).toBe(true);

    const spec = result.spec;
    expect(spec).toBeDefined();

    const { functionSignatures, requestBuilders } = openapiToFunction(spec as OpenAPIV3.Document);
    expect(functionSignatures.length).toBe(3);
    expect(requestBuilders).toHaveProperty('searchAbstracts');
    expect(requestBuilders).toHaveProperty('getFullText');
    expect(requestBuilders).toHaveProperty('saveCitation');
  });
});

describe('createURL', () => {
  it('correctly combines domain and path', () => {
    expect(createURL('https://example.com', '/api/v1/users')).toBe(
      'https://example.com/api/v1/users',
    );
  });

  it('handles domain with trailing slash', () => {
    expect(createURL('https://example.com/', '/api/v1/users')).toBe(
      'https://example.com/api/v1/users',
    );
  });

  it('handles path with leading slash', () => {
    expect(createURL('https://example.com', 'api/v1/users')).toBe(
      'https://example.com/api/v1/users',
    );
  });

  it('handles domain with trailing slash and path with leading slash', () => {
    expect(createURL('https://example.com/', '/api/v1/users')).toBe(
      'https://example.com/api/v1/users',
    );
  });

  it('handles domain without trailing slash and path without leading slash', () => {
    expect(createURL('https://example.com', 'api/v1/users')).toBe(
      'https://example.com/api/v1/users',
    );
  });

  it('handles empty path', () => {
    expect(createURL('https://example.com', '')).toBe('https://example.com/');
  });

  it('handles domain with subdirectory', () => {
    expect(createURL('https://example.com/subdirectory', '/api/v1/users')).toBe(
      'https://example.com/subdirectory/api/v1/users',
    );
  });

  describe('openapiToFunction zodSchemas', () => {
    describe('getWeatherOpenapiSpec', () => {
      const { zodSchemas } = openapiToFunction(getWeatherOpenapiSpec, true);

      it('generates correct Zod schema for GetCurrentWeather', () => {
        expect(zodSchemas).toBeDefined();
        expect(zodSchemas?.GetCurrentWeather).toBeDefined();

        const GetCurrentWeatherSchema = zodSchemas?.GetCurrentWeather;

        expect(GetCurrentWeatherSchema instanceof z.ZodObject).toBe(true);

        if (!(GetCurrentWeatherSchema instanceof z.ZodObject)) {
          throw new Error('GetCurrentWeatherSchema is not a ZodObject');
        }

        const shape = GetCurrentWeatherSchema.shape;
        expect(shape.location instanceof z.ZodString).toBe(true);

        // Check locations property
        expect(shape.locations).toBeDefined();
        expect(shape.locations instanceof z.ZodOptional).toBe(true);

        if (!(shape.locations instanceof z.ZodOptional)) {
          throw new Error('locations is not a ZodOptional');
        }

        const locationsInnerType = shape.locations._def.innerType;
        expect(locationsInnerType instanceof z.ZodArray).toBe(true);

        if (!(locationsInnerType instanceof z.ZodArray)) {
          throw new Error('locationsInnerType is not a ZodArray');
        }

        const locationsItemSchema = locationsInnerType.element;
        expect(locationsItemSchema instanceof z.ZodObject).toBe(true);

        if (!(locationsItemSchema instanceof z.ZodObject)) {
          throw new Error('locationsItemSchema is not a ZodObject');
        }

        // Validate the structure of locationsItemSchema
        expect(locationsItemSchema.shape.city instanceof z.ZodString).toBe(true);
        expect(locationsItemSchema.shape.state instanceof z.ZodString).toBe(true);
        expect(locationsItemSchema.shape.countryCode instanceof z.ZodString).toBe(true);

        // Check if time is optional
        const timeSchema = locationsItemSchema.shape.time;
        expect(timeSchema instanceof z.ZodOptional).toBe(true);

        if (!(timeSchema instanceof z.ZodOptional)) {
          throw new Error('timeSchema is not a ZodOptional');
        }

        expect(timeSchema._def.innerType instanceof z.ZodString).toBe(true);

        // Check the description
        expect(shape.locations._def.description).toBe(
          'A list of locations to retrieve the weather for.',
        );
      });

      it('validates correct data for GetCurrentWeather', () => {
        const GetCurrentWeatherSchema = zodSchemas?.GetCurrentWeather as z.ZodTypeAny;
        const validData = {
          location: 'New York',
          locations: [
            { city: 'New York', state: 'NY', countryCode: 'US', time: '2023-12-04T14:00:00Z' },
          ],
        };
        expect(() => GetCurrentWeatherSchema.parse(validData)).not.toThrow();
      });

      it('throws error for invalid data for GetCurrentWeather', () => {
        const GetCurrentWeatherSchema = zodSchemas?.GetCurrentWeather as z.ZodTypeAny;
        const invalidData = {
          location: 123,
          locations: [{ city: 'New York', state: 'NY', countryCode: 'US', time: 'invalid-time' }],
        };
        expect(() => GetCurrentWeatherSchema.parse(invalidData)).toThrow();
      });
    });

    describe('whimsicalOpenapiSpec', () => {
      const { zodSchemas } = openapiToFunction(whimsicalOpenapiSpec, true);

      it('generates correct Zod schema for postRenderFlowchart', () => {
        expect(zodSchemas).toBeDefined();
        expect(zodSchemas?.postRenderFlowchart).toBeDefined();

        const PostRenderFlowchartSchema = zodSchemas?.postRenderFlowchart;
        expect(PostRenderFlowchartSchema).toBeInstanceOf(z.ZodObject);

        if (!(PostRenderFlowchartSchema instanceof z.ZodObject)) {
          return;
        }

        const shape = PostRenderFlowchartSchema.shape;
        expect(shape.mermaid).toBeInstanceOf(z.ZodString);
        expect(shape.title).toBeInstanceOf(z.ZodOptional);
        expect((shape.title as z.ZodOptional<z.ZodString>)._def.innerType).toBeInstanceOf(
          z.ZodString,
        );
      });

      it('validates correct data for postRenderFlowchart', () => {
        const PostRenderFlowchartSchema = zodSchemas?.postRenderFlowchart;
        const validData = {
          mermaid: 'graph TD; A-->B; B-->C; C-->D;',
          title: 'Test Flowchart',
        };
        expect(() => PostRenderFlowchartSchema?.parse(validData)).not.toThrow();
      });

      it('throws error for invalid data for postRenderFlowchart', () => {
        const PostRenderFlowchartSchema = zodSchemas?.postRenderFlowchart;
        const invalidData = {
          mermaid: 123,
          title: 42,
        };
        expect(() => PostRenderFlowchartSchema?.parse(invalidData)).toThrow();
      });
    });

    describe('scholarAIOpenapiSpec', () => {
      const result = validateAndParseOpenAPISpec(scholarAIOpenapiSpec);
      const spec = result.spec as OpenAPIV3.Document;
      const { zodSchemas } = openapiToFunction(spec, true);

      it('generates correct Zod schema for searchAbstracts', () => {
        expect(zodSchemas).toBeDefined();
        expect(zodSchemas?.searchAbstracts).toBeDefined();

        const SearchAbstractsSchema = zodSchemas?.searchAbstracts;
        expect(SearchAbstractsSchema).toBeInstanceOf(z.ZodObject);

        if (!(SearchAbstractsSchema instanceof z.ZodObject)) {
          return;
        }

        const shape = SearchAbstractsSchema.shape;
        expect(shape.keywords).toBeInstanceOf(z.ZodString);
        expect(shape.sort).toBeInstanceOf(z.ZodOptional);
        expect(
          (shape.sort as z.ZodOptional<z.ZodEnum<[string, ...string[]]>>)._def.innerType,
        ).toBeInstanceOf(z.ZodEnum);
        expect(shape.query).toBeInstanceOf(z.ZodString);
        expect(shape.peer_reviewed_only).toBeInstanceOf(z.ZodOptional);
        expect(shape.start_year).toBeInstanceOf(z.ZodOptional);
        expect(shape.end_year).toBeInstanceOf(z.ZodOptional);
        expect(shape.offset).toBeInstanceOf(z.ZodOptional);
      });

      it('validates correct data for searchAbstracts', () => {
        const SearchAbstractsSchema = zodSchemas?.searchAbstracts;
        const validData = {
          keywords: 'machine learning',
          sort: 'cited_by_count',
          query: 'AI applications',
          peer_reviewed_only: 'true',
          start_year: '2020',
          end_year: '2023',
          offset: '0',
        };
        expect(() => SearchAbstractsSchema?.parse(validData)).not.toThrow();
      });

      it('throws error for invalid data for searchAbstracts', () => {
        const SearchAbstractsSchema = zodSchemas?.searchAbstracts;
        const invalidData = {
          keywords: 123,
          sort: 'invalid_sort',
          query: 42,
          peer_reviewed_only: 'maybe',
          start_year: 2020,
          end_year: 2023,
          offset: 0,
        };
        expect(() => SearchAbstractsSchema?.parse(invalidData)).toThrow();
      });

      it('generates correct Zod schema for getFullText', () => {
        expect(zodSchemas?.getFullText).toBeDefined();

        const GetFullTextSchema = zodSchemas?.getFullText;
        expect(GetFullTextSchema).toBeInstanceOf(z.ZodObject);

        if (!(GetFullTextSchema instanceof z.ZodObject)) {
          return;
        }

        const shape = GetFullTextSchema.shape;
        expect(shape.pdf_url).toBeInstanceOf(z.ZodString);
        expect(shape.chunk).toBeInstanceOf(z.ZodOptional);
        expect((shape.chunk as z.ZodOptional<z.ZodNumber>)._def.innerType).toBeInstanceOf(
          z.ZodNumber,
        );
      });

      it('generates correct Zod schema for saveCitation', () => {
        expect(zodSchemas?.saveCitation).toBeDefined();

        const SaveCitationSchema = zodSchemas?.saveCitation;
        expect(SaveCitationSchema).toBeInstanceOf(z.ZodObject);

        if (!(SaveCitationSchema instanceof z.ZodObject)) {
          return;
        }

        const shape = SaveCitationSchema.shape;
        expect(shape.doi).toBeInstanceOf(z.ZodString);
        expect(shape.zotero_user_id).toBeInstanceOf(z.ZodString);
        expect(shape.zotero_api_key).toBeInstanceOf(z.ZodString);
      });
    });
  });

  describe('openapiToFunction zodSchemas for SWAPI', () => {
    const result = validateAndParseOpenAPISpec(swapidev);
    const spec = result.spec as OpenAPIV3.Document;
    const { zodSchemas } = openapiToFunction(spec, true);

    describe('getPeople schema', () => {
      it('does not generate Zod schema for getPeople (no parameters)', () => {
        expect(zodSchemas).toBeDefined();
        expect(zodSchemas?.getPeople).toBeUndefined();
      });

      it('validates correct data for getPeople', () => {
        const GetPeopleSchema = zodSchemas?.getPeople;
        expect(GetPeopleSchema).toBeUndefined();
      });

      it('does not throw for invalid data for getPeople', () => {
        const GetPeopleSchema = zodSchemas?.getPeople;
        expect(GetPeopleSchema).toBeUndefined();
      });
    });

    describe('getPersonById schema', () => {
      it('generates correct Zod schema for getPersonById', () => {
        expect(zodSchemas).toBeDefined();
        expect(zodSchemas?.getPersonById).toBeDefined();

        const GetPersonByIdSchema = zodSchemas?.getPersonById;
        expect(GetPersonByIdSchema).toBeInstanceOf(z.ZodObject);

        if (!(GetPersonByIdSchema instanceof z.ZodObject)) {
          return;
        }

        const shape = GetPersonByIdSchema.shape;
        expect(shape.id).toBeInstanceOf(z.ZodString);
      });

      it('validates correct data for getPersonById', () => {
        const GetPersonByIdSchema = zodSchemas?.getPersonById;
        const validData = { id: '1' };
        expect(() => GetPersonByIdSchema?.parse(validData)).not.toThrow();
      });

      it('throws error for invalid data for getPersonById', () => {
        const GetPersonByIdSchema = zodSchemas?.getPersonById;
        const invalidData = { id: 1 }; // should be string
        expect(() => GetPersonByIdSchema?.parse(invalidData)).toThrow();
      });
    });
  });

  describe('openapiToFunction parameter refs resolution', () => {
    const weatherSpec = {
      openapi: '3.0.0',
      info: { title: 'Weather', version: '1.0.0' },
      servers: [{ url: 'https://api.weather.gov' }],
      paths: {
        '/points/{point}': {
          get: {
            operationId: 'getPoint',
            parameters: [{ $ref: '#/components/parameters/PathPoint' }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      components: {
        parameters: {
          PathPoint: {
            name: 'point',
            in: 'path',
            required: true,
            schema: { type: 'string', pattern: '^(-?\\d+(?:\\.\\d+)?),(-?\\d+(?:\\.\\d+)?)$' },
          },
        },
      },
    } satisfies OpenAPIV3.Document;

    it('correctly resolves $ref for parameters', () => {
      const { functionSignatures } = openapiToFunction(weatherSpec, true);
      const func = functionSignatures.find((sig) => sig.name === 'getPoint');
      expect(func).toBeDefined();
      expect(func?.parameters.properties).toHaveProperty('point');
      expect(func?.parameters.required).toContain('point');

      const paramSchema = func?.parameters.properties['point'] as OpenAPIV3.SchemaObject;
      expect(paramSchema.type).toEqual('string');
      expect(paramSchema.pattern).toEqual('^(-?\\d+(?:\\.\\d+)?),(-?\\d+(?:\\.\\d+)?)$');
    });
  });
});

describe('SSRF Protection', () => {
  describe('extractDomainFromUrl', () => {
    it('extracts domain from valid HTTPS URL', () => {
      expect(extractDomainFromUrl('https://example.com')).toBe('https://example.com');
      expect(extractDomainFromUrl('https://example.com/path')).toBe('https://example.com');
      expect(extractDomainFromUrl('https://example.com:8080')).toBe('https://example.com');
      expect(extractDomainFromUrl('https://example.com:8080/path?query=value')).toBe(
        'https://example.com',
      );
    });

    it('extracts domain from valid HTTP URL', () => {
      expect(extractDomainFromUrl('http://example.com')).toBe('http://example.com');
      expect(extractDomainFromUrl('http://example.com/api')).toBe('http://example.com');
    });

    it('handles subdomains correctly', () => {
      expect(extractDomainFromUrl('https://api.example.com')).toBe('https://api.example.com');
      expect(extractDomainFromUrl('https://subdomain.api.example.com/path')).toBe(
        'https://subdomain.api.example.com',
      );
    });

    it('throws error for invalid URLs', () => {
      expect(() => extractDomainFromUrl('not-a-url')).toThrow('Invalid URL format');
      expect(() => extractDomainFromUrl('')).toThrow('Invalid URL format');
      expect(() => extractDomainFromUrl('example.com')).toThrow('Invalid URL format');
    });

    it('preserves protocol to prevent HTTP/HTTPS confusion', () => {
      const httpsDomain = extractDomainFromUrl('https://example.com/path');
      const httpDomain = extractDomainFromUrl('http://example.com/path');
      expect(httpsDomain).not.toBe(httpDomain);
      expect(httpsDomain).toBe('https://example.com');
      expect(httpDomain).toBe('http://example.com');
    });

    it('handles internal/private IP addresses', () => {
      expect(extractDomainFromUrl('http://192.168.1.1')).toBe('http://192.168.1.1');
      expect(extractDomainFromUrl('http://10.0.0.1/admin')).toBe('http://10.0.0.1');
      expect(extractDomainFromUrl('http://172.16.0.1')).toBe('http://172.16.0.1');
      expect(extractDomainFromUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1');
    });

    it('handles cloud metadata service URLs', () => {
      // AWS EC2 metadata
      expect(extractDomainFromUrl('http://169.254.169.254/latest/meta-data/')).toBe(
        'http://169.254.169.254',
      );
      // Google Cloud metadata
      expect(extractDomainFromUrl('http://metadata.google.internal/computeMetadata/v1/')).toBe(
        'http://metadata.google.internal',
      );
      // Azure metadata
      expect(extractDomainFromUrl('http://169.254.169.254/metadata/instance')).toBe(
        'http://169.254.169.254',
      );
    });

    it('handles IPv6 URLs with brackets correctly', () => {
      expect(extractDomainFromUrl('http://[::1]/')).toBe('http://[::1]');
      expect(extractDomainFromUrl('http://[::1]:8080')).toBe('http://[::1]');
      expect(extractDomainFromUrl('https://[2001:db8::1]/api')).toBe('https://[2001:db8::1]');
      expect(extractDomainFromUrl('http://[fe80::1]/path')).toBe('http://[fe80::1]');
    });

    it('handles complex IPv6 addresses', () => {
      expect(extractDomainFromUrl('http://[2001:db8:85a3::8a2e:370:7334]/api')).toBe(
        'http://[2001:db8:85a3::8a2e:370:7334]',
      );
      // Node.js normalizes IPv4-mapped IPv6 to hex form
      expect(extractDomainFromUrl('https://[::ffff:192.168.1.1]:8080')).toBe(
        'https://[::ffff:c0a8:101]',
      );
    });

    it('handles URLs with authentication credentials', () => {
      expect(extractDomainFromUrl('https://user:pass@example.com/api')).toBe('https://example.com');
      expect(extractDomainFromUrl('http://admin@192.168.1.1:8080')).toBe('http://192.168.1.1');
    });

    it('handles URLs with special characters in path', () => {
      expect(extractDomainFromUrl('https://example.com/path%20with%20spaces')).toBe(
        'https://example.com',
      );
      expect(extractDomainFromUrl('https://example.com/path#fragment')).toBe('https://example.com');
      expect(extractDomainFromUrl('https://example.com/?query=value&other=123')).toBe(
        'https://example.com',
      );
    });

    it('handles localhost variations', () => {
      expect(extractDomainFromUrl('http://localhost/')).toBe('http://localhost');
      expect(extractDomainFromUrl('https://localhost:3000')).toBe('https://localhost');
      expect(extractDomainFromUrl('http://localhost.localdomain')).toBe(
        'http://localhost.localdomain',
      );
    });

    it('handles internationalized domain names', () => {
      expect(extractDomainFromUrl('https://xn--e1afmkfd.xn--p1ai/api')).toBe(
        'https://xn--e1afmkfd.xn--p1ai',
      );
      // Node.js URL parser converts IDN to punycode
      expect(extractDomainFromUrl('https://münchen.de')).toBe('https://xn--mnchen-3ya.de');
    });

    it('throws error for non-HTTP/HTTPS protocols in extractDomainFromUrl', () => {
      expect(() => extractDomainFromUrl('ftp://example.com')).not.toThrow();
      expect(extractDomainFromUrl('ftp://example.com')).toBe('ftp://example.com');
      // Note: The function doesn't validate protocol, just extracts domain
    });
  });

  describe('validateAndParseOpenAPISpec - SSRF Prevention', () => {
    it('returns serverUrl for valid spec', () => {
      const validSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        servers: [{ url: 'https://example.com' }],
        paths: { '/test': {} },
      });

      const result = validateAndParseOpenAPISpec(validSpec);
      expect(result.status).toBe(true);
      expect(result.serverUrl).toBe('https://example.com');
    });

    it('extracts serverUrl even with path in server URL', () => {
      const specWithPath = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        servers: [{ url: 'https://example.com/api/v1' }],
        paths: { '/test': {} },
      });

      const result = validateAndParseOpenAPISpec(specWithPath);
      expect(result.status).toBe(true);
      expect(result.serverUrl).toBe('https://example.com/api/v1');
    });

    it('detects potential SSRF attempts with internal IPs', () => {
      const internalIPSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        servers: [{ url: 'http://192.168.1.1' }],
        paths: { '/test': {} },
      });

      const result = validateAndParseOpenAPISpec(internalIPSpec);
      expect(result.status).toBe(true);
      expect(result.serverUrl).toBe('http://192.168.1.1');
    });

    it('detects potential SSRF attempts with localhost', () => {
      const localhostSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        servers: [{ url: 'http://localhost:8080' }],
        paths: { '/test': {} },
      });

      const result = validateAndParseOpenAPISpec(localhostSpec);
      expect(result.status).toBe(true);
      expect(result.serverUrl).toBe('http://localhost:8080');
    });

    it('detects potential SSRF attempts with cloud metadata services', () => {
      const awsMetadataSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        servers: [{ url: 'http://169.254.169.254/latest/meta-data/' }],
        paths: { '/test': {} },
      });

      const result = validateAndParseOpenAPISpec(awsMetadataSpec);
      expect(result.status).toBe(true);
      expect(result.serverUrl).toBe('http://169.254.169.254/latest/meta-data/');
    });

    it('handles multiple servers and returns the first one', () => {
      const multiServerSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com' }, { url: 'https://backup.example.com' }],
        paths: { '/test': {} },
      });

      const result = validateAndParseOpenAPISpec(multiServerSpec);
      expect(result.status).toBe(true);
      expect(result.serverUrl).toBe('https://api.example.com');
    });
  });

  describe('SSRF Attack Scenarios', () => {
    it('scenario: attacker tries to use whitelisted domain but different spec URL', () => {
      const maliciousSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Malicious API', version: '1.0.0' },
        servers: [{ url: 'http://169.254.169.254/latest/meta-data/' }], // AWS metadata service
        paths: { '/': { get: { summary: 'Get metadata', operationId: 'getMetadata' } } },
      });

      const result = validateAndParseOpenAPISpec(maliciousSpec);
      expect(result.status).toBe(true);
      expect(result.serverUrl).toBe('http://169.254.169.254/latest/meta-data/');

      // The fix ensures this serverUrl would be validated against the domain whitelist
      const extractedDomain = extractDomainFromUrl(result.serverUrl!);
      expect(extractedDomain).toBe('http://169.254.169.254');

      // In the actual validation, this would not match a whitelisted 'example.com'
      expect(extractedDomain).not.toContain('example.com');
    });

    it('scenario: attacker tries to use internal network IP', () => {
      const internalNetworkSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Internal API', version: '1.0.0' },
        servers: [{ url: 'http://10.0.0.1:8080/admin' }],
        paths: { '/': { get: { summary: 'Admin endpoint', operationId: 'getAdmin' } } },
      });

      const result = validateAndParseOpenAPISpec(internalNetworkSpec);
      expect(result.status).toBe(true);
      expect(result.serverUrl).toBe('http://10.0.0.1:8080/admin');

      const extractedDomain = extractDomainFromUrl(result.serverUrl!);
      expect(extractedDomain).toBe('http://10.0.0.1');
      expect(extractedDomain).not.toContain('example.com');
    });

    it('scenario: attacker tries to access Google Cloud metadata', () => {
      const gcpMetadataSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'GCP Metadata', version: '1.0.0' },
        servers: [{ url: 'http://metadata.google.internal/computeMetadata/v1/' }],
        paths: { '/': { get: { summary: 'Get GCP metadata', operationId: 'getGCPMetadata' } } },
      });

      const result = validateAndParseOpenAPISpec(gcpMetadataSpec);
      expect(result.status).toBe(true);
      expect(result.serverUrl).toBe('http://metadata.google.internal/computeMetadata/v1/');

      const extractedDomain = extractDomainFromUrl(result.serverUrl!);
      expect(extractedDomain).toBe('http://metadata.google.internal');
      expect(extractedDomain).not.toContain('example.com');
    });

    it('scenario: legitimate use case with correct domain matching', () => {
      const legitimateSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Legitimate API', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com/v1' }],
        paths: { '/data': { get: { summary: 'Get data', operationId: 'getData' } } },
      });

      const result = validateAndParseOpenAPISpec(legitimateSpec);
      expect(result.status).toBe(true);
      expect(result.serverUrl).toBe('https://api.example.com/v1');

      const extractedDomain = extractDomainFromUrl(result.serverUrl!);
      expect(extractedDomain).toBe('https://api.example.com');

      // This should match when client provides 'api.example.com' or 'https://api.example.com'
      const clientProvidedDomain = 'api.example.com';
      const normalizedClientDomain = `https://${clientProvidedDomain}`;
      expect(extractedDomain).toBe(normalizedClientDomain);
    });

    it('scenario: protocol mismatch should be detected', () => {
      const httpSpec = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'HTTP API', version: '1.0.0' },
        servers: [{ url: 'http://example.com' }],
        paths: { '/': { get: { summary: 'Get data', operationId: 'getData' } } },
      });

      const result = validateAndParseOpenAPISpec(httpSpec);
      expect(result.status).toBe(true);
      expect(result.serverUrl).toBe('http://example.com');

      const extractedDomain = extractDomainFromUrl(result.serverUrl!);
      expect(extractedDomain).toBe('http://example.com');

      // If client provided 'https://example.com', there would be a mismatch
      const clientProvidedHttps = 'https://example.com';
      expect(extractedDomain).not.toBe(clientProvidedHttps);
    });
  });

  describe('validateActionDomain', () => {
    it('validates matching domains with HTTPS protocol', () => {
      const result = validateActionDomain('example.com', 'https://example.com/api/v1');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('https://example.com');
      expect(result.normalizedClientDomain).toBe('https://example.com');
    });

    it('validates matching domains when client provides full URL', () => {
      const result = validateActionDomain('https://example.com', 'https://example.com/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('https://example.com');
      expect(result.normalizedClientDomain).toBe('https://example.com');
    });

    it('rejects mismatched domains', () => {
      const result = validateActionDomain('example.com', 'https://malicious.com/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.message).toContain('example.com');
      expect(result.message).toContain('malicious.com');
    });

    it('detects SSRF attempt with internal IP', () => {
      const result = validateActionDomain('example.com', 'http://192.168.1.1/admin');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.normalizedSpecDomain).toBe('http://192.168.1.1');
    });

    it('detects SSRF attempt with AWS metadata service', () => {
      const result = validateActionDomain(
        'api.example.com',
        'http://169.254.169.254/latest/meta-data/',
      );
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.normalizedSpecDomain).toBe('http://169.254.169.254');
    });

    it('detects SSRF attempt with localhost', () => {
      const result = validateActionDomain('example.com', 'http://localhost:8080/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.normalizedSpecDomain).toBe('http://localhost');
    });

    it('detects protocol mismatch (HTTP vs HTTPS)', () => {
      const result = validateActionDomain('https://example.com', 'http://example.com/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.normalizedSpecDomain).toBe('http://example.com');
      expect(result.normalizedClientDomain).toBe('https://example.com');
    });

    it('validates matching subdomains', () => {
      const result = validateActionDomain('api.example.com', 'https://api.example.com/v1');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('https://api.example.com');
    });

    it('rejects different subdomains', () => {
      const result = validateActionDomain('api.example.com', 'https://admin.example.com/v1');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('handles invalid server URL gracefully', () => {
      const result = validateActionDomain('example.com', 'not-a-valid-url');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Failed to validate domain');
    });

    it('preserves custom ports when the client domain omits a port', () => {
      const result = validateActionDomain('example.com', 'https://example.com:8443/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('https://example.com');
    });

    it('rejects a same-host OpenAPI server on a different metadata port', () => {
      const result = validateActionDomain(
        'https://example.com:8443',
        'https://example.com:9443/api',
      );
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Port mismatch');
    });

    it('rejects a different port when metadata has trailing whitespace', () => {
      const result = validateActionDomain(
        'https://example.com:8443 ',
        'https://example.com:9443/api',
      );
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Port mismatch');
    });

    it.each([
      ['an ASCII newline', '\n/path'],
      ['an ASCII tab', '\t/path'],
      ['a backslash', '\\path'],
    ])('rejects a different port when metadata contains %s', (_description, suffix) => {
      const result = validateActionDomain(
        `https://example.com:8443${suffix}`,
        'https://example.com:9443/api',
      );
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Port mismatch');
    });

    it('rejects reserved port zero', () => {
      const result = validateActionDomain('https://example.com:0', 'https://example.com:0/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid port');
    });

    it('rejects a same-IPv4 OpenAPI server on a different metadata port', () => {
      const result = validateActionDomain('http://127.0.0.1:38079', 'http://127.0.0.1:38080/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Port mismatch');
    });

    it('rejects a same-IPv6 OpenAPI server on a different metadata port', () => {
      const result = validateActionDomain('http://[::1]:8080', 'http://[::1]:8081/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Port mismatch');
    });

    it('validates matching custom ports for IPv6 domains', () => {
      const result = validateActionDomain('http://[::1]:8080', 'http://[::1]:8080/api');
      expect(result.isValid).toBe(true);
    });

    it('matches an explicit HTTPS default port to an omitted server port', () => {
      const result = validateActionDomain('https://example.com:443', 'https://example.com/api');
      expect(result.isValid).toBe(true);
    });

    it('matches an explicit HTTP default port to an omitted server port', () => {
      const result = validateActionDomain('http://example.com:80', 'http://example.com/api');
      expect(result.isValid).toBe(true);
    });

    it('rejects an omitted server port when metadata specifies a custom port', () => {
      const result = validateActionDomain('https://example.com:8443', 'https://example.com/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Port mismatch');
    });

    it('detects port-based SSRF attempt', () => {
      const result = validateActionDomain('example.com', 'http://example.com:6379/');
      expect(result.isValid).toBe(false);
      expect(result.normalizedSpecDomain).toBe('http://example.com');
      expect(result.normalizedClientDomain).toBe('https://example.com');
    });

    it('validates Google Cloud metadata service detection', () => {
      const result = validateActionDomain(
        'example.com',
        'http://metadata.google.internal/computeMetadata/v1/',
      );
      expect(result.isValid).toBe(false);
      expect(result.normalizedSpecDomain).toBe('http://metadata.google.internal');
    });

    it('validates Azure metadata service detection', () => {
      const result = validateActionDomain(
        'example.com',
        'http://169.254.169.254/metadata/instance',
      );
      expect(result.isValid).toBe(false);
      expect(result.normalizedSpecDomain).toBe('http://169.254.169.254');
    });

    it('handles edge case: client provides domain with protocol matching spec', () => {
      const result = validateActionDomain('http://example.com', 'http://example.com/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('http://example.com');
      expect(result.normalizedClientDomain).toBe('http://example.com');
    });

    it('validates real-world case: legitimate API with versioned path', () => {
      const result = validateActionDomain(
        'api.openai.com',
        'https://api.openai.com/v1/chat/completions',
      );
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('https://api.openai.com');
    });

    // Tests for IP address validation (fix for the reported issue)
    it('validates matching IP addresses when client provides just IP (no protocol)', () => {
      const result = validateActionDomain('10.225.26.25', 'http://10.225.26.25:7894/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('http://10.225.26.25');
      expect(result.normalizedClientDomain).toBe('http://10.225.26.25');
    });

    it('validates matching localhost IP when client provides just IP', () => {
      const result = validateActionDomain('127.0.0.1', 'http://127.0.0.1:8080/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('http://127.0.0.1');
      expect(result.normalizedClientDomain).toBe('http://127.0.0.1');
    });

    it('validates matching private network IP when client provides just IP', () => {
      const result = validateActionDomain('192.168.1.100', 'https://192.168.1.100:443/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('https://192.168.1.100');
      expect(result.normalizedClientDomain).toBe('https://192.168.1.100');
    });

    it('validates matching IP when client provides full URL with IP', () => {
      const result = validateActionDomain('http://10.225.26.25', 'http://10.225.26.25:7894');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('http://10.225.26.25');
      expect(result.normalizedClientDomain).toBe('http://10.225.26.25');
    });

    it('rejects mismatched IP addresses', () => {
      const result = validateActionDomain('10.225.26.25', 'http://10.225.26.26:7894/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.message).toContain('10.225.26.25');
      expect(result.message).toContain('10.225.26.26');
    });

    it('rejects IP when domain expected', () => {
      const result = validateActionDomain('example.com', 'http://192.168.1.1/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.normalizedSpecDomain).toBe('http://192.168.1.1');
    });

    it('rejects domain when IP expected', () => {
      const result = validateActionDomain('192.168.1.1', 'http://malicious.com/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.message).toContain('192.168.1.1');
      expect(result.message).toContain('malicious.com');
    });

    it('handles IPv6 addresses when client provides just IP', () => {
      const result = validateActionDomain('[::1]', 'http://[::1]:8080/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('http://[::1]');
      expect(result.normalizedClientDomain).toBe('http://[::1]');
    });

    // Additional IP-based SSRF tests for comprehensive security coverage
    it('prevents using whitelisted IP to access different IP', () => {
      const result = validateActionDomain('192.168.1.100', 'http://192.168.1.101/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.message).toContain('192.168.1.100');
      expect(result.message).toContain('192.168.1.101');
    });

    it('prevents using external IP to access localhost', () => {
      const result = validateActionDomain('8.8.8.8', 'http://127.0.0.1/admin');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents using localhost to access private network', () => {
      const result = validateActionDomain('127.0.0.1', 'http://192.168.1.1/admin');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('detects SSRF with 0.0.0.0 binding address', () => {
      const result = validateActionDomain('example.com', 'http://0.0.0.0:8080');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.normalizedSpecDomain).toBe('http://0.0.0.0');
    });

    it('validates matching 0.0.0.0 when legitimately used', () => {
      const result = validateActionDomain('0.0.0.0', 'http://0.0.0.0:8080');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('http://0.0.0.0');
    });

    it('prevents link-local address SSRF (169.254.x.x)', () => {
      const result = validateActionDomain('api.example.com', 'http://169.254.10.10/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.normalizedSpecDomain).toBe('http://169.254.10.10');
    });

    it('validates matching link-local when explicitly allowed', () => {
      const result = validateActionDomain('169.254.10.10', 'http://169.254.10.10/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('http://169.254.10.10');
    });

    it('prevents Docker internal network access via SSRF', () => {
      const result = validateActionDomain('public-api.com', 'http://172.17.0.1/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.normalizedSpecDomain).toBe('http://172.17.0.1');
    });

    it('prevents Kubernetes service network SSRF', () => {
      const result = validateActionDomain('api.company.com', 'http://10.96.0.1/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('detects protocol mismatch for IP addresses', () => {
      const result = validateActionDomain('https://192.168.1.1', 'http://192.168.1.1/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.normalizedSpecDomain).toBe('http://192.168.1.1');
      expect(result.normalizedClientDomain).toBe('https://192.168.1.1');
    });

    it('prevents IPv6 localhost bypass attempts', () => {
      const result = validateActionDomain('example.com', 'http://[::1]/admin');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
      expect(result.normalizedSpecDomain).toBe('http://[::1]');
    });

    it('prevents IPv6 link-local SSRF (fe80::)', () => {
      const result = validateActionDomain('api.example.com', 'http://[fe80::1]/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('validates matching IPv6 link-local when explicitly allowed', () => {
      const result = validateActionDomain('[fe80::1]', 'http://[fe80::1]/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('http://[fe80::1]');
    });

    it('prevents multicast address SSRF', () => {
      const result = validateActionDomain('api.example.com', 'http://224.0.0.1/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents broadcast address SSRF', () => {
      const result = validateActionDomain('api.example.com', 'http://255.255.255.255/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    // Cloud Provider Metadata Service Tests
    it('prevents AWS IMDSv1 metadata access', () => {
      const result = validateActionDomain(
        'trusted-api.com',
        'http://169.254.169.254/latest/meta-data/',
      );
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents AWS IMDSv2 token endpoint access', () => {
      const result = validateActionDomain(
        'api.example.com',
        'http://169.254.169.254/latest/api/token',
      );
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents GCP metadata access via metadata.google.internal', () => {
      const result = validateActionDomain(
        'api.example.com',
        'http://metadata.google.internal/computeMetadata/v1/',
      );
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents Azure IMDS access', () => {
      const result = validateActionDomain(
        'api.example.com',
        'http://169.254.169.254/metadata/instance?api-version=2021-02-01',
      );
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents DigitalOcean metadata access', () => {
      const result = validateActionDomain('api.example.com', 'http://169.254.169.254/metadata/v1/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents Oracle Cloud metadata access', () => {
      const result = validateActionDomain(
        'api.example.com',
        'http://169.254.169.254/opc/v1/instance/',
      );
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents Alibaba Cloud metadata access', () => {
      const result = validateActionDomain(
        'api.example.com',
        'http://100.100.100.200/latest/meta-data/',
      );
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    // Container & Orchestration Internal Services
    it('prevents Kubernetes API server access', () => {
      const result = validateActionDomain(
        'api.example.com',
        'https://kubernetes.default.svc.cluster.local/',
      );
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents Docker host access from container', () => {
      const result = validateActionDomain('api.example.com', 'http://host.docker.internal/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents Rancher metadata service access', () => {
      const result = validateActionDomain('api.example.com', 'http://rancher-metadata/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    // Common Internal Service Ports
    it('prevents Redis default port access', () => {
      const result = validateActionDomain('api.example.com', 'http://10.0.0.5:6379/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents Elasticsearch default port access', () => {
      const result = validateActionDomain('api.example.com', 'http://10.0.0.5:9200/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents MongoDB default port access', () => {
      const result = validateActionDomain('api.example.com', 'http://10.0.0.5:27017/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents PostgreSQL default port access', () => {
      const result = validateActionDomain('api.example.com', 'http://10.0.0.5:5432/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents MySQL default port access', () => {
      const result = validateActionDomain('api.example.com', 'http://10.0.0.5:3306/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    // Alternative localhost representations
    it('prevents localhost.localdomain SSRF', () => {
      const result = validateActionDomain('api.example.com', 'http://localhost.localdomain/admin');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('validates matching localhost.localdomain when explicitly allowed', () => {
      const result = validateActionDomain(
        'localhost.localdomain',
        'https://localhost.localdomain/api',
      );
      expect(result.isValid).toBe(true);
    });

    // Edge cases with special IPs
    it('prevents class E reserved IP range access', () => {
      const result = validateActionDomain('api.example.com', 'http://240.0.0.1/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('prevents TEST-NET-1 range access when not matching', () => {
      const result = validateActionDomain('api.example.com', 'http://192.0.2.1/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Domain mismatch');
    });

    it('validates TEST-NET-1 when explicitly matching', () => {
      const result = validateActionDomain('192.0.2.1', 'http://192.0.2.1/api');
      expect(result.isValid).toBe(true);
    });

    // Mixed protocol and IP scenarios (unsupported protocols)
    it('rejects unsupported WebSocket protocol', () => {
      const result = validateActionDomain('api.example.com', 'ws://api.example.com:8080/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid protocol');
      expect(result.message).toContain('ws:');
    });

    it('rejects unsupported FTP protocol', () => {
      const result = validateActionDomain('ftp.example.com', 'ftp://ftp.example.com/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid protocol');
      expect(result.message).toContain('ftp:');
    });

    it('rejects WSS (secure WebSocket) protocol', () => {
      const result = validateActionDomain('api.example.com', 'wss://api.example.com:8080/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid protocol');
      expect(result.message).toContain('wss:');
    });

    it('rejects file:// protocol for local file access', () => {
      const result = validateActionDomain('localhost', 'file:///etc/passwd');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid protocol');
      expect(result.message).toContain('file:');
    });

    it('rejects gopher:// protocol', () => {
      const result = validateActionDomain('example.com', 'gopher://example.com/');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid protocol');
      expect(result.message).toContain('gopher:');
    });

    it('rejects data: URL protocol', () => {
      const result = validateActionDomain('example.com', 'data:text/plain,Hello');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid protocol');
      expect(result.message).toContain('data:');
    });

    // Tests for Copilot second review catches
    it('rejects unsupported protocol in client domain', () => {
      const result = validateActionDomain('ftp://evil.com', 'https://trusted.com/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid protocol');
      expect(result.message).toContain('client domain');
    });

    it('rejects WebSocket protocol in client domain', () => {
      const result = validateActionDomain('ws://evil.com', 'https://trusted.com/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid protocol');
      expect(result.message).toContain('client domain');
    });

    it('rejects file protocol in client domain', () => {
      const result = validateActionDomain('file:///etc/passwd', 'https://trusted.com/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid protocol');
      expect(result.message).toContain('client domain');
    });

    it('handles IPv6 address without brackets from client', () => {
      const result = validateActionDomain('2001:db8::1', 'http://[2001:db8::1]/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedClientDomain).toBe('http://[2001:db8::1]');
      expect(result.normalizedSpecDomain).toBe('http://[2001:db8::1]');
    });

    it('handles IPv6 address with brackets from client', () => {
      const result = validateActionDomain('[2001:db8::1]', 'http://[2001:db8::1]/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedClientDomain).toBe('http://[2001:db8::1]');
      expect(result.normalizedSpecDomain).toBe('http://[2001:db8::1]');
    });

    // Ensure legitimate internal use cases still work
    it('allows legitimate internal API with matching IP', () => {
      const result = validateActionDomain('10.0.0.5', 'http://10.0.0.5:8080/api');
      expect(result.isValid).toBe(true);
    });

    it('allows legitimate Docker internal when explicitly specified', () => {
      const result = validateActionDomain(
        'host.docker.internal',
        'https://host.docker.internal:3000/api',
      );
      expect(result.isValid).toBe(true);
    });

    it('allows legitimate Kubernetes service when explicitly specified', () => {
      const result = validateActionDomain(
        'myservice.default.svc.cluster.local',
        'https://myservice.default.svc.cluster.local/api',
      );
      expect(result.isValid).toBe(true);
    });

    // Additional coverage tests for error paths and edge cases
    it('handles malformed URL in client domain gracefully', () => {
      const result = validateActionDomain('http://[invalid', 'https://example.com/api');
      expect(result.isValid).toBe(false);
    });

    it('handles error in spec URL parsing', () => {
      const result = validateActionDomain('example.com', 'not-a-valid-url');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Failed to validate domain');
    });

    it('validates when client provides HTTP and spec uses HTTP', () => {
      const result = validateActionDomain('http://example.com', 'http://example.com/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedClientDomain).toBe('http://example.com');
      expect(result.normalizedSpecDomain).toBe('http://example.com');
    });

    it('validates when client provides HTTPS and spec uses HTTPS', () => {
      const result = validateActionDomain('https://example.com', 'https://example.com/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedClientDomain).toBe('https://example.com');
      expect(result.normalizedSpecDomain).toBe('https://example.com');
    });

    it('handles IPv4 with explicit protocol from client', () => {
      const result = validateActionDomain('http://192.168.1.1', 'http://192.168.1.1:8080');
      expect(result.isValid).toBe(true);
      expect(result.normalizedClientDomain).toBe('http://192.168.1.1');
    });

    it('handles localhost as a domain', () => {
      const result = validateActionDomain('localhost', 'https://localhost:3000/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedClientDomain).toBe('https://localhost');
      expect(result.normalizedSpecDomain).toBe('https://localhost');
    });

    it('rejects javascript: protocol in client domain', () => {
      const result = validateActionDomain('javascript:alert(1)', 'https://example.com/api');
      expect(result.isValid).toBe(false);
      // javascript: doesn't have :// so it's treated as a hostname mismatch
      expect(result.message).toContain('Domain mismatch');
    });

    it('handles empty string as client domain', () => {
      const result = validateActionDomain('', 'https://example.com/api');
      expect(result.isValid).toBe(false);
    });

    it('handles spec URL without path', () => {
      const result = validateActionDomain('example.com', 'https://example.com');
      expect(result.isValid).toBe(true);
    });

    it('handles spec URL with query parameters', () => {
      const result = validateActionDomain(
        'api.example.com',
        'https://api.example.com/v1?key=value',
      );
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('https://api.example.com');
    });

    it('handles subdomain matching correctly', () => {
      const result = validateActionDomain(
        'api.v2.example.com',
        'https://api.v2.example.com/endpoint',
      );
      expect(result.isValid).toBe(true);
    });

    it('rejects SSH protocol in client domain', () => {
      const result = validateActionDomain('ssh://git@github.com', 'https://github.com/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid protocol');
    });

    it('handles punycode/internationalized domains', () => {
      const result = validateActionDomain(
        'xn--e1afmkfd.xn--p1ai',
        'https://xn--e1afmkfd.xn--p1ai/api',
      );
      expect(result.isValid).toBe(true);
    });

    it('validates IPv6 localhost variations', () => {
      const result = validateActionDomain('::1', 'http://[::1]:8080');
      expect(result.isValid).toBe(true);
      expect(result.normalizedClientDomain).toBe('http://[::1]');
    });

    it('handles spec URL with username in URL', () => {
      const result = validateActionDomain('example.com', 'https://user@example.com/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('https://example.com');
    });

    it('handles spec URL with username and password', () => {
      const result = validateActionDomain('example.com', 'https://user:pass@example.com/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedSpecDomain).toBe('https://example.com');
    });

    it('handles complex IPv6 addresses', () => {
      const result = validateActionDomain(
        '2001:db8:85a3::8a2e:370:7334',
        'http://[2001:db8:85a3::8a2e:370:7334]/api',
      );
      expect(result.isValid).toBe(true);
      expect(result.normalizedClientDomain).toBe('http://[2001:db8:85a3::8a2e:370:7334]');
    });

    it('handles IPv4-mapped IPv6 addresses', () => {
      // Node.js normalizes IPv4-mapped IPv6 differently in URL parsing
      const result = validateActionDomain('::ffff:c0a8:101', 'http://[::ffff:c0a8:101]/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedClientDomain).toBe('http://[::ffff:c0a8:101]');
    });

    it('rejects telnet protocol in client domain', () => {
      const result = validateActionDomain('telnet://example.com', 'https://example.com/api');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Invalid protocol');
    });

    it('handles client domain with port and no protocol', () => {
      const result = validateActionDomain('example.com:443', 'https://example.com:443/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedClientDomain).toBe('https://example.com');
      expect(result.normalizedSpecDomain).toBe('https://example.com');
    });

    it('handles TLD-only domains', () => {
      const result = validateActionDomain('localhost', 'http://localhost/api');
      expect(result.isValid).toBe(false); // HTTP vs HTTPS mismatch
      expect(result.normalizedClientDomain).toBe('https://localhost');
      expect(result.normalizedSpecDomain).toBe('http://localhost');
    });

    it('validates when both URLs have ports', () => {
      const result = validateActionDomain(
        'https://api.example.com:8443',
        'https://api.example.com:8443/v1',
      );
      expect(result.isValid).toBe(true);
    });

    it('handles client domain that looks like URL but missing protocol separator', () => {
      const result = validateActionDomain('httpexample.com', 'https://httpexample.com/api');
      expect(result.isValid).toBe(true);
      expect(result.normalizedClientDomain).toBe('https://httpexample.com');
    });
  });
});
