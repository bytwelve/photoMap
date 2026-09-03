import { CheckCircle, FileImage, Trash } from '@phosphor-icons/react';
import type { AdministrativeRegion as RegionOption } from '../../../shared/administrative-regions';
import { MAX_PHOTO_NOTE_LENGTH } from '../../../shared/contracts';
import { annotationPreviewUrl, mediaKindLabel } from '../../domain';
import type { PhotoRecord, PhotoTypeTag } from '../../model';
import { captureTimeInputValue, captureTimeDisplayValue } from './PostcardEditor';

export function PostcardPreviewCard(props: {
  photo: PhotoRecord;
  sequence: number;
  provinces: readonly RegionOption[];
  cities: readonly RegionOption[];
  photoTypes: readonly PhotoTypeTag[];
  testId: 'postcard-previous' | 'postcard-next' | 'postcard-after-next' | 'postcard-flight';
  style: React.CSSProperties;
}): React.JSX.Element {
  const provinceCode = props.photo.location?.provinceCode ?? '';
  const cityCode = props.photo.location?.cityCode ?? '';
  const cityOptions = props.cities.filter((city) => city.parentProvinceCode === provinceCode);
  const selectedTypes = new Set(props.photo.types.map((type) => type.id));
  return (
    <article
      className="postcard-card postcard-preview-card"
      data-testid={props.testId}
      data-photo-id={props.photo.id}
      aria-hidden="true"
      inert
      style={props.style}
    >
      <div className="postcard-photo">
        {props.photo.decodeState === 'valid'
          ? <img src={annotationPreviewUrl(props.photo)} alt="" draggable={false} loading="eager" decoding="async" />
          : <div className="postcard-decode-placeholder"><FileImage size={34} /></div>}
        <span className={`media-kind-badge media-kind-${props.photo.mediaKind}`} data-testid="media-kind-badge">
          {mediaKindLabel(props.photo.mediaKind)}
        </span>
        <span className="postcard-sequence">MEMORY · {String(props.sequence).padStart(2, '0')}</span>
      </div>
      <section className="postcard-copy">
        <div className="postcard-basics">
          <div><span>文件名称</span><strong>{props.photo.name}</strong></div>
          <div>
            <span>拍摄时间</span>
            <time dateTime={captureTimeInputValue(props.photo.captureTimeLocal) || undefined}>
              {captureTimeDisplayValue(props.photo.captureTimeLocal, props.photo.captureTimeOffsetMinutes)}
            </time>
          </div>
        </div>
        <section className="postcard-location-editor" aria-label="拍摄地点">
          <h2>拍摄地点</h2>
          <div>
            <label><span>省份</span><select value={provinceCode} disabled aria-label="选择省份"><option value="">未选择</option>{props.provinces.map((province) => <option value={province.code} key={province.code}>{province.name}</option>)}</select></label>
            <label><span>城市</span><select value={cityCode} disabled aria-label="选择城市"><option value="">只标记到省</option>{cityOptions.map((city) => <option value={city.code} key={city.code}>{city.name}</option>)}</select></label>
          </div>
        </section>
        <section className="postcard-type-editor" aria-label="标签">
          <h2>标签</h2>
          <div>
            {props.photoTypes.map((type) => <button type="button" key={type.id} className={selectedTypes.has(type.id) ? 'selected' : ''} aria-pressed={selectedTypes.has(type.id)} disabled>{type.name}</button>)}
            {props.photoTypes.length === 0 && <span className="postcard-no-types">还没有标签</span>}
          </div>
        </section>
        <div className="postcard-note">
          <div><label>照片记忆</label><output>{(props.photo.note ?? '').length} / {MAX_PHOTO_NOTE_LENGTH}</output></div>
          <textarea value={props.photo.note ?? ''} maxLength={MAX_PHOTO_NOTE_LENGTH} placeholder="写下这张照片的记忆…" disabled readOnly />
        </div>
        <footer className="postcard-save-row">
          <span className="postcard-save-state saved"><CheckCircle size={17} weight="fill" />已保存到本地索引</span>
          <button type="button" className="postcard-trash" disabled><Trash size={15} />移入回收站</button>
        </footer>
      </section>
    </article>
  );
}
