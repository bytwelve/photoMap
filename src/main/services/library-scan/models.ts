import type {
  DecodeState,
  CaptureTimeValue,
  ImageFormat,
  LocationAssignment,
  MediaFormat,
  MediaKind,
  PhotoLifecycle,
  ScanMetadataSummary,
  ScanProgress
} from '../../../shared/contracts';
import type { ExifGpsMetadata, GpsCoordinates } from './exif-gps-reader';

export interface ExistingPhotoFact {
  photoId: string;
  absolutePath: string;
  relativePath: string;
  canonicalPathKey: string;
  fileSize: number;
  modifiedAtMs: number;
  fileCreatedAtMs: number | null;
  contentSha256: string | null;
  mediaKind: MediaKind;
  mediaFormat: MediaFormat;
  pixelWidth: number | null;
  pixelHeight: number | null;
  decodeState: DecodeState;
  lifecycleState: PhotoLifecycle;
  /** A detected external change invalidates the size/mtime scan shortcut. */
  needsRescan?: boolean;
  companion: ExistingCompanionFact | null;
}

export interface ExistingCompanionFact {
  absolutePath: string;
  relativePath: string;
  canonicalPathKey: string;
  fileSize: number;
  modifiedAtMs: number;
  fileCreatedAtMs: number | null;
  contentSha256: string | null;
  mediaFormat: MediaFormat;
}

export type ScannedCompanionFile = ExistingCompanionFact;

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  canonicalPathKey: string;
  fileSize: number;
  modifiedAtMs: number;
  fileCreatedAtMs: number | null;
  contentSha256: string | null;
  mediaKind: MediaKind;
  mediaFormat: MediaFormat;
  pixelWidth: number | null;
  pixelHeight: number | null;
  decodeState: DecodeState;
  companion?: ScannedCompanionFile;
}

export interface MediaProbeResult {
  pixelWidth: number;
  pixelHeight: number;
  decodeState: 'valid' | 'corrupt';
}

export interface MediaProbe {
  probe(filePath: string, mediaFormat: MediaFormat, mediaKind: MediaKind): Promise<MediaProbeResult>;
}

export interface PhotoMetadataProbe {
  probe(filePath: string, imageFormat: ImageFormat, signal?: AbortSignal): Promise<ExifGpsMetadata>;
}

export interface GpsLocationResolver {
  resolveGps(gps: GpsCoordinates): LocationAssignment | null;
}

export interface SuggestedPhotoLocation {
  photoId: string;
  location: LocationAssignment;
}

export interface SuggestedPhotoCaptureTime {
  photoId: string;
  captureTime: CaptureTimeValue;
}

export interface ScanLocationProposal {
  runId: string;
  sourceId: string;
  summary: ScanMetadataSummary;
  assignments: SuggestedPhotoLocation[];
  captureTimes: SuggestedPhotoCaptureTime[];
}

export type GpsMetadataPolicy = 'skip' | 'probe-without-resolve' | 'probe-and-resolve';

export interface LibraryScanOptions {
  gpsMetadataPolicy: GpsMetadataPolicy;
  onProgress(progress: ScanProgress): void;
  onLocationProposal?(proposal: ScanLocationProposal): void;
}

export interface ReconcileResult {
  indexed: number;
  changed: boolean;
}

export interface ScanRepository {
  startScanRun(sourceId: string): string;
  getExistingPhotoFacts(sourceId: string): ExistingPhotoFact[];
  reconcileScan(sourceId: string, runId: string, files: ScannedFile[], complete: boolean): ReconcileResult;
  finishScanRun(runId: string, progress: ScanProgress): void;
}
