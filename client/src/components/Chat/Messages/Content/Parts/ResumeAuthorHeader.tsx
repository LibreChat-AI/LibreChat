import { memo } from 'react';
import { useAuthorContext } from '~/Providers';
import AuthorHeader from './AuthorHeader';

/**
 * Restates the message author where content resumes after a steer, reading the
 * author from `AuthorContext`.
 *
 * A header element built from the author changes identity when the author
 * resolves, and handing that element to the memoized parts tree re-rendered every
 * part of the message. Rendered through this component, the element a caller hands
 * down never changes, and an author update re-renders only the headers on screen.
 */
const ResumeAuthorHeader = memo(function ResumeAuthorHeader() {
  const author = useAuthorContext();
  if (author == null) {
    return null;
  }
  return <AuthorHeader icon={author.icon} label={author.label} />;
});

export default ResumeAuthorHeader;
