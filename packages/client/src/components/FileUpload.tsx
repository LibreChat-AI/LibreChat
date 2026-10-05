import React, { forwardRef } from 'react';

type FileUploadProps = Pick<
  React.InputHTMLAttributes<HTMLInputElement>,
  'accept' | 'disabled' | 'multiple' | 'id' | 'aria-label'
> & {
  className?: string;
  onClick?: () => void;
  children: React.ReactNode;
  handleFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

const FileUpload: React.ForwardRefExoticComponent<
  FileUploadProps & React.RefAttributes<HTMLInputElement>
> = forwardRef<HTMLInputElement, FileUploadProps>(
  ({ children, handleFileChange, multiple = true, ...inputProps }, ref) => {
    return (
      <>
        {children}
        <input
          ref={ref}
          {...inputProps}
          multiple={multiple}
          type="file"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </>
    );
  },
);

FileUpload.displayName = 'FileUpload';

export default FileUpload;
