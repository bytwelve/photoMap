import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react';
import { annotationPlaybackUrl } from '../../domain';
import type { PhotoRecord } from '../../model';


export function playbackTimeLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function PostcardPlayableMedia(props: {
  photo: PhotoRecord;
  active: boolean;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pausedByUserRef = useRef(false);
  const resumeAfterSeekRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);
  const isLive = props.photo.mediaKind === 'live';

  const syncPlaybackEligibility = useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    if (!props.active || document.hidden || pausedByUserRef.current) {
      video.pause();
      return;
    }
    void video.play().catch(() => setPlaying(false));
  }, [props.active]);

  useEffect(() => {
    const video = videoRef.current;
    syncPlaybackEligibility();
    document.addEventListener('visibilitychange', syncPlaybackEligibility);
    return () => {
      document.removeEventListener('visibilitychange', syncPlaybackEligibility);
      video?.pause();
    };
  }, [syncPlaybackEligibility]);

  function togglePlayback(): void {
    const video = videoRef.current;
    if (!video || failed) return;
    if (video.paused) {
      pausedByUserRef.current = false;
      void video.play().catch(() => setPlaying(false));
      return;
    }
    pausedByUserRef.current = true;
    video.pause();
  }

  function seekTo(value: number): void {
    const video = videoRef.current;
    if (!video || !Number.isFinite(value)) return;
    video.currentTime = value;
    setCurrentTime(value);
  }

  function finishSeek(): void {
    const video = videoRef.current;
    if (resumeAfterSeekRef.current && video && props.active && !pausedByUserRef.current) {
      void video.play().catch(() => setPlaying(false));
    }
    resumeAfterSeekRef.current = false;
  }

  return (
    <div className={`postcard-playable ${failed ? 'has-error' : ''}`} data-media-kind={props.photo.mediaKind}>
      <video
        ref={videoRef}
        data-testid="postcard-playable-media"
        src={annotationPlaybackUrl(props.photo)}
        poster={props.photo.thumbnailUrl}
        preload="metadata"
        autoPlay={props.active}
        loop
        muted={isLive || muted}
        playsInline
        aria-label={isLive ? `${props.photo.name}实况照片` : `${props.photo.name}视频`}
        onLoadedMetadata={(event) => {
          const nextDuration = event.currentTarget.duration;
          setDuration(Number.isFinite(nextDuration) ? nextDuration : 0);
          syncPlaybackEligibility();
        }}
        onDurationChange={(event) => {
          const nextDuration = event.currentTarget.duration;
          setDuration(Number.isFinite(nextDuration) ? nextDuration : 0);
        }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => {
          setFailed(true);
          setPlaying(false);
        }}
      />
      {failed && <span className="postcard-media-error">动态内容无法播放，已保留封面</span>}
      <div
        className="postcard-media-toolbar"
        data-testid="postcard-media-toolbar"
        role="group"
        aria-label={isLive ? '实况照片播放控制' : '视频播放控制'}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="postcard-media-button"
          aria-label={playing ? '暂停' : '播放'}
          aria-pressed={playing}
          disabled={failed}
          onClick={togglePlayback}
        >
          {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
        </button>
        {!isLive && (
          <>
            <input
              type="range"
              className="postcard-media-progress"
              data-testid="postcard-media-progress"
              min={0}
              max={duration > 0 ? duration : 0}
              step={0.01}
              value={Math.min(currentTime, duration || 0)}
              disabled={failed || duration <= 0}
              aria-label="视频进度"
              aria-valuetext={`${playbackTimeLabel(currentTime)} / ${playbackTimeLabel(duration)}`}
              onPointerDown={(event) => {
                const video = videoRef.current;
                resumeAfterSeekRef.current = Boolean(video && !video.paused);
                video?.pause();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerUp={(event) => {
                finishSeek();
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={finishSeek}
              onLostPointerCapture={finishSeek}
              onChange={(event) => seekTo(event.currentTarget.valueAsNumber)}
            />
            <output className="postcard-media-time">
              {playbackTimeLabel(currentTime)} / {playbackTimeLabel(duration)}
            </output>
            <button
              type="button"
              className="postcard-media-button"
              aria-label={muted ? '打开声音' : '静音'}
              aria-pressed={!muted}
              onClick={() => setMuted((current) => !current)}
            >
              {muted ? <SpeakerSlash size={16} /> : <SpeakerHigh size={16} />}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
