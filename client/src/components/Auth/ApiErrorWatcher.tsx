import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useApiErrorBoundary } from '~/hooks/ApiErrorBoundaryContext';

const ApiErrorWatcher = () => {
  const { error } = useApiErrorBoundary();
  const navigate = useNavigate();
  React.useEffect(() => {
    if (error?.response?.status === 500) {
      // do something with error
      // navigate('/login');
    }
  }, [error, navigate]);

  return null;
};

export default ApiErrorWatcher;
