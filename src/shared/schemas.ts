import type {
  CreateTypeRequest,
  RenamePhotoRequest,
  ResolveScanLocationsRequest,
  SaveExportRequest,
  TrashPhotosRequest,
  UpdateLocationsRequest,
  UpdateCaptureTimeRequest,
  UpdateNoteRequest,
  UpdateTypesRequest
} from './contracts';
import { MAX_MEDIA_FILE_NAME_LENGTH, MAX_PHOTO_NOTE_LENGTH } from './contracts';
import { normalizeCaptureLocalDateTime } from './capture-time';
import { PhotoMapError } from './errors';

const MAX_BATCH_SIZE = 10_000;
const MAX_EXPORT_DATA_URL_LENGTH = 140 * 1024 * 1024;
const GB_PATTERN = /^156\d{6}$/;
const WINDOWS_RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

function invalid(message: string): never {
  throw new PhotoMapError('INVALID_REQUEST', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseIds(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_SIZE) {
    return invalid(`${fieldName} 必须是非空且数量受限的 ID 列表。`);
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 128) {
      return invalid(`${fieldName} 包含无效 ID。`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      ids.push(item);
    }
  }
  return ids;
}

function parseOptionalIds(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_BATCH_SIZE) {
    return invalid(`${fieldName} 必须是数量受限的 ID 列表。`);
  }
  if (value.length === 0) {
    return [];
  }
  return parseIds(value, fieldName);
}

export function parseUpdateLocationsRequest(value: unknown): UpdateLocationsRequest {
  if (!isRecord(value)) {
    return invalid('地点更新请求格式无效。');
  }
  const photoIds = parseIds(value.photoIds, 'photoIds');
  if (value.location === null) {
    return { photoIds, location: null };
  }
  if (!isRecord(value.location) || typeof value.location.provinceGb !== 'string') {
    return invalid('地点必须包含有效省级代码。');
  }
  const provinceGb = value.location.provinceGb;
  const cityGb = value.location.cityGb;
  if (!GB_PATTERN.test(provinceGb)) {
    return invalid('省级代码格式无效。');
  }
  if (cityGb !== undefined && (typeof cityGb !== 'string' || !GB_PATTERN.test(cityGb))) {
    return invalid('市级代码格式无效。');
  }
  return {
    photoIds,
    location: { provinceGb, ...(cityGb === undefined ? {} : { cityGb }) }
  };
}

export function parseResolveScanLocationsRequest(value: unknown): ResolveScanLocationsRequest {
  if (
    !isRecord(value)
    || typeof value.runId !== 'string'
    || value.runId.length === 0
    || value.runId.length > 128
    || (
      value.decision !== 'ignore'
      && value.decision !== 'overwrite-all-resolved'
      && value.decision !== 'fill-unlabeled-only'
    )
  ) {
    return invalid('扫描地点确认请求格式无效。');
  }
  return { runId: value.runId, decision: value.decision };
}

export function parseUpdateTypesRequest(value: unknown): UpdateTypesRequest {
  if (!isRecord(value)) {
    return invalid('类型更新请求格式无效。');
  }
  const photoIds = parseIds(value.photoIds, 'photoIds');
  const addTypeIds = parseOptionalIds(value.addTypeIds, 'addTypeIds');
  const removeTypeIds = parseOptionalIds(value.removeTypeIds, 'removeTypeIds');
  if (addTypeIds.length === 0 && removeTypeIds.length === 0) {
    return invalid('至少要添加或移除一个标签。');
  }
  const overlap = addTypeIds.find((typeId) => removeTypeIds.includes(typeId));
  if (overlap !== undefined) {
    return invalid('同一类型不能在一次操作中同时添加和移除。');
  }
  return { photoIds, addTypeIds, removeTypeIds };
}

export function parseUpdateNoteRequest(value: unknown): UpdateNoteRequest {
  if (
    !isRecord(value)
    || typeof value.photoId !== 'string'
    || value.photoId.length === 0
    || value.photoId.length > 128
    || typeof value.note !== 'string'
  ) {
    return invalid('照片备注更新请求格式无效。');
  }
  const note = value.note.trim();
  if (note.length > MAX_PHOTO_NOTE_LENGTH) {
    return invalid(`照片备注不能超过 ${MAX_PHOTO_NOTE_LENGTH} 个字符。`);
  }
  return { photoId: value.photoId, note };
}

export function parseUpdateCaptureTimeRequest(value: unknown): UpdateCaptureTimeRequest {
  if (
    !isRecord(value)
    || typeof value.photoId !== 'string'
    || value.photoId.length === 0
    || value.photoId.length > 128
    || typeof value.localDateTime !== 'string'
  ) {
    return invalid('拍摄时间更新请求格式无效。');
  }
  const localDateTime = normalizeCaptureLocalDateTime(value.localDateTime);
  if (localDateTime === null) {
    return invalid('拍摄时间必须是有效的本地日期和时间。');
  }
  return { photoId: value.photoId, localDateTime };
}

export function parseRenamePhotoRequest(value: unknown): RenamePhotoRequest {
  if (
    !isRecord(value)
    || typeof value.photoId !== 'string'
    || value.photoId.length === 0
    || value.photoId.length > 128
    || typeof value.newFileName !== 'string'
  ) {
    return invalid('文件重命名请求格式无效。');
  }

  const newFileName = value.newFileName.trim().normalize('NFC');
  if (
    newFileName.length === 0
    || newFileName.length > MAX_MEDIA_FILE_NAME_LENGTH
    || newFileName === '.'
    || newFileName === '..'
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(newFileName)
    || /[. ]$/u.test(newFileName)
    || WINDOWS_RESERVED_FILE_NAME.test(newFileName)
  ) {
    return invalid('文件名无效，请使用不含路径或 Windows 保留字符的名称。');
  }

  return { photoId: value.photoId, newFileName };
}

export function parseCreateTypeRequest(value: unknown): CreateTypeRequest {
  if (!isRecord(value) || typeof value.name !== 'string') {
    return invalid('标签名称格式无效。');
  }
  const name = value.name.trim();
  if (name.length === 0 || name.length > 32) {
    return invalid('标签名称必须为 1–32 个字符。');
  }
  return { name };
}

export function parseTrashPhotosRequest(value: unknown): TrashPhotosRequest {
  if (!isRecord(value) || value.confirmed !== true) {
    return invalid('只能在用户明确确认后移入回收站。');
  }
  return { photoIds: parseIds(value.photoIds, 'photoIds'), confirmed: true };
}

export function parseSaveExportRequest(value: unknown): SaveExportRequest {
  if (!isRecord(value)) {
    return invalid('导出请求格式无效。');
  }
  if (value.format !== 'png') {
    return invalid('导出格式只能是 PNG。');
  }
  if (
    typeof value.dataUrl !== 'string' ||
    value.dataUrl.length === 0 ||
    value.dataUrl.length > MAX_EXPORT_DATA_URL_LENGTH
  ) {
    return invalid('导出图像数据大小或格式无效。');
  }
  if (
    typeof value.suggestedName !== 'string' ||
    value.suggestedName.length === 0 ||
    value.suggestedName.length > 128 ||
    /[/\\:\0]/.test(value.suggestedName)
  ) {
    return invalid('导出文件名无效。');
  }
  return {
    dataUrl: value.dataUrl,
    format: value.format,
    suggestedName: value.suggestedName
  };
}
