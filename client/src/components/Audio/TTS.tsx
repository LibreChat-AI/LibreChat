/* eslint-disable jsx-a11y/media-has-caption */
import { useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { VolumeIcon, VolumeMuteIcon, Spinner } from '@librechat/client';
import type { TMessageAudio } from '~/common';
import { useLocalize, useTTSBrowser, useTTSExternal } from '~/hooks';
import { logger } from '~/utils';
import store from '~/store';

export function BrowserTTS({
  isLast,
  index,
  messageId,
  content,
  className,
  renderButton,
}: TMessageAudio) {
  const localize = useLocalize();
  const playbackRate = useRecoilValue(store.playbackRate);

  const { toggleSpeech, isSpeaking, isLoading, audioRef } = useTTSBrowser({
    isLast,
    index,
    messageId,
    content,
  });

  const renderIcon = () => {
    if (isLoading === true) {
      return <Spinner className="icon-md-heavy h-[1.125rem] w-[1.125rem]" />;
    }

    if (isSpeaking === true) {
      return <VolumeMuteIcon className="icon-md-heavy h-[1.125rem] w-[1.125rem]" />;
    }

    return <VolumeIcon className="icon-md-heavy h-[1.125rem] w-[1.125rem]" />;
  };

  useEffect(() => {
    const messageAudio = document.getElementById(`audio-${messageId}`) as HTMLAudioElement | null;
    if (!messageAudio) {
      return;
    }
    if (playbackRate != null && playbackRate > 0 && messageAudio.playbackRate !== playbackRate) {
      messageAudio.playbackRate = playbackRate;
    }
  }, [audioRef, isSpeaking, playbackRate, messageId]);

  logger.log(
    'MessageAudio: audioRef.current?.src, audioRef.current',
    audioRef.current?.src,
    audioRef.current,
  );

  const handleClick = () => {
    if (audioRef.current) {
      audioRef.current.muted = false;
    }
    toggleSpeech();
  };

  const title = isSpeaking === true ? localize('com_ui_stop') : localize('com_ui_read_aloud');

  return (
    <>
      {renderButton ? (
        renderButton({
          onClick: handleClick,
          title: title,
          icon: renderIcon(),
          isActive: isSpeaking,
          className,
        })
      ) : (
        <button className={className} onClickCapture={handleClick} type="button" title={title}>
          {renderIcon()}
        </button>
      )}
      <audio
        ref={audioRef}
        controls
        preload="none"
        controlsList="nodownload nofullscreen noremoteplayback"
        style={{
          position: 'absolute',
          overflow: 'hidden',
          display: 'none',
          height: '0px',
          width: '0px',
        }}
        src={audioRef.current?.src}
        onError={(error) => {
          logger.error('Error fetching audio:', error);
        }}
        id={`audio-${messageId}`}
        autoPlay
      />
    </>
  );
}

export function ExternalTTS({
  isLast,
  index,
  messageId,
  content,
  className,
  renderButton,
}: TMessageAudio) {
  const localize = useLocalize();
  const playbackRate = useRecoilValue(store.playbackRate);

  const { toggleSpeech, isSpeaking, isLoading, audioRef } = useTTSExternal({
    isLast,
    index,
    messageId,
    content,
  });

  const renderIcon = () => {
    if (isLoading === true) {
      return <Spinner className="icon-md-heavy h-[1.125rem] w-[1.125rem]" />;
    }

    if (isSpeaking === true) {
      return <VolumeMuteIcon className="icon-md-heavy h-[1.125rem] w-[1.125rem]" />;
    }

    return <VolumeIcon className="icon-md-heavy h-[1.125rem] w-[1.125rem]" />;
  };

  useEffect(() => {
    const messageAudio = document.getElementById(`audio-${messageId}`) as HTMLAudioElement | null;
    if (!messageAudio) {
      return;
    }
    if (playbackRate != null && playbackRate > 0 && messageAudio.playbackRate !== playbackRate) {
      messageAudio.playbackRate = playbackRate;
    }
  }, [audioRef, isSpeaking, playbackRate, messageId]);

  logger.log(
    'MessageAudio: audioRef.current?.src, audioRef.current',
    audioRef.current?.src,
    audioRef.current,
  );

  return (
    <>
      {renderButton ? (
        renderButton({
          onClick: () => {
            if (audioRef.current) {
              audioRef.current.muted = false;
            }
            toggleSpeech();
          },
          title: isSpeaking === true ? localize('com_ui_stop') : localize('com_ui_read_aloud'),
          icon: renderIcon(),
          isActive: isSpeaking,
          className,
        })
      ) : (
        <button
          onClickCapture={() => {
            if (audioRef.current) {
              audioRef.current.muted = false;
            }
            toggleSpeech();
          }}
          type="button"
          title={isSpeaking === true ? localize('com_ui_stop') : localize('com_ui_read_aloud')}
        >
          {renderIcon()}
        </button>
      )}
      <audio
        ref={audioRef}
        controls
        preload="none"
        controlsList="nodownload nofullscreen noremoteplayback"
        style={{
          position: 'absolute',
          overflow: 'hidden',
          display: 'none',
          height: '0px',
          width: '0px',
        }}
        src={audioRef.current?.src}
        onError={(error) => {
          logger.error('Error fetching audio:', error);
        }}
        id={`audio-${messageId}`}
        autoPlay
      />
    </>
  );
}
