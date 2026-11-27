const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeSegment(segment: string, previous: string | undefined): string {
  if (previous === 'c' && segment === 'new') {
    return segment;
  }

  if (previous === 'c') {
    return ':conversationId';
  }

  if (previous === 'share') {
    return ':shareId';
  }

  if (previous === 'assistants') {
    return ':assistantId';
  }

  if (UUID.test(segment) || OBJECT_ID.test(segment)) {
    return ':id';
  }

  return segment;
}

export function normalizeRumPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return '/';
  }

  return `/${segments.map((segment, index) => normalizeSegment(segment, segments[index - 1])).join('/')}`;
}
