import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle, Trash, WarningCircle } from '@phosphor-icons/react';
import type { AdministrativeRegion as RegionOption } from '../../../shared/administrative-regions';
import { MAX_MEDIA_FILE_NAME_LENGTH, MAX_PHOTO_NOTE_LENGTH } from '../../../shared/contracts';
import { annotationPreviewUrl, mediaKindLabel } from '../../domain';
import type { PhotoRecord, PhotoTypeTag } from '../../model';
import { PostcardPlayableMedia } from './PostcardMedia';

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export function isImeCompositionKey(isComposing: boolean, keyCode: number): boolean {
  return isComposing || keyCode === 229;
}

export const CAPTURE_TIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/u;

export function captureTimeInputValue(value: string | null | undefined): string {
  const match = value?.trim().match(CAPTURE_TIME_LOCAL_PATTERN);
  if (!match) return '';

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00'] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth
    || hour < 0
    || hour > 23
    || minute < 0
    || minute > 59
    || second < 0
    || second > 59
  ) return '';

  return `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}`;
}

export function captureTimeOffsetLabel(offsetMinutes: number | null | undefined): string | undefined {
  if (offsetMinutes === null || offsetMinutes === undefined || !Number.isFinite(offsetMinutes)) return undefined;
  const rounded = Math.round(offsetMinutes);
  const sign = rounded < 0 ? '-' : '+';
  const absolute = Math.abs(rounded);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

export function captureTimeDisplayValue(
  localDateTime: string | null | undefined,
  offsetMinutes: number | null | undefined,
): string {
  const normalized = captureTimeInputValue(localDateTime);
  if (!normalized) return '未读取到拍摄时间';
  const offset = captureTimeOffsetLabel(offsetMinutes);
  return `${normalized.replace('T', ' ')}${offset ? ` ${offset}` : ''}`;
}

export function PostcardCard(props: {
  photo: PhotoRecord;
  sequence: number;
  provinces: readonly RegionOption[];
  cities: readonly RegionOption[];
  photoTypes: readonly PhotoTypeTag[];
  motionStyle?: React.CSSProperties;
  interactive: boolean;
  mediaActive: boolean;
  onUpdateLocation: (ids: readonly string[], provinceCode?: string, cityCode?: string) => Promise<boolean>;
  onUpdateTypes: (ids: readonly string[], add: readonly string[], remove: readonly string[]) => Promise<boolean>;
  onUpdateNote: (id: string, note: string) => Promise<boolean>;
  onUpdateCaptureTime: (id: string, localDateTime: string) => Promise<boolean>;
  onRenamePhoto: (id: string, newFileName: string) => Promise<boolean>;
  onRequestTrash: (ids: readonly string[]) => void;
}): React.JSX.Element {
  const [provinceCode, setProvinceCode] = useState(props.photo.location?.provinceCode ?? '');
  const [cityCode, setCityCode] = useState(props.photo.location?.cityCode ?? '');
  const [selectedTypes, setSelectedTypes] = useState(() => new Set(props.photo.types.map((type) => type.id)));
  const [metadataSaveState, setMetadataSaveState] = useState<Extract<SaveState, 'saved' | 'saving' | 'error'>>('saved');
  const initialNote = props.photo.note ?? '';
  const [noteDraft, setNoteDraft] = useState(initialNote);
  const [noteSaveState, setNoteSaveState] = useState<SaveState>('saved');
  const [fileNameDraft, setFileNameDraft] = useState(props.photo.name);
  const [fileNameEditing, setFileNameEditing] = useState(false);
  const [fileNameSaveState, setFileNameSaveState] = useState<SaveState>('saved');
  const lastSavedNoteRef = useRef(initialNote);
  const noteDraftRef = useRef(initialNote);
  const updateNoteRef = useRef(props.onUpdateNote);
  const noteSaveRevisionRef = useRef(0);
  const noteTimerRef = useRef<number | undefined>(undefined);
  const initialCaptureTime = captureTimeInputValue(props.photo.captureTimeLocal);
  const [captureTimeDraft, setCaptureTimeDraft] = useState(initialCaptureTime);
  const [captureTimeSaveState, setCaptureTimeSaveState] = useState<SaveState>('saved');
  const lastSavedCaptureTimeRef = useRef(initialCaptureTime);
  const captureTimeDraftRef = useRef(initialCaptureTime);
  const captureTimeSaveRevisionRef = useRef(0);
  const captureTimeHelpId = `postcard-capture-time-help-${props.photo.id}`;
  const captureTimeOffset = captureTimeOffsetLabel(props.photo.captureTimeOffsetMinutes);
  const fileNameInputRef = useRef<HTMLInputElement | null>(null);
  const fileNameEditButtonRef = useRef<HTMLButtonElement | null>(null);
  const cityOptions = props.cities.filter((city) => city.parentProvinceCode === provinceCode);

  const saveCaptureTime = useCallback(async (nextValue: string): Promise<void> => {
    const normalized = captureTimeInputValue(nextValue);
    const previous = lastSavedCaptureTimeRef.current;
    if (!normalized) {
      captureTimeDraftRef.current = previous;
      setCaptureTimeDraft(previous);
      setCaptureTimeSaveState('saved');
      return;
    }
    if (normalized === previous) {
      captureTimeDraftRef.current = normalized;
      setCaptureTimeDraft(normalized);
      setCaptureTimeSaveState('saved');
      return;
    }

    const revision = captureTimeSaveRevisionRef.current + 1;
    captureTimeSaveRevisionRef.current = revision;
    setCaptureTimeSaveState('saving');
    let saved: boolean;
    try {
      saved = await props.onUpdateCaptureTime(props.photo.id, normalized);
    } catch {
      saved = false;
    }
    if (revision !== captureTimeSaveRevisionRef.current) return;
    if (saved) {
      lastSavedCaptureTimeRef.current = normalized;
      captureTimeDraftRef.current = normalized;
      setCaptureTimeDraft(normalized);
      setCaptureTimeSaveState('saved');
      return;
    }

    captureTimeDraftRef.current = previous;
    setCaptureTimeDraft(previous);
    setCaptureTimeSaveState('error');
  }, [props.onUpdateCaptureTime, props.photo.id]);

  useEffect(() => {
    const incoming = captureTimeInputValue(props.photo.captureTimeLocal);
    if (captureTimeDraftRef.current !== lastSavedCaptureTimeRef.current) return;
    lastSavedCaptureTimeRef.current = incoming;
    captureTimeDraftRef.current = incoming;
    setCaptureTimeDraft(incoming);
    setCaptureTimeSaveState('saved');
  }, [props.photo.captureTimeLocal]);

  const saveNote = useCallback(async (nextNote: string): Promise<void> => {
    if (nextNote === lastSavedNoteRef.current) {
      setNoteSaveState('saved');
      return;
    }
    const revision = noteSaveRevisionRef.current + 1;
    noteSaveRevisionRef.current = revision;
    setNoteSaveState('saving');
    const saved = await props.onUpdateNote(props.photo.id, nextNote);
    if (revision !== noteSaveRevisionRef.current) return;
    if (saved) {
      const normalized = nextNote.trim();
      lastSavedNoteRef.current = normalized;
      setNoteDraft(normalized);
      setNoteSaveState('saved');
    } else {
      setNoteSaveState('error');
    }
  }, [props.onUpdateNote, props.photo.id]);

  useEffect(() => {
    if (noteDraft === lastSavedNoteRef.current) return undefined;
    setNoteSaveState('pending');
    noteTimerRef.current = window.setTimeout(() => {
      noteTimerRef.current = undefined;
      void saveNote(noteDraft);
    }, 560);
    return () => {
      if (noteTimerRef.current !== undefined) window.clearTimeout(noteTimerRef.current);
    };
  }, [noteDraft, saveNote]);

  useEffect(() => {
    noteDraftRef.current = noteDraft;
    updateNoteRef.current = props.onUpdateNote;
  }, [noteDraft, props.onUpdateNote]);

  useEffect(() => () => {
    if (noteTimerRef.current !== undefined) window.clearTimeout(noteTimerRef.current);
    const pendingNote = noteDraftRef.current;
    if (pendingNote !== lastSavedNoteRef.current) {
      void updateNoteRef.current(props.photo.id, pendingNote);
    }
  }, [props.photo.id]);

  useEffect(() => {
    if (!fileNameEditing) setFileNameDraft(props.photo.name);
  }, [fileNameEditing, props.photo.name]);

  useEffect(() => {
    if (!fileNameEditing) return;
    const input = fileNameInputRef.current;
    if (!input) return;
    input.focus();
    const extensionStart = input.value.lastIndexOf('.');
    input.setSelectionRange(0, extensionStart > 0 ? extensionStart : input.value.length);
  }, [fileNameEditing]);

  function beginFileNameEdit(): void {
    setFileNameDraft(props.photo.name);
    setFileNameSaveState('saved');
    setFileNameEditing(true);
  }

  function cancelFileNameEdit(): void {
    if (fileNameSaveState === 'saving') return;
    setFileNameDraft(props.photo.name);
    setFileNameSaveState('saved');
    setFileNameEditing(false);
    window.requestAnimationFrame(() => fileNameEditButtonRef.current?.focus());
  }

  async function confirmFileNameEdit(): Promise<void> {
    if (!props.interactive || fileNameSaveState === 'saving') return;
    if (fileNameDraft === props.photo.name) {
      setFileNameSaveState('saved');
      setFileNameEditing(false);
      window.requestAnimationFrame(() => fileNameEditButtonRef.current?.focus());
      return;
    }
    setFileNameSaveState('saving');
    const saved = await props.onRenamePhoto(props.photo.id, fileNameDraft);
    setFileNameSaveState(saved ? 'saved' : 'error');
    if (saved) {
      setFileNameEditing(false);
      window.requestAnimationFrame(() => fileNameEditButtonRef.current?.focus());
    } else {
      window.requestAnimationFrame(() => fileNameInputRef.current?.focus());
    }
  }

  async function updateLocation(nextProvinceCode: string, nextCityCode: string): Promise<void> {
    const previousProvinceCode = provinceCode;
    const previousCityCode = cityCode;
    setProvinceCode(nextProvinceCode);
    setCityCode(nextCityCode);
    setMetadataSaveState('saving');
    const saved = await props.onUpdateLocation(
      [props.photo.id],
      nextProvinceCode || undefined,
      nextCityCode || undefined,
    );
    if (!saved) {
      setProvinceCode(previousProvinceCode);
      setCityCode(previousCityCode);
    }
    setMetadataSaveState(saved ? 'saved' : 'error');
  }

  async function toggleType(typeId: string): Promise<void> {
    const previousTypes = selectedTypes;
    const wasSelected = previousTypes.has(typeId);
    const nextTypes = new Set(previousTypes);
    if (wasSelected) nextTypes.delete(typeId);
    else nextTypes.add(typeId);
    setSelectedTypes(nextTypes);
    setMetadataSaveState('saving');
    const saved = await props.onUpdateTypes(
      [props.photo.id],
      wasSelected ? [] : [typeId],
      wasSelected ? [typeId] : [],
    );
    if (!saved) setSelectedTypes(previousTypes);
    setMetadataSaveState(saved ? 'saved' : 'error');
  }

  const combinedSaveState: SaveState = noteSaveState === 'error'
    || metadataSaveState === 'error'
    || captureTimeSaveState === 'error'
    || fileNameSaveState === 'error'
    ? 'error'
    : noteSaveState === 'saving'
      || metadataSaveState === 'saving'
      || captureTimeSaveState === 'saving'
      || fileNameSaveState === 'saving'
      ? 'saving'
      : noteSaveState === 'pending'
        || captureTimeSaveState === 'pending'
        || fileNameSaveState === 'pending'
        ? 'pending'
        : 'saved';
  const saveMessage = combinedSaveState === 'saving'
    ? '正在保存到本地索引…'
    : combinedSaveState === 'pending'
      ? fileNameSaveState === 'pending'
        ? '文件名修改尚未确认'
        : '稍后自动保存…'
      : combinedSaveState === 'error'
        ? '保存失败，请重试'
        : '已保存到本地索引';

  return (
    <article
      className="postcard-card is-current"
      data-testid="postcard-current"
      data-photo-id={props.photo.id}
      aria-label={`${props.photo.name}明信片`}
      inert={!props.interactive}
      style={props.motionStyle}
    >
      <div className="postcard-photo">
        <div className="postcard-entry-media-target" data-testid="postcard-entry-media-target">
          {props.photo.decodeState === 'valid' ? (
            props.photo.mediaKind === 'photo'
              ? <img src={annotationPreviewUrl(props.photo)} alt={props.photo.name} draggable={false} />
              : <PostcardPlayableMedia photo={props.photo} active={props.mediaActive} />
          ) : (
            <div className="postcard-decode-placeholder">
              <WarningCircle size={42} weight="duotone" />
              <strong>{props.photo.name}</strong>
              <span>{props.photo.decodeMessage}</span>
            </div>
          )}
        </div>
        <span className={`media-kind-badge media-kind-${props.photo.mediaKind}`} data-testid="media-kind-badge">
          {mediaKindLabel(props.photo.mediaKind)}
        </span>
        <span className="postcard-sequence">MEMORY · {String(props.sequence).padStart(2, '0')}</span>
      </div>

      <section className="postcard-copy" aria-label={`${props.photo.name}照片信息`} aria-busy={combinedSaveState === 'saving'}>
        <div className="postcard-basics">
          <div className="postcard-file-name-row" data-testid="postcard-file-name-row">
            <span>文件名称</span>
            {fileNameEditing ? (
              <div className="postcard-file-name-editor" data-testid="postcard-file-name-editor" aria-busy={fileNameSaveState === 'saving'}>
                <input
                  ref={fileNameInputRef}
                  data-testid="postcard-file-name-input"
                  value={fileNameDraft}
                  maxLength={MAX_MEDIA_FILE_NAME_LENGTH}
                  aria-label="完整文件名（含扩展名）"
                  aria-invalid={fileNameSaveState === 'error'}
                  disabled={!props.interactive || fileNameSaveState === 'saving'}
                  spellCheck={false}
                  onChange={(event) => {
                    const nextFileName = event.currentTarget.value;
                    setFileNameDraft(nextFileName);
                    setFileNameSaveState(nextFileName === props.photo.name ? 'saved' : 'pending');
                  }}
                  onKeyDown={(event) => {
                    if (isImeCompositionKey(event.nativeEvent.isComposing, event.keyCode)) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void confirmFileNameEdit();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelFileNameEdit();
                    }
                  }}
                />
                <button
                  type="button"
                  data-testid="postcard-rename-confirm"
                  disabled={!props.interactive || fileNameSaveState === 'saving' || fileNameDraft.trim().length === 0}
                  onClick={() => void confirmFileNameEdit()}
                >
                  确认
                </button>
                <button
                  type="button"
                  data-testid="postcard-rename-cancel"
                  disabled={!props.interactive || fileNameSaveState === 'saving'}
                  onClick={cancelFileNameEdit}
                >
                  取消
                </button>
              </div>
            ) : (
              <div className="postcard-file-name-display">
                <strong title={props.photo.name}>{props.photo.name}</strong>
                <button
                  ref={fileNameEditButtonRef}
                  type="button"
                  data-testid="postcard-rename-edit"
                  aria-label={`重命名 ${props.photo.name}`}
                  title="修改完整文件名（含扩展名）"
                  disabled={!props.interactive}
                  onClick={beginFileNameEdit}
                >
                  重命名
                </button>
              </div>
            )}
          </div>
          <div>
            <span>拍摄时间</span>
            <div className="postcard-capture-time-field">
              <input
                id={`postcard-capture-time-${props.photo.id}`}
                data-testid="postcard-capture-time"
                type="datetime-local"
                step={1}
                value={captureTimeDraft}
                aria-label="照片拍摄时间"
                aria-describedby={captureTimeHelpId}
                disabled={!props.interactive || captureTimeSaveState === 'saving'}
                onChange={(event) => {
                  captureTimeSaveRevisionRef.current += 1;
                  captureTimeDraftRef.current = event.currentTarget.value;
                  setCaptureTimeDraft(event.currentTarget.value);
                  setCaptureTimeSaveState('pending');
                }}
                onBlur={() => void saveCaptureTime(captureTimeDraftRef.current)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    captureTimeSaveRevisionRef.current += 1;
                    captureTimeDraftRef.current = lastSavedCaptureTimeRef.current;
                    setCaptureTimeDraft(lastSavedCaptureTimeRef.current);
                    setCaptureTimeSaveState('saved');
                    event.currentTarget.blur();
                  }
                }}
              />
              <small id={captureTimeHelpId}>
                {captureTimeDraft ? captureTimeOffset ?? '按照片记录的当地时间' : '未读取到拍摄时间'}
              </small>
            </div>
          </div>
        </div>

        <section className="postcard-location-editor" aria-label="拍摄地点">
          <h2>拍摄地点</h2>
          <div>
            <label>
              <span>省份</span>
              <select
                aria-label="选择省份"
                value={provinceCode}
                disabled={!props.interactive || metadataSaveState === 'saving'}
                onChange={(event) => void updateLocation(event.currentTarget.value, '')}
              >
                <option value="">未选择</option>
                {props.provinces.map((province) => <option value={province.code} key={province.code}>{province.name}</option>)}
              </select>
            </label>
            <label>
              <span>城市</span>
              <select
                aria-label="选择城市"
                value={cityCode}
                disabled={!props.interactive || metadataSaveState === 'saving' || !provinceCode}
                onChange={(event) => void updateLocation(provinceCode, event.currentTarget.value)}
              >
                <option value="">只标记到省</option>
                {cityOptions.map((city) => <option value={city.code} key={city.code}>{city.name}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="postcard-type-editor" aria-label="标签">
          <h2>标签</h2>
          <div>
            {props.photoTypes.map((type) => {
              const selected = selectedTypes.has(type.id);
              return (
                <button
                  type="button"
                  key={type.id}
                  className={selected ? 'selected' : ''}
                  aria-pressed={selected}
                  disabled={!props.interactive || metadataSaveState === 'saving'}
                  onClick={() => void toggleType(type.id)}
                >
                  {type.name}
                </button>
              );
            })}
            {props.photoTypes.length === 0 && <span className="postcard-no-types">还没有标签</span>}
          </div>
        </section>

        <div className="postcard-note">
          <div><label htmlFor={`postcard-note-${props.photo.id}`}>照片记忆</label><output>{noteDraft.length} / {MAX_PHOTO_NOTE_LENGTH}</output></div>
          <textarea
            id={`postcard-note-${props.photo.id}`}
            data-testid="postcard-note"
            value={noteDraft}
            maxLength={MAX_PHOTO_NOTE_LENGTH}
            disabled={!props.interactive}
            placeholder="写下这张照片的记忆…"
            onChange={(event) => {
              noteSaveRevisionRef.current += 1;
              noteDraftRef.current = event.currentTarget.value;
              setNoteDraft(event.currentTarget.value);
            }}
            onBlur={() => {
              if (noteTimerRef.current !== undefined) {
                window.clearTimeout(noteTimerRef.current);
                noteTimerRef.current = undefined;
              }
              void saveNote(noteDraftRef.current);
            }}
          />
        </div>

        <footer className="postcard-save-row">
          <span className={`postcard-save-state ${combinedSaveState}`} role={combinedSaveState === 'error' ? 'alert' : 'status'}>
            {combinedSaveState === 'error' ? <WarningCircle size={17} /> : <CheckCircle size={17} weight="fill" />}
            {saveMessage}
          </span>
          <button type="button" className="postcard-trash" disabled={!props.interactive || fileNameSaveState === 'saving'} onClick={() => props.onRequestTrash([props.photo.id])}>
            <Trash size={15} />移入回收站
          </button>
        </footer>
      </section>
    </article>
  );
}
