import type {
  ApiResult,
  AppError,
  LibrarySnapshot,
  ScanProgress as ContractScanProgress,
} from '../shared/contracts';
import type { AdministrativeRegion as RegionOption } from '../shared/administrative-regions';
import type { LibraryState, PhotoRecord, ScanProgress } from './model';

export interface RegionNames {
  provinces: ReadonlyMap<string, string>;
  cities: ReadonlyMap<string, string>;
}

export function regionNamesFromOptions(
  provinces: readonly RegionOption[],
  cities: readonly RegionOption[],
): RegionNames {
  const toMap = (regions: readonly RegionOption[]): ReadonlyMap<string, string> => new Map(
    regions.map((region) => [region.code, region.name]),
  );
  return { provinces: toMap(provinces), cities: toMap(cities) };
}

export function toScanProgress(scan: ContractScanProgress): ScanProgress {
  const state = scan.status === 'succeeded' ? 'complete' : scan.status;
  const processed = Math.min(
    scan.counts.discovered,
    scan.counts.indexed + scan.counts.unchanged + scan.counts.errors,
  );
  const succeeded = Math.min(
    scan.counts.discovered,
    scan.counts.indexed + scan.counts.unchanged,
  );
  return {
    state,
    discovered: scan.counts.discovered,
    processed,
    succeeded,
    failed: scan.counts.errors,
    skipped: scan.counts.unchanged,
    message: scan.currentFileName,
  };
}

export function toLibraryState(snapshot: LibrarySnapshot, names: RegionNames): LibraryState {
  const typeById = new Map(snapshot.photoTypes.map((type) => [type.typeId, type]));
  const photos: PhotoRecord[] = snapshot.photos
    .filter((photo) => photo.lifecycleState === 'active')
    .map((photo) => {
      const provinceCode = photo.location?.provinceGb;
      const cityCode = photo.location?.cityGb;
      return {
        id: photo.photoId,
        name: photo.fileName,
        folderPath: photo.folderPath ?? undefined,
        mediaUrl: photo.mediaUrl,
        thumbnailUrl: photo.thumbnailUrl,
        mediaKind: photo.mediaKind,
        mediaFormat: photo.mediaFormat,
        ...(photo.fileCreatedAtMs === null ? {} : { fileCreatedAtMs: photo.fileCreatedAtMs }),
        captureTimeLocal: photo.captureTime?.localDateTime ?? null,
        captureTimeOffsetMinutes: photo.captureTime?.offsetMinutes ?? null,
        captureTimeSource: photo.captureTime?.source ?? null,
        note: photo.note,
        decodeState: photo.decodeState,
        decodeMessage: photo.decodeState === 'valid' ? undefined : decodeStateMessage(photo.decodeState),
        width: photo.pixelWidth ?? undefined,
        height: photo.pixelHeight ?? undefined,
        location: provinceCode ? {
          provinceCode,
          provinceName: names.provinces.get(provinceCode) ?? provinceCode,
          cityCode,
          cityName: cityCode ? names.cities.get(cityCode) ?? cityCode : undefined,
        } : undefined,
        types: photo.typeIds.flatMap((id) => {
          const type = typeById.get(id);
          return type ? [{ id: type.typeId, name: type.name, builtin: type.isBuiltin }] : [];
        }),
      };
    });
  return {
    sourceId: snapshot.source?.sourceId,
    sourceName: snapshot.source?.displayName,
    sourceAvailable: snapshot.source?.availability === 'available',
    photos,
    photoTypes: snapshot.photoTypes.map((type) => ({
      id: type.typeId,
      name: type.name,
      builtin: type.isBuiltin,
    })),
    scan: toScanProgress(snapshot.scan),
  };
}

export function decodeStateMessage(state: PhotoRecord['decodeState']): string {
  switch (state) {
    case 'corrupt': return '媒体文件已损坏或无法解码';
    case 'unreadable': return '没有权限读取这个媒体文件';
    case 'unsupported': return '媒体编码暂不支持';
    case 'unknown': return '尚未完成媒体检查';
    default: return '';
  }
}

export function unwrapResult<T>(result: ApiResult<T>): T {
  if (result.ok) return result.value;
  // AppError is a plain object, not an Error instance: IPC structured clone cannot carry
  // an Error's prototype or stack, so the contract transports the shape instead.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw result.error;
}

export function isAppError(error: unknown): error is AppError {
  return Boolean(
    error
    && typeof error === 'object'
    && 'userMessage' in error
    && typeof (error as { userMessage?: unknown }).userMessage === 'string',
  );
}

export function errorMessage(error: unknown): string {
  if (isAppError(error)) return error.userMessage;
  if (error instanceof Error) return error.message;
  return '操作没有完成，请重试';
}
