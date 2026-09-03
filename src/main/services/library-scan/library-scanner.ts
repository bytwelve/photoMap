import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isImageFormat, type ScanCounts, type ScanMetadataSummary, type ScanProgress } from '../../../shared/contracts';
import { canonicalPathKey } from '../../infrastructure/filesystem/path-policy';
import { enumerateMediaFiles } from '../../infrastructure/filesystem/enumerate-media';
import { sha256File } from './hash-file';
import { classifyMediaCandidates, type MediaCandidate } from './media-classification';
import type {
  ExistingPhotoFact,
  GpsLocationResolver,
  LibraryScanOptions,
  MediaProbe,
  PhotoMetadataProbe,
  ScanRepository,
  ScannedCompanionFile,
  ScannedFile
} from './models';

export interface ScanResult {
  progress: ScanProgress;
}

export const PROGRESSIVE_SCAN_BATCH_SIZE = 16;

const NOOP_METADATA_PROBE: PhotoMetadataProbe = {
  async probe() {
    return { hasExif: false, gps: null, captureTime: null };
  }
};

const NOOP_LOCATION_RESOLVER: GpsLocationResolver = {
  resolveGps() {
    return null;
  }
};

export class LibraryScanner {
  public constructor(
    private readonly repository: ScanRepository,
    private readonly mediaProbe: MediaProbe,
    private readonly metadataProbe: PhotoMetadataProbe = NOOP_METADATA_PROBE,
    private readonly locationResolver: GpsLocationResolver = NOOP_LOCATION_RESOLVER
  ) {}

  public async scan(
    sourceId: string,
    rootPath: string,
    signal: AbortSignal,
    options: LibraryScanOptions
  ): Promise<ScanResult> {
    const shouldProbePhotoMetadata = options.gpsMetadataPolicy !== 'skip';
    const shouldResolveGpsMetadata = options.gpsMetadataPolicy === 'probe-and-resolve';
    const runId = this.repository.startScanRun(sourceId);
    const counts: ScanCounts = { discovered: 0, indexed: 0, unchanged: 0, errors: 0 };
    const metadataSummary: ScanMetadataSummary | undefined = shouldProbePhotoMetadata
      ? {
          examined: 0,
          exifCount: 0,
          gpsCount: 0,
          resolvedLocationCount: 0,
          captureTimeCount: 0,
          metadataErrorCount: 0
        }
      : undefined;
    const locationsByPath = new Map<string, NonNullable<ReturnType<GpsLocationResolver['resolveGps']>>>();
    const captureTimesByPath = new Map<string, NonNullable<Awaited<ReturnType<PhotoMetadataProbe['probe']>>['captureTime']>>();
    let catalogCommitCount = 0;
    const publish = (
      status: ScanProgress['status'],
      currentFileName?: string,
      metadata?: ScanMetadataSummary
    ): ScanProgress => {
      const progress: ScanProgress = {
        runId,
        sourceId,
        status,
        counts: { ...counts },
        catalogCommitCount,
        ...(metadata === undefined ? {} : { metadata: { ...metadata } }),
        ...(currentFileName === undefined ? {} : { currentFileName })
      };
      options.onProgress(progress);
      return progress;
    };

    publish('running');
    const enumeration = await enumerateMediaFiles(rootPath, signal);
    const mediaCandidates = await classifyMediaCandidates(enumeration.files, signal);
    counts.discovered = mediaCandidates.length;
    counts.errors += enumeration.issues.length;

    const existing = this.repository.getExistingPhotoFacts(sourceId);
    const existingByPath = new Map(existing.map((record) => [record.canonicalPathKey, record]));
    const enumeratedPathKeys = new Set(
      mediaCandidates.map((candidate) => canonicalPathKey(candidate.primary.absolutePath))
    );
    const possibleMoveHashes = new Set(
      existing
        .filter(
          (record) =>
            record.contentSha256 !== null &&
            (record.lifecycleState === 'missing' ||
              ((record.lifecycleState === 'active' || record.lifecycleState === 'trashed') &&
                !enumeratedPathKeys.has(record.canonicalPathKey)))
        )
        .map((record) => record.contentSha256 as string)
    );
    const scanned: ScannedFile[] = [];
    const pendingSafeFiles: ScannedFile[] = [];
    let hasProgressiveCommit = false;
    const flushProgressiveBatch = (): void => {
      if (pendingSafeFiles.length === 0) return;
      const batch = pendingSafeFiles.splice(0, pendingSafeFiles.length);
      this.repository.reconcileScan(sourceId, runId, batch, false);
      catalogCommitCount += batch.length;
      hasProgressiveCommit = true;
    };

    for (const candidate of mediaCandidates) {
      if (signal.aborted) {
        break;
      }
      const currentFileName = path.basename(candidate.primary.absolutePath);
      const canonicalKey = canonicalPathKey(candidate.primary.absolutePath);
      let scannedFile: ScannedFile | undefined;
      try {
        const stats = await lstat(candidate.primary.absolutePath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          continue;
        }
        const companionStats = candidate.companion === undefined
          ? undefined
          : await lstat(candidate.companion.absolutePath);
        if (companionStats && (!companionStats.isFile() || companionStats.isSymbolicLink())) {
          continue;
        }
        if (metadataSummary !== undefined && isImageFormat(candidate.primary.mediaFormat)) {
          metadataSummary.examined += 1;
          try {
            const metadata = await this.metadataProbe.probe(
              candidate.primary.absolutePath,
              candidate.primary.mediaFormat,
              signal
            );
            if (metadata.hasExif) metadataSummary.exifCount += 1;
            if (metadata.metadataError === true) metadataSummary.metadataErrorCount += 1;
            if (metadata.gps !== null) {
              metadataSummary.gpsCount += 1;
              if (shouldResolveGpsMetadata) {
                const location = this.locationResolver.resolveGps(metadata.gps);
                if (location !== null) locationsByPath.set(canonicalKey, location);
              }
            }
            if (metadata.captureTime !== null) {
              captureTimesByPath.set(canonicalKey, metadata.captureTime);
            }
          } catch {
            metadataSummary.metadataErrorCount += 1;
          }
        }
        if (signal.aborted) break;
        const fileCreatedAtMs = this.normalizeFileCreatedAtMs(stats.birthtimeMs);
        const old = existingByPath.get(canonicalKey);
        if (this.isUnchanged(old, candidate, stats.size, stats.mtimeMs, companionStats?.size, companionStats?.mtimeMs)) {
          scannedFile = this.reuseExisting(
            old,
            candidate,
            fileCreatedAtMs,
            companionStats === undefined ? null : this.normalizeFileCreatedAtMs(companionStats.birthtimeMs),
          );
          counts.unchanged += 1;
        } else {
          const contentSha256 = await sha256File(candidate.primary.absolutePath, signal);
          if (signal.aborted) {
            break;
          }
          const probe = await this.mediaProbe.probe(
            candidate.primary.absolutePath,
            candidate.primary.mediaFormat,
            candidate.mediaKind,
          );
          if (probe.decodeState !== 'valid') {
            counts.errors += 1;
          } else {
            counts.indexed += 1;
          }
          const companion = candidate.companion && companionStats
            ? await this.scanCompanion(candidate.companion, companionStats, signal)
            : undefined;
          scannedFile = {
            absolutePath: candidate.primary.absolutePath,
            relativePath: candidate.primary.relativePath,
            canonicalPathKey: canonicalKey,
            fileSize: stats.size,
            modifiedAtMs: stats.mtimeMs,
            fileCreatedAtMs,
            contentSha256,
            mediaKind: candidate.mediaKind,
            mediaFormat: candidate.primary.mediaFormat,
            pixelWidth: probe.decodeState === 'valid' ? probe.pixelWidth : null,
            pixelHeight: probe.decodeState === 'valid' ? probe.pixelHeight : null,
            decodeState: probe.decodeState,
            ...(companion === undefined ? {} : { companion }),
          };
        }
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          break;
        }
        counts.errors += 1;
        try {
          const stats = await lstat(candidate.primary.absolutePath);
          if (stats.isFile() && !stats.isSymbolicLink()) {
            scannedFile = {
              absolutePath: candidate.primary.absolutePath,
              relativePath: candidate.primary.relativePath,
              canonicalPathKey: canonicalKey,
              fileSize: stats.size,
              modifiedAtMs: stats.mtimeMs,
              fileCreatedAtMs: this.normalizeFileCreatedAtMs(stats.birthtimeMs),
              contentSha256: null,
              mediaKind: candidate.mediaKind,
              mediaFormat: candidate.primary.mediaFormat,
              pixelWidth: null,
              pixelHeight: null,
              decodeState: 'unreadable'
            };
          }
        } catch {
          // A file may disappear between enumeration and probing. Other files still commit.
        }
      }

      if (scannedFile !== undefined) {
        scanned.push(scannedFile);
        if (this.canCommitProgressively(scannedFile, existingByPath, possibleMoveHashes)) {
          pendingSafeFiles.push(scannedFile);
          if (!hasProgressiveCommit || pendingSafeFiles.length >= PROGRESSIVE_SCAN_BATCH_SIZE) {
            flushProgressiveBatch();
          }
        }
      }
      publish('running', currentFileName);
    }

    flushProgressiveBatch();
    const cancelled = signal.aborted;
    if (!cancelled) {
      this.repository.reconcileScan(sourceId, runId, scanned, true);
    }
    const status: ScanProgress['status'] = cancelled
      ? 'cancelled'
      : counts.errors > 0 || (metadataSummary?.metadataErrorCount ?? 0) > 0
        ? 'partial'
        : 'succeeded';
    if (!cancelled && metadataSummary !== undefined) {
      const activeByPath = new Map(
        this.repository
          .getExistingPhotoFacts(sourceId)
          .filter((photo) => photo.lifecycleState === 'active')
          .map((photo) => [photo.canonicalPathKey, photo])
      );
      const assignments = [...locationsByPath].flatMap(([canonicalKey, location]) => {
        const photo = activeByPath.get(canonicalKey);
        return photo === undefined ? [] : [{ photoId: photo.photoId, location }];
      });
      const captureTimes = [...captureTimesByPath].flatMap(([canonicalKey, captureTime]) => {
        const photo = activeByPath.get(canonicalKey);
        return photo === undefined ? [] : [{ photoId: photo.photoId, captureTime }];
      });
      metadataSummary.resolvedLocationCount = assignments.length;
      metadataSummary.captureTimeCount = captureTimes.length;
      if (assignments.length > 0 || captureTimes.length > 0) {
        options.onLocationProposal?.({
          runId,
          sourceId,
          summary: { ...metadataSummary },
          assignments,
          captureTimes
        });
      }
    }
    const includeMetadata = metadataSummary !== undefined && (
      metadataSummary.exifCount > 0
      || metadataSummary.gpsCount > 0
      || metadataSummary.captureTimeCount > 0
      || metadataSummary.metadataErrorCount > 0
    );
    const finalProgress = publish(status, undefined, includeMetadata ? metadataSummary : undefined);
    this.repository.finishScanRun(runId, finalProgress);
    return { progress: finalProgress };
  }

  private isUnchanged(
    existing: ExistingPhotoFact | undefined,
    candidate: MediaCandidate,
    fileSize: number,
    modifiedAtMs: number,
    companionFileSize: number | undefined,
    companionModifiedAtMs: number | undefined,
  ): existing is ExistingPhotoFact {
    const companionUnchanged = candidate.companion === undefined
      ? existing?.companion === null
      : existing?.companion !== null
        && existing?.companion !== undefined
        && existing.companion.canonicalPathKey === canonicalPathKey(candidate.companion.absolutePath)
        && existing.companion.contentSha256 !== null
        && existing.companion.fileSize === companionFileSize
        && existing.companion.modifiedAtMs === companionModifiedAtMs;
    return (
      existing !== undefined &&
      existing.needsRescan !== true &&
      existing.contentSha256 !== null &&
      existing.lifecycleState !== 'replaced' &&
      existing.mediaKind === candidate.mediaKind &&
      existing.mediaFormat === candidate.primary.mediaFormat &&
      existing.fileSize === fileSize &&
      existing.modifiedAtMs === modifiedAtMs &&
      companionUnchanged
    );
  }

  private reuseExisting(
    existing: ExistingPhotoFact,
    candidate: MediaCandidate,
    fileCreatedAtMs: number | null,
    companionFileCreatedAtMs: number | null,
  ): ScannedFile {
    const companion = candidate.companion && existing.companion
      ? {
          ...existing.companion,
          absolutePath: candidate.companion.absolutePath,
          relativePath: candidate.companion.relativePath,
          canonicalPathKey: canonicalPathKey(candidate.companion.absolutePath),
          fileCreatedAtMs: companionFileCreatedAtMs,
        }
      : undefined;
    return {
      absolutePath: candidate.primary.absolutePath,
      relativePath: candidate.primary.relativePath,
      canonicalPathKey: existing.canonicalPathKey,
      fileSize: existing.fileSize,
      modifiedAtMs: existing.modifiedAtMs,
      fileCreatedAtMs,
      contentSha256: existing.contentSha256,
      mediaKind: existing.mediaKind,
      mediaFormat: existing.mediaFormat,
      pixelWidth: existing.pixelWidth,
      pixelHeight: existing.pixelHeight,
      decodeState: existing.decodeState,
      ...(companion === undefined ? {} : { companion }),
    };
  }

  private async scanCompanion(
    candidate: NonNullable<MediaCandidate['companion']>,
    stats: { size: number; mtimeMs: number; birthtimeMs: number },
    signal: AbortSignal,
  ): Promise<ScannedCompanionFile> {
    const contentSha256 = await sha256File(candidate.absolutePath, signal);
    return {
      absolutePath: candidate.absolutePath,
      relativePath: candidate.relativePath,
      canonicalPathKey: canonicalPathKey(candidate.absolutePath),
      fileSize: stats.size,
      modifiedAtMs: stats.mtimeMs,
      fileCreatedAtMs: this.normalizeFileCreatedAtMs(stats.birthtimeMs),
      contentSha256,
      mediaFormat: candidate.mediaFormat,
    };
  }

  private normalizeFileCreatedAtMs(birthtimeMs: number): number | null {
    return Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : null;
  }

  private canCommitProgressively(
    file: ScannedFile,
    existingByPath: ReadonlyMap<string, ExistingPhotoFact>,
    possibleMoveHashes: ReadonlySet<string>
  ): boolean {
    if (file.contentSha256 === null) {
      return false;
    }
    if (existingByPath.has(file.canonicalPathKey)) {
      return true;
    }
    return !possibleMoveHashes.has(file.contentSha256);
  }
}
