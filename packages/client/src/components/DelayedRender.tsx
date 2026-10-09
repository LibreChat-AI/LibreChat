import React from 'react';
import { useDelayedRender } from '~/hooks';

interface DelayedRenderProps {
  delay: number;
  children: React.ReactNode;
}

const DelayedRender = ({ delay, children }: DelayedRenderProps): React.ReactNode =>
  useDelayedRender(delay)(() => children);

export default DelayedRender;
