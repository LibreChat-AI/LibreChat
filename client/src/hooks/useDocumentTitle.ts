import { useEffect } from 'react';
import { setDocumentTitle } from '~/utils';

function useDocumentTitle(title: string) {
  useEffect(() => {
    setDocumentTitle(title, true);
  }, [title]);
}

export default useDocumentTitle;
