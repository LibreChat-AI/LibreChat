import React, { useState, useRef, useCallback } from 'react';
import { useSetRecoilState } from 'recoil';
// @ts-ignore - no type definitions available
import AvatarEditor from 'react-avatar-editor';
import { FileImage, RotateCw, Upload, ZoomIn, ZoomOut, Move, X } from 'lucide-react';
import { fileConfig as defaultFileConfig, mergeFileConfig } from 'librechat-data-provider';
import {
  Label,
  Slider,
  Button,
  Spinner,
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  OGDialogTrigger,
  useToastContext,
} from '@librechat/client';
import type { TUser } from 'librechat-data-provider';
import { useUploadAvatarMutation, useGetFileConfig } from '~/data-provider';
import { cn } from '~/utils';
import { useLocalize } from '~/hooks';
import store from '~/store';

const AVATAR_FILE_EXTENSIONS = ['.jpeg', '.jpg', '.png'];
const AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const DEFAULT_AVATAR_SIZE_LIMIT_MB = 2;

const getAvatarSizeLimitMB = (sizeLimit?: number | null) => {
  if (sizeLimit == null) {
    return DEFAULT_AVATAR_SIZE_LIMIT_MB;
  }

  return Number((sizeLimit / (1024 * 1024)).toFixed(2));
};

const isSupportedAvatarFile = (file: File) => {
  const fileName = file.name.toLowerCase();
  const hasSupportedExtension = AVATAR_FILE_EXTENSIONS.some((extension) =>
    fileName.endsWith(extension),
  );
  const hasSupportedMimeType = file.type === '' || AVATAR_MIME_TYPES.has(file.type.toLowerCase());

  return hasSupportedExtension && hasSupportedMimeType;
};

interface AvatarEditorRef {
  getImageScaledToCanvas: () => HTMLCanvasElement;
  getImage: () => HTMLImageElement;
}

interface Position {
  x: number;
  y: number;
}

function Avatar() {
  const setUser = useSetRecoilState(store.user);

  const [scale, setScale] = useState<number>(1);
  const [rotation, setRotation] = useState<number>(0);
  const [position, setPosition] = useState<Position>({ x: 0.5, y: 0.5 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const editorRef = useRef<AvatarEditorRef | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [image, setImage] = useState<string | File | null>(null);
  const [isDialogOpen, setDialogOpen] = useState<boolean>(false);

  const { data: fileConfig = defaultFileConfig } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });

  const localize = useLocalize();
  const { showToast } = useToastContext();
  const avatarSizeLimitMB = getAvatarSizeLimitMB(fileConfig.avatarSizeLimit);

  const { mutate: uploadAvatar, isLoading: isUploading } = useUploadAvatarMutation({
    onSuccess: (data) => {
      showToast({ message: localize('com_ui_upload_success') });
      setUser((prev) => ({ ...prev, avatar: data.url }) as TUser);
    },
    onError: (error) => {
      console.error('Error:', error);
      showToast({ message: localize('com_ui_upload_error'), status: 'error' });
    },
  });

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    handleFile(file);
  };

  const handleFile = useCallback(
    (file: File | undefined) => {
      const isWithinSizeLimit =
        file != null &&
        (fileConfig.avatarSizeLimit == null || file.size <= fileConfig.avatarSizeLimit);

      if (file && isSupportedAvatarFile(file) && isWithinSizeLimit) {
        setImage(file);
        setScale(1);
        setRotation(0);
        setPosition({ x: 0.5, y: 0.5 });
      } else {
        showToast({
          message: localize('com_ui_avatar_invalid_file', { 0: avatarSizeLimitMB }),
          status: 'error',
        });
      }
    },
    [avatarSizeLimitMB, fileConfig.avatarSizeLimit, localize, showToast],
  );

  const handleScaleChange = (value: number[]) => {
    setScale(value[0]);
  };

  const handleZoomIn = () => {
    setScale((prev) => Math.min(prev + 0.2, 5));
  };

  const handleZoomOut = () => {
    setScale((prev) => Math.max(prev - 0.2, 1));
  };

  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  const handlePositionChange = (position: Position) => {
    setPosition(position);
  };

  const handleUpload = () => {
    if (editorRef.current) {
      const canvas = editorRef.current.getImageScaledToCanvas();
      canvas.toBlob((blob) => {
        if (blob) {
          const formData = new FormData();
          formData.append('file', blob, 'avatar.png');
          formData.append('manual', 'true');
          uploadAvatar(formData);
        }
      }, 'image/png');
    }
  };

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      handleFile(file);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleSelectFileClick = (event: React.MouseEvent) => {
    event.preventDefault();
    fileInputRef.current?.click();
  };

  const resetImage = useCallback(() => {
    setImage(null);
    setScale(1);
    setRotation(0);
    setPosition({ x: 0.5, y: 0.5 });
  }, []);

  const handleReset = () => {
    setScale(1);
    setRotation(0);
    setPosition({ x: 0.5, y: 0.5 });
  };

  return (
    <OGDialog
      open={isDialogOpen}
      onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) {
          resetImage();
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{localize('com_nav_profile_picture')}</span>
        <OGDialogTrigger asChild>
          <Button variant="outline">
            <FileImage className="mr-2 flex w-[1.375rem] items-center" aria-hidden="true" />
            <span>{localize('com_nav_change_picture')}</span>
          </Button>
        </OGDialogTrigger>
      </div>

      <OGDialogContent className="w-11/12 max-w-md">
        <OGDialogHeader>
          <OGDialogTitle className="text-lg leading-6 font-medium">
            {image != null ? localize('com_ui_preview') : localize('com_ui_upload_image')}
          </OGDialogTitle>
        </OGDialogHeader>
        <div className="flex min-w-0 flex-col items-center justify-center p-2">
          {image != null ? (
            <>
              <div
                className={cn(
                  'ring-border-light relative w-full max-w-[17.5rem] overflow-hidden rounded-full ring-4 transition-all',
                  isDragging && 'ring-ring-primary cursor-move',
                )}
                onMouseDown={() => setIsDragging(true)}
                onMouseUp={() => setIsDragging(false)}
                onMouseLeave={() => setIsDragging(false)}
              >
                <AvatarEditor
                  ref={editorRef}
                  image={image}
                  width={280}
                  height={280}
                  border={0}
                  borderRadius={140}
                  color={[255, 255, 255, 0.6]}
                  scale={scale}
                  rotate={rotation}
                  position={position}
                  onPositionChange={handlePositionChange}
                  /* The width/height props stay at 280 so the exported avatar keeps its
                     resolution; only the rendered canvas yields to the dialog, which is
                     narrower than 17.5rem once the scale or the reader's font grows. The
                     editor writes its size inline, so the overrides are important. */
                  className="aspect-square h-auto! w-full! cursor-move"
                />
                {!isDragging && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity hover:opacity-100">
                    <div className="bg-surface-media-overlay/50 rounded-full p-2">
                      <Move className="text-text-on-media h-6 w-6" aria-hidden="true" />
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-6 w-full space-y-6">
                {/* Zoom Controls */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="zoom-slider" className="text-sm font-medium">
                      {localize('com_ui_zoom')}
                    </Label>
                    <span className="text-text-secondary text-sm">{Math.round(scale * 100)}%</span>
                  </div>
                  <div className="flex items-center space-x-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleZoomOut}
                      disabled={scale <= 1}
                      aria-label={localize('com_ui_zoom_out')}
                      className="shrink-0"
                    >
                      <ZoomOut className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Slider
                      id="zoom-slider"
                      value={[scale]}
                      min={1}
                      max={5}
                      step={0.1}
                      onValueChange={handleScaleChange}
                      className="flex-1"
                      aria-label={localize('com_ui_zoom_level')}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleZoomIn}
                      disabled={scale >= 5}
                      aria-label={localize('com_ui_zoom_in')}
                      className="shrink-0"
                    >
                      <ZoomIn className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleRotate}
                    className="flex items-center space-x-2"
                    aria-label={localize('com_ui_rotate_90')}
                  >
                    <RotateCw className="h-4 w-4" aria-hidden="true" />
                    <span className="text-sm">{localize('com_ui_rotate')}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleReset}
                    className="flex items-center space-x-2"
                    aria-label={localize('com_ui_reset_adjustments')}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                    <span className="text-sm">{localize('com_ui_reset')}</span>
                  </Button>
                </div>

                {/* Helper Text */}
                <p className="text-text-tertiary text-center text-xs">
                  {localize('com_ui_editor_instructions')}
                </p>
              </div>

              {/* Action Buttons */}
              <div className="mt-6 flex w-full flex-wrap gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={resetImage}
                  disabled={isUploading}
                >
                  {localize('com_ui_cancel')}
                </Button>
                <Button
                  variant="submit"
                  type="button"
                  className={cn('flex-1', isUploading ? 'cursor-not-allowed opacity-90' : '')}
                  onClick={handleUpload}
                  disabled={isUploading}
                >
                  {isUploading ? (
                    <Spinner className="icon-sm mr-2" />
                  ) : (
                    <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  {localize('com_ui_upload')}
                </Button>
              </div>
            </>
          ) : (
            <div
              className="border-border-medium hover:border-border-heavy flex h-72 w-full flex-col items-center justify-center rounded-lg border-2 border-dashed bg-transparent transition-colors"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
            >
              <FileImage className="text-text-tertiary mb-4 size-16" aria-hidden="true" />
              <p className="text-text-primary mb-2 text-center text-sm font-medium">
                {localize('com_ui_avatar_drop_image')}
              </p>
              <p className="text-text-secondary mb-4 text-center text-xs">
                {localize('com_ui_avatar_file_requirements', {
                  0: avatarSizeLimitMB,
                })}
              </p>
              <Button type="button" variant="secondary" onClick={handleSelectFileClick}>
                {localize('com_ui_select_file')}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".png, .jpg, .jpeg"
                onChange={handleFileChange}
                aria-label={localize('com_ui_file_input_avatar_label')}
              />
            </div>
          )}
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}

export default Avatar;
