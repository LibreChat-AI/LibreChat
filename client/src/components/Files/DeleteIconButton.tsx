import React from 'react';
import { Button, TrashIcon } from '@librechat/client';

type DeleteIconButtonProps = {
  onClick: () => void;
};

export default function DeleteIconButton({ onClick }: DeleteIconButtonProps) {
  return (
    <div className="w-fit">
      <Button variant="destructive" className="p-3" onClick={onClick}>
        <TrashIcon />
      </Button>
    </div>
  );
}
