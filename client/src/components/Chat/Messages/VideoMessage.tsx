import React from 'react';

interface VideoMessageProps {
  videoUrl: string;
  prompt?: string;
}

export default function VideoMessage({ videoUrl, prompt }: VideoMessageProps) {
  if (!videoUrl) {
    return null;
  }

  return (
    <div className="my-2 max-w-lg">
      {prompt && (
        <p className="mb-1 text-sm text-text-secondary">
          {prompt}
        </p>
      )}
      <video
        controls
        className="w-full rounded-lg"
        src={videoUrl}
        preload="metadata"
      >
        <track kind="captions" />
        Your browser does not support the video element.
      </video>
    </div>
  );
}
