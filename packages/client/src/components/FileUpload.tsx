import React, { forwardRef } from 'react';

type FileUploadProps = {
  className?: string;
  onClick?: () => void;
  children: React.ReactNode;
  handleFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

const FileUpload: React.ForwardRefExoticComponent<
  FileUploadProps & React.RefAttributes<HTMLInputElement>
> = forwardRef<HTMLInputElement, FileUploadProps>(({ children, handleFileChange }, ref) => {
  return (
    <>
      {children}
      <input ref={ref} multiple type="file" className="hidden" onChange={handleFileChange} />
    </>
  );
});

FileUpload.displayName = 'FileUpload';

export default FileUpload;
