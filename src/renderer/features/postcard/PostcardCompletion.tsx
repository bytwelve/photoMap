import { BookOpen, FileImage } from '@phosphor-icons/react';
import { annotationPreviewUrl } from '../../domain';
import type { PhotoRecord } from '../../model';


export function PostcardCompletion(props: {
  photos: readonly PhotoRecord[];
  onReview: () => void;
  onContinue: () => void;
}): React.JSX.Element {
  const previewPhotos = props.photos.slice(-2);
  return (
    <section
      className="memory-stage postcard-stage postcard-completion-stage"
      data-testid="postcard-completion"
      aria-labelledby="postcard-completion-title"
    >
      <span className="postcard-completion-cord" aria-hidden="true" />
      <div className="postcard-completion-content">
        <header className="postcard-completion-copy">
          <h1 id="postcard-completion-title">投递完成，回忆已装订</h1>
          <span className="postcard-completion-ornament" aria-hidden="true">
            <i /><b>♥</b><i />
          </span>
          <p>共 <strong>{props.photos.length}</strong> 张明信片</p>
        </header>

        <div
          className={`postcard-completion-spread${previewPhotos.length === 1 ? ' is-single' : ''}`}
          data-testid="postcard-completion-spread"
          aria-label={`本组最后 ${previewPhotos.length} 张明信片预览`}
        >
          {previewPhotos.map((photo, index) => (
            <figure
              className={`postcard-completion-preview preview-${index + 1}`}
              data-photo-id={photo.id}
              key={photo.id}
            >
              {photo.decodeState === 'valid'
                ? <img src={annotationPreviewUrl(photo)} alt={photo.name} loading="eager" />
                : (
                  <span className="postcard-completion-placeholder" aria-label={`${photo.name} 无法预览`}>
                    <FileImage size={38} />
                  </span>
                )}
              <span className="postcard-completion-stamp" aria-hidden="true">寄</span>
            </figure>
          ))}
        </div>

        <div className="postcard-completion-actions">
          <button
            type="button"
            className="postcard-completion-review"
            data-testid="postcard-completion-review"
            autoFocus
            onClick={props.onReview}
          >
            <BookOpen size={20} weight="regular" />
            <span>翻阅这组明信片</span>
          </button>
          <button
            type="button"
            className="postcard-completion-continue"
            data-testid="postcard-completion-continue"
            onClick={props.onContinue}
          >
            继续整理照片
          </button>
        </div>
      </div>

      <div className="postcard-completion-mailbox" aria-hidden="true">
        <div className="postcard-completion-mailbox-art" />
      </div>
      <p className="postcard-live-region" role="status">
        已投递 {props.photos.length} 张明信片
      </p>
    </section>
  );
}
