import { attachRequestContext, formatLogContext } from './requestLogContext';
import { tenantStorage } from './tenantContext';

describe('attachRequestContext', () => {
  const context = {
    tenantId: 'tenant-123',
    userId: 'user-123',
    requestId: 'request-123',
    requestMethod: 'POST',
    requestPath: '/api/example',
  };

  it.each([
    'jwt_auth_fallback_attempt',
    'jwt_auth_rejected',
    'jwt_auth_recovered',
    'tenant_isolation_error',
  ])('omits identity fields from %s while preserving request correlation', (eventName) =>
    tenantStorage.run(context, () => {
      const info = {
        level: 'warn',
        message: 'event',
        event_name: eventName,
        reason_category: 'malformed_jwt',
        response_status: 401,
        tenantId: 'explicit-tenant',
        tenant_id: 'explicit-tenant',
        userId: 'explicit-user',
        user_id: 'explicit-user',
      };

      const result = attachRequestContext(info);

      expect(result).not.toHaveProperty('tenantId');
      expect(result).not.toHaveProperty('tenant_id');
      expect(result).not.toHaveProperty('userId');
      expect(result).not.toHaveProperty('user_id');
      expect(result).toMatchObject({
        requestId: 'request-123',
        request_id: 'request-123',
        request_method: 'POST',
        request_path: '/api/example',
      });
      const rendered = formatLogContext(result);
      expect(rendered).toContain(`"event_name":"${eventName}"`);
      expect(rendered).toContain('"reason_category":"malformed_jwt"');
      expect(rendered).toContain('"response_status":401');
      expect(rendered).not.toContain('explicit-tenant');
      expect(rendered).not.toContain('explicit-user');
    }),
  );

  it('retains identity context on ordinary application logs', () =>
    tenantStorage.run(context, () => {
      const result = attachRequestContext({ level: 'info', message: 'event' });

      expect(result).toMatchObject({
        tenantId: 'tenant-123',
        userId: 'user-123',
        requestId: 'request-123',
        request_id: 'request-123',
        request_method: 'POST',
        request_path: '/api/example',
      });
    }));

  it('renders tenant Langfuse connection events with identity and outcome fields', () =>
    tenantStorage.run(context, () => {
      const result = attachRequestContext({
        level: 'info',
        message: '[adminLangfuse] Connection updated',
        event_name: 'librechat.langfuse.connection.changed',
        tenant_id: 'tenant-123',
        configured: true,
        enabled: true,
        destination: 'eu',
        change: 'created',
        changes: ['created'],
        verification_result: 'success',
      });

      const rendered = formatLogContext(result);
      expect(rendered).toContain('"event_name":"librechat.langfuse.connection.changed"');
      expect(rendered).toContain('"tenant_id":"tenant-123"');
      expect(rendered).toContain('"configured":true');
      expect(rendered).toContain('"enabled":true');
      expect(rendered).toContain('"destination":"eu"');
      expect(rendered).toContain('"change":"created"');
      expect(rendered).toContain('"changes":["created"]');
      expect(rendered).toContain('"verification_result":"success"');
    }));

  it('keeps application paths separate from the safe request route', () =>
    tenantStorage.run(context, () => {
      const result = attachRequestContext({
        level: 'error',
        message: 'upload cleanup failed',
        method: 'DELETE',
        path: '/uploads/tenant-123/user-123/file.txt',
      });

      expect(result).toMatchObject({
        method: 'DELETE',
        path: '/uploads/tenant-123/user-123/file.txt',
        request_method: 'POST',
        request_path: '/api/example',
      });
      const rendered = formatLogContext(result);
      expect(rendered).toContain('"request_method":"POST"');
      expect(rendered).toContain('"request_path":"/api/example"');
      expect(rendered).not.toContain('"method":"DELETE"');
      expect(rendered).not.toContain('/uploads/tenant-123/user-123/file.txt');
    }));

  it('overwrites reserved request fields with the safe ALS correlation context', () =>
    tenantStorage.run(context, () => {
      const result = attachRequestContext({
        level: 'warn',
        message: 'event',
        requestId: 'header..signature',
        request_id: 'header..signature',
        request_method: 'DELETE',
        request_path: '/unsafe/concrete/path',
      });

      expect(result).toMatchObject({
        requestId: 'request-123',
        request_id: 'request-123',
        request_method: 'POST',
        request_path: '/api/example',
      });
      expect(formatLogContext(result)).not.toContain('header..signature');
      expect(formatLogContext(result)).not.toContain('/unsafe/concrete/path');
    }));
});
