import { CatalogMigrations } from './catalog-migrations';
import { planScanReconciliation } from '../../services/library-scan/reconcile-plan';
import { asRecord, stringValue, nullableString, nullableNumber, captureTimeFromRow } from './row-mapping';
export { CATALOG_SCHEMA_VERSION } from './catalog-schema';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  BulkUpdateResult,
  CaptureTimeValue,
  DecodeState,
  ImageFormat,
  LibrarySnapshot,
  LocationAssignment,
  MediaFormat,
  MediaKind,
  PhotoLifecycle,
  PhotoSummary,
  PhotoType,
  ScanLocationDecision,
  ScanProgress,
  TrashItemStatus,
  UpdateTypesRequest
} from '../../../shared/contracts';
import { PhotoMapError } from '../../../shared/errors';
import { folderPathFromRelativePath } from '../../../shared/folder-filter';
import { photoMediaUrl, photoThumbnailUrl } from '../../../shared/media-url';
import { canonicalPathKey, isPathWithin } from '../filesystem/path-policy';
import type {
  ExistingPhotoFact,
  ReconcileResult,
  ScannedFile,
  ScanRepository
} from '../../services/library-scan/models';

const MAX_PARTIAL_RECONCILE_FILES = 128;

interface SourceRecord {
  sourceId: string;
  rootPath: string;
  canonicalRootKey: string;
  availability: 'available' | 'unavailable' | 'unknown';
}

interface PhotoRow {
  photoId: string;
  sourceId: string;
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
  needsRescan: boolean;
  note: string;
  companion: ExistingPhotoFact['companion'];
}

export interface PhotoFileRecord {
  photoId: string;
  absolutePath: string;
  rootPath: string;
  lifecycleState: PhotoLifecycle;
  contentSha256: string | null;
  fileSize: number;
  modifiedAtMs: number;
  fileCreatedAtMs?: number | null;
  mediaKind: MediaKind;
  mediaFormat: MediaFormat;
  companionAbsolutePath: string | null;
  companionFileSize: number | null;
  companionModifiedAtMs: number | null;
  companionFileCreatedAtMs?: number | null;
  companionContentSha256?: string | null;
}

export interface CatalogRepositoryOptions {
  now?: () => string;
  createId?: () => string;
  backupsDirectory?: string;
}

type UpdateCounts = Omit<BulkUpdateResult, 'library'>;

export interface SuggestedMetadataApplyResult extends UpdateCounts {
  locations: UpdateCounts;
  captureTimes: UpdateCounts;
  library: LibrarySnapshot;
}

export class NodeSqliteCatalogRepository implements ScanRepository {
  private readonly database: DatabaseSync;
  private readonly migrations: CatalogMigrations;
  private readonly now: () => string;
  private readonly createId: () => string;

  private constructor(
    database: DatabaseSync,
    databasePath: string,
    options: CatalogRepositoryOptions = {},
  ) {
    this.database = database;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
    this.migrations = new CatalogMigrations(database, databasePath,
      options.backupsDirectory ?? path.join(path.dirname(databasePath), 'backups'), this.now, this.createId);
  }

  public static async open(
    databasePath: string,
    options: CatalogRepositoryOptions = {},
  ): Promise<NodeSqliteCatalogRepository> {
    let database: DatabaseSync | null = null;
    try {
      mkdirSync(path.dirname(databasePath), { recursive: true });
      database = new DatabaseSync(databasePath);
      database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
      const repository = new NodeSqliteCatalogRepository(database, databasePath, options);
      await repository.migrations.migrate();
      repository.migrations.checkIntegrity();
      return repository;
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the original open or migration error.
      }
      throw new PhotoMapError('INDEX_OPEN_FAILED', '无法打开本地照片索引。源照片未被修改。', {
        retryability: 'retry',
        scope: 'global',
        cause: error
      });
    }
  }

  public close(): void {
    this.database.close();
  }

  public activateSource(rootPath: string): SourceRecord {
    const rootKey = canonicalPathKey(rootPath);
    return this.writeTransaction(() => {
      const now = this.now();
      this.database.prepare('UPDATE library_source SET is_active = 0, updated_at = ? WHERE is_active = 1').run(now);
      const existing = this.database
        .prepare('SELECT source_id FROM library_source WHERE canonical_root_key = ?')
        .get(rootKey);
      const sourceId = existing === undefined ? this.createId() : stringValue(asRecord(existing), 'source_id');
      if (existing === undefined) {
        this.database
          .prepare(
            `INSERT INTO library_source
              (source_id, root_path, canonical_root_key, is_active, availability, created_at, updated_at)
             VALUES (?, ?, ?, 1, 'available', ?, ?)`
          )
          .run(sourceId, rootPath, rootKey, now, now);
      } else {
        this.database
          .prepare(
            `UPDATE library_source
             SET root_path = ?, is_active = 1, availability = 'available', updated_at = ?
             WHERE source_id = ?`
          )
          .run(rootPath, now, sourceId);
      }
      this.incrementRevision();
      return { sourceId, rootPath, canonicalRootKey: rootKey, availability: 'available' };
    });
  }

  public getActiveSource(): SourceRecord | null {
    const value = this.database
      .prepare(
        `SELECT source_id, root_path, canonical_root_key, availability
         FROM library_source WHERE is_active = 1 LIMIT 1`
      )
      .get();
    if (value === undefined) {
      return null;
    }
    const row = asRecord(value);
    return {
      sourceId: stringValue(row, 'source_id'),
      rootPath: stringValue(row, 'root_path'),
      canonicalRootKey: stringValue(row, 'canonical_root_key'),
      availability: stringValue(row, 'availability') as SourceRecord['availability']
    };
  }

  public markActiveSourceUnavailable(): void {
    this.writeTransaction(() => {
      this.database
        .prepare("UPDATE library_source SET availability = 'unavailable', updated_at = ? WHERE is_active = 1")
        .run(this.now());
      this.incrementRevision();
    });
  }

  public markActiveSourceAvailable(): void {
    this.writeTransaction(() => {
      const result = this.database
        .prepare(
          "UPDATE library_source SET availability = 'available', updated_at = ? WHERE is_active = 1 AND availability <> 'available'"
        )
        .run(this.now());
      if (result.changes > 0) {
        this.incrementRevision();
      }
    });
  }

  public startScanRun(sourceId: string): string {
    const runId = this.createId();
    this.writeTransaction(() => {
      this.database
        .prepare(
          `INSERT INTO scan_run
            (run_id, source_id, status, discovered_count, indexed_count, unchanged_count, error_count, started_at)
           VALUES (?, ?, 'running', 0, 0, 0, 0, ?)`
        )
        .run(runId, sourceId, this.now());
    });
    return runId;
  }

  public finishScanRun(runId: string, progress: ScanProgress): void {
    this.writeTransaction(() => {
      this.database
        .prepare(
          `UPDATE scan_run SET
             status = ?, discovered_count = ?, indexed_count = ?, unchanged_count = ?, error_count = ?, finished_at = ?
           WHERE run_id = ?`
        )
        .run(
          progress.status,
          progress.counts.discovered,
          progress.counts.indexed,
          progress.counts.unchanged,
          progress.counts.errors,
          this.now(),
          runId
        );
      this.database
        .prepare('UPDATE library_source SET last_scan_run_id = ?, updated_at = ? WHERE source_id = ?')
        .run(runId, this.now(), progress.sourceId);
    });
  }

  public getExistingPhotoFacts(sourceId: string): ExistingPhotoFact[] {
    return this.readPhotoRows(sourceId)
      .filter((row) => row.lifecycleState !== 'replaced')
      .map((row) => ({ ...row }));
  }

  public reconcileScan(
    sourceId: string,
    runId: string,
    files: ScannedFile[],
    complete: boolean
  ): ReconcileResult {
    return this.writeTransaction(() => {
      const { actions, changed } = planScanReconciliation(this.readPhotoIdentities(sourceId, files, complete), files, complete);
      for (const action of actions) {
        if (action.kind === 'update') {
          this.updatePhotoFromScan(action.photoId, runId, action.file);
        } else if (action.kind === 'replace') {
          this.database
            .prepare("UPDATE photo SET lifecycle_state = 'replaced', updated_at = ? WHERE photo_id = ?")
            .run(this.now(), action.photoId);
          this.insertPhoto(sourceId, runId, action.file);
        } else if (action.kind === 'insert') {
          this.insertPhoto(sourceId, runId, action.file);
        } else {
          this.database
            .prepare("UPDATE photo SET lifecycle_state = 'missing', updated_at = ? WHERE photo_id = ?")
            .run(this.now(), action.photoId);
        }
        if (action.kind === 'replace' || (action.kind === 'update' && action.file.contentSha256 !== null)) {
          // Replacements have a new identity; unknown hashes never use the scan
          // shortcut. For retained identities, clear only after a successful probe.
          this.database.prepare('DELETE FROM metadata WHERE key = ?')
            .run(`photo_rescan_required:${action.photoId}`);
        }
      }

      if (changed) {
        this.incrementRevision();
      }
      return { indexed: files.length, changed };
    });
  }

  public getLibrarySnapshot(progressOverride?: ScanProgress): LibrarySnapshot {
    const source = this.getActiveSource();
    const photoTypes = this.listPhotoTypes();
    if (source === null) {
      return {
        source: null,
        photos: [],
        photoTypes,
        scan: progressOverride ?? this.emptyProgress(),
        catalogRevision: this.getRevision()
      };
    }

    const photoRows = this.database
      .prepare(
        `SELECT photo_id, display_path, relative_path, file_created_at_ms,
                capture_time_local, capture_time_offset_minutes, capture_time_source,
                media_kind, media_format,
                pixel_width, pixel_height, decode_state, lifecycle_state, note
         FROM photo
         WHERE source_id = ? AND lifecycle_state = 'active'
         ORDER BY relative_path COLLATE NOCASE, photo_id`
      )
      .all(source.sourceId);
    const locationRows = this.database
      .prepare(
        `SELECT pa.photo_id, pa.province_gb, pa.city_gb
         FROM photo_place pa JOIN photo p ON p.photo_id = pa.photo_id
         WHERE p.source_id = ?`
      )
      .all(source.sourceId);
    const typeRows = this.database
      .prepare(
        `SELECT ptl.photo_id, ptl.type_id
         FROM photo_type_link ptl JOIN photo p ON p.photo_id = ptl.photo_id
         WHERE p.source_id = ? ORDER BY ptl.type_id`
      )
      .all(source.sourceId);

    const locations = new Map<string, LocationAssignment>();
    for (const value of locationRows) {
      const row = asRecord(value);
      const cityGb = nullableString(row, 'city_gb');
      locations.set(stringValue(row, 'photo_id'), {
        provinceGb: stringValue(row, 'province_gb'),
        ...(cityGb === null ? {} : { cityGb })
      });
    }
    const typeIds = new Map<string, string[]>();
    for (const value of typeRows) {
      const row = asRecord(value);
      const photoId = stringValue(row, 'photo_id');
      const current = typeIds.get(photoId) ?? [];
      current.push(stringValue(row, 'type_id'));
      typeIds.set(photoId, current);
    }

    const photos: PhotoSummary[] = photoRows.map((value) => {
      const row = asRecord(value);
      const photoId = stringValue(row, 'photo_id');
      return {
        photoId,
        fileName: path.basename(stringValue(row, 'display_path')),
        folderPath: folderPathFromRelativePath(stringValue(row, 'relative_path')) ?? null,
        mediaUrl: photoMediaUrl(photoId),
        thumbnailUrl: photoThumbnailUrl(photoId),
        fileCreatedAtMs: nullableNumber(row, 'file_created_at_ms'),
        captureTime: captureTimeFromRow(row),
        mediaKind: stringValue(row, 'media_kind') as MediaKind,
        mediaFormat: stringValue(row, 'media_format') as MediaFormat,
        pixelWidth: nullableNumber(row, 'pixel_width'),
        pixelHeight: nullableNumber(row, 'pixel_height'),
        decodeState: stringValue(row, 'decode_state') as DecodeState,
        lifecycleState: stringValue(row, 'lifecycle_state') as PhotoLifecycle,
        location: locations.get(photoId) ?? null,
        typeIds: typeIds.get(photoId) ?? [],
        note: stringValue(row, 'note')
      };
    });

    return {
      source: {
        sourceId: source.sourceId,
        displayName: path.basename(source.rootPath),
        availability: source.availability
      },
      photos,
      photoTypes,
      scan: progressOverride ?? this.getLatestProgress(source.sourceId),
      catalogRevision: this.getRevision()
    };
  }

  public updateLocations(
    photoIds: string[],
    location: LocationAssignment | null,
    origin: 'user_action'
  ): BulkUpdateResult {
    if (origin !== 'user_action') {
      throw new PhotoMapError('INVALID_REQUEST', '地点只能由用户手动标注。');
    }
    const counts = this.writeTransaction(() => {
      const activeIds = photoIds.filter((photoId) => this.isActivePhoto(photoId));
      const now = this.now();
      for (const photoId of activeIds) {
        if (location === null) {
          this.database.prepare('DELETE FROM photo_place WHERE photo_id = ?').run(photoId);
        } else {
          this.database
            .prepare(
              `INSERT INTO photo_place (photo_id, province_gb, city_gb, assigned_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(photo_id) DO UPDATE SET
                 province_gb = excluded.province_gb,
                 city_gb = excluded.city_gb,
                 assigned_at = excluded.assigned_at`
            )
            .run(photoId, location.provinceGb, location.cityGb ?? null, now);
        }
      }
      if (activeIds.length > 0) {
        this.incrementRevision();
      }
      return { succeeded: activeIds.length, skipped: photoIds.length - activeIds.length, failed: 0 };
    });
    return { ...counts, library: this.getLibrarySnapshot() };
  }

  public applySuggestedMetadata(
    sourceId: string,
    assignments: readonly { photoId: string; location: LocationAssignment }[],
    captureTimes: readonly { photoId: string; captureTime: CaptureTimeValue }[],
    decision: Exclude<ScanLocationDecision, 'ignore'>
  ): SuggestedMetadataApplyResult {
    if (decision !== 'overwrite-all-resolved' && decision !== 'fill-unlabeled-only') {
      throw new PhotoMapError('INVALID_REQUEST', '扫描元数据处理方式无效。');
    }
    const result = this.writeTransaction(() => {
      const latestAssignments = new Map<string, LocationAssignment>();
      for (const assignment of assignments) {
        latestAssignments.set(assignment.photoId, assignment.location);
      }

      const isEligible = this.database.prepare(
        `SELECT 1 FROM photo p JOIN library_source s ON s.source_id = p.source_id
         WHERE p.photo_id = ? AND p.source_id = ?
           AND p.lifecycle_state = 'active' AND s.is_active = 1
           ${decision === 'fill-unlabeled-only'
             ? 'AND NOT EXISTS (SELECT 1 FROM photo_place pp WHERE pp.photo_id = p.photo_id)'
             : ''}`
      );
      const upsert = this.database.prepare(
        `INSERT INTO photo_place (photo_id, province_gb, city_gb, assigned_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(photo_id) DO UPDATE SET
           province_gb = excluded.province_gb,
           city_gb = excluded.city_gb,
           assigned_at = excluded.assigned_at`
      );
      const now = this.now();
      let locationsSucceeded = 0;
      let locationsSkipped = 0;
      const candidatePhotoIds = new Set<string>();
      const succeededPhotoIds = new Set<string>();
      for (const [photoId, location] of latestAssignments) {
        candidatePhotoIds.add(photoId);
        if (isEligible.get(photoId, sourceId) === undefined) {
          locationsSkipped += 1;
          continue;
        }
        upsert.run(photoId, location.provinceGb, location.cityGb ?? null, now);
        locationsSucceeded += 1;
        succeededPhotoIds.add(photoId);
      }

      const latestCaptureTimes = new Map<string, CaptureTimeValue>();
      for (const assignment of captureTimes) {
        latestCaptureTimes.set(assignment.photoId, assignment.captureTime);
      }
      const isCaptureTimeEligible = this.database.prepare(
        `SELECT 1 FROM photo p JOIN library_source s ON s.source_id = p.source_id
         WHERE p.photo_id = ? AND p.source_id = ?
           AND p.lifecycle_state = 'active' AND s.is_active = 1
           AND (p.capture_time_source IS NULL OR p.capture_time_source <> 'user')
           ${decision === 'fill-unlabeled-only' ? 'AND p.capture_time_local IS NULL' : ''}`
      );
      const updateCaptureTime = this.database.prepare(
        `UPDATE photo
         SET capture_time_local = ?, capture_time_offset_minutes = ?,
             capture_time_source = 'metadata', updated_at = ?
         WHERE photo_id = ?`
      );
      let captureTimesSucceeded = 0;
      let captureTimesSkipped = 0;
      for (const [photoId, captureTime] of latestCaptureTimes) {
        candidatePhotoIds.add(photoId);
        if (isCaptureTimeEligible.get(photoId, sourceId) === undefined) {
          captureTimesSkipped += 1;
          continue;
        }
        updateCaptureTime.run(
          captureTime.localDateTime,
          captureTime.offsetMinutes,
          now,
          photoId,
        );
        captureTimesSucceeded += 1;
        succeededPhotoIds.add(photoId);
      }
      if (succeededPhotoIds.size > 0) {
        this.incrementRevision();
      }
      return {
        succeeded: succeededPhotoIds.size,
        skipped: candidatePhotoIds.size - succeededPhotoIds.size,
        failed: 0,
        locations: {
          succeeded: locationsSucceeded,
          skipped: locationsSkipped,
          failed: 0,
        },
        captureTimes: {
          succeeded: captureTimesSucceeded,
          skipped: captureTimesSkipped,
          failed: 0,
        },
      };
    });
    return { ...result, library: this.getLibrarySnapshot() };
  }

  public updateTypes(request: UpdateTypesRequest): BulkUpdateResult {
    const counts = this.writeTransaction(() => {
      const allTypeIds = [...request.addTypeIds, ...request.removeTypeIds];
      for (const typeId of allTypeIds) {
        const exists = this.database.prepare('SELECT 1 FROM photo_type WHERE type_id = ?').get(typeId);
        if (exists === undefined) {
          throw new PhotoMapError('INVALID_REQUEST', '选择的标签已不存在。');
        }
      }
      const activeIds = request.photoIds.filter((photoId) => this.isActivePhoto(photoId));
      for (const photoId of activeIds) {
        for (const typeId of request.addTypeIds) {
          this.database
            .prepare('INSERT OR IGNORE INTO photo_type_link (photo_id, type_id, assigned_at) VALUES (?, ?, ?)')
            .run(photoId, typeId, this.now());
        }
        for (const typeId of request.removeTypeIds) {
          this.database
            .prepare('DELETE FROM photo_type_link WHERE photo_id = ? AND type_id = ?')
            .run(photoId, typeId);
        }
      }
      if (activeIds.length > 0) {
        this.incrementRevision();
      }
      return {
        succeeded: activeIds.length,
        skipped: request.photoIds.length - activeIds.length,
        failed: 0
      };
    });
    return { ...counts, library: this.getLibrarySnapshot() };
  }

  public updateNote(photoId: string, note: string): BulkUpdateResult {
    const counts = this.writeTransaction(() => {
      const result = this.database
        .prepare(
          `UPDATE photo SET note = ?, updated_at = ?
           WHERE photo_id = ? AND lifecycle_state = 'active'
             AND source_id IN (SELECT source_id FROM library_source WHERE is_active = 1)`
        )
        .run(note, this.now(), photoId);
      const succeeded = Number(result.changes);
      if (succeeded > 0) {
        this.incrementRevision();
      }
      return { succeeded, skipped: succeeded === 0 ? 1 : 0, failed: 0 };
    });
    return { ...counts, library: this.getLibrarySnapshot() };
  }

  public updateCaptureTime(photoId: string, localDateTime: string): BulkUpdateResult {
    const counts = this.writeTransaction(() => {
      const result = this.database
        .prepare(
          `UPDATE photo
           SET capture_time_local = ?, capture_time_offset_minutes = NULL,
               capture_time_source = 'user', updated_at = ?
           WHERE photo_id = ? AND lifecycle_state = 'active'
             AND source_id IN (SELECT source_id FROM library_source WHERE is_active = 1)`
        )
        .run(localDateTime, this.now(), photoId);
      const succeeded = Number(result.changes);
      if (succeeded > 0) this.incrementRevision();
      return { succeeded, skipped: succeeded === 0 ? 1 : 0, failed: 0 };
    });
    return { ...counts, library: this.getLibrarySnapshot() };
  }

  public updatePhotoPathsAfterRename(
    photoId: string,
    expectedAbsolutePath: string,
    absolutePath: string,
    expectedCompanionAbsolutePath: string | null,
    companionAbsolutePath: string | null,
  ): boolean {
    return this.writeTransaction(() => {
      const value = this.database
        .prepare(
          `SELECT p.photo_id, p.display_path, s.root_path, pc.display_path AS companion_display_path
           FROM photo p
           JOIN library_source s ON s.source_id = p.source_id
           LEFT JOIN photo_companion pc ON pc.photo_id = p.photo_id
           WHERE p.photo_id = ? AND p.lifecycle_state = 'active' AND s.is_active = 1`,
        )
        .get(photoId);
      if (value === undefined) {
        return false;
      }

      const row = asRecord(value);
      const rootPath = stringValue(row, 'root_path');
      const indexedAbsolutePath = stringValue(row, 'display_path');
      const indexedCompanionPath = nullableString(row, 'companion_display_path');
      if (
        indexedAbsolutePath !== expectedAbsolutePath
        || indexedCompanionPath !== expectedCompanionAbsolutePath
      ) {
        return false;
      }
      if (
        !isPathWithin(rootPath, absolutePath)
        || (companionAbsolutePath !== null && !isPathWithin(rootPath, companionAbsolutePath))
      ) {
        throw new PhotoMapError('INVALID_REQUEST', '只能在当前照片文件夹内重命名媒体文件。');
      }
      if ((indexedCompanionPath === null) !== (companionAbsolutePath === null)) {
        throw new PhotoMapError('INDEX_WRITE_FAILED', '实况照片索引已变化，请刷新照片文件夹后重试。', {
          retryability: 'retry',
          scope: 'item',
          affectedIds: [photoId],
        });
      }

      const now = this.now();
      const result = this.database
        .prepare(
          `UPDATE photo SET display_path = ?, relative_path = ?, canonical_path_key = ?, updated_at = ?
           WHERE photo_id = ? AND display_path = ? AND lifecycle_state = 'active'`,
        )
        .run(
          absolutePath,
          path.relative(rootPath, absolutePath),
          canonicalPathKey(absolutePath),
          now,
          photoId,
          expectedAbsolutePath,
        );
      if (Number(result.changes) !== 1) {
        return false;
      }

      if (companionAbsolutePath !== null) {
        const companionResult = this.database
          .prepare(
            `UPDATE photo_companion
             SET display_path = ?, relative_path = ?, canonical_path_key = ?, updated_at = ?
             WHERE photo_id = ?`,
          )
          .run(
            companionAbsolutePath,
            path.relative(rootPath, companionAbsolutePath),
            canonicalPathKey(companionAbsolutePath),
            now,
            photoId,
          );
        if (Number(companionResult.changes) !== 1) {
          throw new PhotoMapError('INDEX_WRITE_FAILED', '无法同步实况照片的伴随视频索引。', {
            retryability: 'retry',
            scope: 'item',
            affectedIds: [photoId],
          });
        }
      }

      this.incrementRevision();
      return true;
    });
  }

  public createPhotoType(name: string): PhotoType {
    const displayName = name.trim().normalize('NFKC');
    const normalizedName = displayName.toLocaleLowerCase('zh-CN');
    try {
      return this.writeTransaction(() => {
        const typeId = this.createId();
        const now = this.now();
        this.database
          .prepare(
            `INSERT INTO photo_type (type_id, name, normalized_name, is_builtin, created_at, updated_at)
             VALUES (?, ?, ?, 0, ?, ?)`
          )
          .run(typeId, displayName, normalizedName, now, now);
        this.incrementRevision();
        return { typeId, name: displayName, isBuiltin: false };
      });
    } catch (error) {
      if (error instanceof PhotoMapError && error.code === 'INDEX_WRITE_FAILED') {
        const causeMessage = error.cause instanceof Error ? error.cause.message : '';
        if (causeMessage.includes('UNIQUE')) {
          throw new PhotoMapError('INVALID_REQUEST', '已存在同名标签。');
        }
      }
      throw error;
    }
  }

  public getPhotoFileRecords(photoIds: string[]): PhotoFileRecord[] {
    const records: PhotoFileRecord[] = [];
    const statement = this.database.prepare(
      `SELECT p.photo_id, p.display_path, p.lifecycle_state, p.content_sha256,
              p.file_size, p.modified_at_ms, p.file_created_at_ms, p.media_kind, p.media_format, s.root_path,
              pc.display_path AS companion_display_path, pc.file_size AS companion_file_size,
              pc.modified_at_ms AS companion_modified_at_ms,
              pc.file_created_at_ms AS companion_file_created_at_ms,
              pc.content_sha256 AS companion_content_sha256
       FROM photo p JOIN library_source s ON s.source_id = p.source_id
       LEFT JOIN photo_companion pc ON pc.photo_id = p.photo_id
       WHERE p.photo_id = ? AND s.is_active = 1`
    );
    for (const photoId of photoIds) {
      const value = statement.get(photoId);
      if (value === undefined) {
        continue;
      }
      const row = asRecord(value);
      records.push({
        photoId: stringValue(row, 'photo_id'),
        absolutePath: stringValue(row, 'display_path'),
        rootPath: stringValue(row, 'root_path'),
        lifecycleState: stringValue(row, 'lifecycle_state') as PhotoLifecycle,
        contentSha256: nullableString(row, 'content_sha256'),
        fileSize: Number(row.file_size),
        modifiedAtMs: Number(row.modified_at_ms),
        fileCreatedAtMs: nullableNumber(row, 'file_created_at_ms'),
        mediaKind: stringValue(row, 'media_kind') as MediaKind,
        mediaFormat: stringValue(row, 'media_format') as MediaFormat,
        companionAbsolutePath: nullableString(row, 'companion_display_path'),
        companionFileSize: nullableNumber(row, 'companion_file_size'),
        companionModifiedAtMs: nullableNumber(row, 'companion_modified_at_ms'),
        companionFileCreatedAtMs: nullableNumber(row, 'companion_file_created_at_ms'),
        companionContentSha256: nullableString(row, 'companion_content_sha256')
      });
    }
    return records;
  }

  public markTrashPending(photoId: string): boolean {
    return this.writeTransaction(() => {
      const result = this.database
        .prepare("UPDATE photo SET lifecycle_state = 'trash_pending', updated_at = ? WHERE photo_id = ? AND lifecycle_state IN ('active', 'trash_pending')")
        .run(this.now(), photoId);
      return Number(result.changes) === 1;
    });
  }

  public invalidatePhotoForRescan(photoId: string): void {
    this.writeTransaction(() => {
      // Keep the indexed fingerprints as historical identity evidence. This
      // per-item hint only disables the next scan's size/mtime shortcut.
      this.database.prepare(
        `INSERT INTO metadata (key, value) SELECT ?, '1' FROM photo
         WHERE photo_id = ? AND lifecycle_state IN ('active', 'trash_pending')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(`photo_rescan_required:${photoId}`, photoId);
    });
  }

  public markTrashCompanionMoved(photoId: string, expectedAbsolutePath: string): void {
    this.writeTransaction(() => {
      const result = this.database.prepare(
        `DELETE FROM photo_companion WHERE photo_id = ? AND display_path = ?
         AND EXISTS (SELECT 1 FROM photo WHERE photo_id = ? AND lifecycle_state = 'trash_pending')`
      ).run(photoId, expectedAbsolutePath, photoId);
      if (Number(result.changes) !== 1) {
        throw new Error('The Live Photo companion changed before recycle-bin settlement.');
      }
      // Persist each confirmed filesystem change before attempting the next file.
      // Existing schema versions already support a photo without a companion.
      this.database.prepare("UPDATE photo SET media_kind = 'photo', updated_at = ? WHERE photo_id = ?")
        .run(this.now(), photoId);
      this.incrementRevision();
    });
  }

  public settleTrashItem(photoId: string, status: TrashItemStatus): void {
    this.writeTransaction(() => {
      this.database
        .prepare(
          `UPDATE photo SET lifecycle_state = ?, updated_at = ?
           WHERE photo_id = ? AND lifecycle_state = 'trash_pending'`
        )
        .run(status === 'moved' ? 'trashed' : 'active', this.now(), photoId);
      if (status === 'moved') {
        this.database.prepare('DELETE FROM metadata WHERE key = ?').run(`photo_rescan_required:${photoId}`);
      }
      this.incrementRevision();
    });
  }

  public getMediaRecord(photoId: string): PhotoFileRecord | null {
    const records = this.getPhotoFileRecords([photoId]);
    const record = records[0];
    return record?.lifecycleState === 'active' ? record : null;
  }

  private readPhotoIdentities(
    sourceId: string,
    files: readonly ScannedFile[],
    complete: boolean,
  ): Pick<ExistingPhotoFact, 'photoId' | 'canonicalPathKey' | 'contentSha256' | 'lifecycleState'>[] {
    let filter = '';
    const parameters = [sourceId];
    if (!complete && files.length <= MAX_PARTIAL_RECONCILE_FILES) {
      if (files.length === 0) return [];
      const paths = [...new Set(files.map((file) => file.canonicalPathKey))];
      const hashes = [...new Set(files.flatMap((file) => file.contentSha256 === null ? [] : [file.contentSha256]))];
      // Partial scans preserve unseen photos and only recover moves from missing identities.
      // Include every same-path history row so replacements and restored trash retain their semantics.
      const matches = [`canonical_path_key IN (${paths.map(() => '?').join(', ')})`];
      parameters.push(...paths);
      if (hashes.length > 0) {
        matches.push(`(lifecycle_state = 'missing' AND content_sha256 IN (${hashes.map(() => '?').join(', ')}))`);
        parameters.push(...hashes);
      }
      filter = ` AND (${matches.join(' OR ')})`;
    }
    return this.database
      .prepare(
        `SELECT photo_id, canonical_path_key, content_sha256, lifecycle_state
         FROM photo WHERE source_id = ?${filter} ORDER BY updated_at DESC`
      )
      .all(...parameters)
      .map((value) => {
        const row = asRecord(value);
        return {
          photoId: stringValue(row, 'photo_id'),
          canonicalPathKey: stringValue(row, 'canonical_path_key'),
          contentSha256: nullableString(row, 'content_sha256'),
          lifecycleState: stringValue(row, 'lifecycle_state') as PhotoLifecycle,
        };
      });
  }

  private readPhotoRows(sourceId: string): PhotoRow[] {
    return this.database
      .prepare(
        `SELECT p.photo_id, p.source_id, p.display_path, p.relative_path, p.canonical_path_key,
                p.file_size, p.modified_at_ms, p.file_created_at_ms, p.content_sha256,
                p.media_kind, p.media_format, p.pixel_width, p.pixel_height, p.decode_state,
                p.lifecycle_state, p.note,
                EXISTS (SELECT 1 FROM metadata m
                        WHERE m.key = 'photo_rescan_required:' || p.photo_id AND m.value = '1') AS needs_rescan,
                pc.display_path AS companion_display_path,
                pc.relative_path AS companion_relative_path,
                pc.canonical_path_key AS companion_canonical_path_key,
                pc.file_size AS companion_file_size,
                pc.modified_at_ms AS companion_modified_at_ms,
                pc.file_created_at_ms AS companion_file_created_at_ms,
                pc.content_sha256 AS companion_content_sha256,
                pc.media_format AS companion_media_format
         FROM photo p LEFT JOIN photo_companion pc ON pc.photo_id = p.photo_id
         WHERE p.source_id = ? ORDER BY p.updated_at DESC`
      )
      .all(sourceId)
      .map((value) => {
        const row = asRecord(value);
        const companionAbsolutePath = nullableString(row, 'companion_display_path');
        return {
          photoId: stringValue(row, 'photo_id'),
          sourceId: stringValue(row, 'source_id'),
          absolutePath: stringValue(row, 'display_path'),
          relativePath: stringValue(row, 'relative_path'),
          canonicalPathKey: stringValue(row, 'canonical_path_key'),
          fileSize: Number(row.file_size),
          modifiedAtMs: Number(row.modified_at_ms),
          fileCreatedAtMs: nullableNumber(row, 'file_created_at_ms'),
          contentSha256: nullableString(row, 'content_sha256'),
          mediaKind: stringValue(row, 'media_kind') as MediaKind,
          mediaFormat: stringValue(row, 'media_format') as MediaFormat,
          pixelWidth: nullableNumber(row, 'pixel_width'),
          pixelHeight: nullableNumber(row, 'pixel_height'),
          decodeState: stringValue(row, 'decode_state') as DecodeState,
          lifecycleState: stringValue(row, 'lifecycle_state') as PhotoLifecycle,
          needsRescan: Number(row.needs_rescan) === 1,
          note: stringValue(row, 'note'),
          companion: companionAbsolutePath === null
            ? null
            : {
                absolutePath: companionAbsolutePath,
                relativePath: stringValue(row, 'companion_relative_path'),
                canonicalPathKey: stringValue(row, 'companion_canonical_path_key'),
                fileSize: Number(row.companion_file_size),
                modifiedAtMs: Number(row.companion_modified_at_ms),
                fileCreatedAtMs: nullableNumber(row, 'companion_file_created_at_ms'),
                contentSha256: nullableString(row, 'companion_content_sha256'),
                mediaFormat: stringValue(row, 'companion_media_format') as MediaFormat,
              },
        };
      });
  }

  private insertPhoto(sourceId: string, runId: string, file: ScannedFile): string {
    const photoId = this.createId();
    const now = this.now();
    this.database
      .prepare(
        `INSERT INTO photo (
           photo_id, source_id, display_path, relative_path, canonical_path_key,
           file_size, modified_at_ms, file_created_at_ms, content_sha256, image_format,
           media_kind, media_format, pixel_width, pixel_height, decode_state,
           lifecycle_state, last_seen_scan_run_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(
        photoId,
        sourceId,
        file.absolutePath,
        file.relativePath,
        file.canonicalPathKey,
        file.fileSize,
        file.modifiedAtMs,
        file.fileCreatedAtMs,
        file.contentSha256,
        this.legacyImageFormat(file.mediaFormat),
        file.mediaKind,
        file.mediaFormat,
        file.pixelWidth,
        file.pixelHeight,
        file.decodeState,
        runId,
        now,
        now
      );
    this.syncCompanion(photoId, file);
    return photoId;
  }

  private updatePhotoFromScan(photoId: string, runId: string, file: ScannedFile): void {
    this.database
      .prepare(
        `UPDATE photo SET
           display_path = ?, relative_path = ?, canonical_path_key = ?, file_size = ?, modified_at_ms = ?, file_created_at_ms = ?,
           content_sha256 = ?, image_format = ?, media_kind = ?, media_format = ?,
           pixel_width = ?, pixel_height = ?, decode_state = ?,
           lifecycle_state = 'active', last_seen_scan_run_id = ?, updated_at = ?
         WHERE photo_id = ?`
      )
      .run(
        file.absolutePath,
        file.relativePath,
        file.canonicalPathKey,
        file.fileSize,
        file.modifiedAtMs,
        file.fileCreatedAtMs,
        file.contentSha256,
        this.legacyImageFormat(file.mediaFormat),
        file.mediaKind,
        file.mediaFormat,
        file.pixelWidth,
        file.pixelHeight,
        file.decodeState,
        runId,
        this.now(),
        photoId
      );
    this.syncCompanion(photoId, file);
  }

  private syncCompanion(photoId: string, file: ScannedFile): void {
    if (file.companion === undefined) {
      this.database.prepare('DELETE FROM photo_companion WHERE photo_id = ?').run(photoId);
      return;
    }
    const companion = file.companion;
    const now = this.now();
    this.database
      .prepare(
        `INSERT INTO photo_companion (
           photo_id, display_path, relative_path, canonical_path_key, file_size, modified_at_ms,
           file_created_at_ms, content_sha256, media_format, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(photo_id) DO UPDATE SET
           display_path = excluded.display_path,
           relative_path = excluded.relative_path,
           canonical_path_key = excluded.canonical_path_key,
           file_size = excluded.file_size,
           modified_at_ms = excluded.modified_at_ms,
           file_created_at_ms = excluded.file_created_at_ms,
           content_sha256 = excluded.content_sha256,
           media_format = excluded.media_format,
           updated_at = excluded.updated_at`
      )
      .run(
        photoId,
        companion.absolutePath,
        companion.relativePath,
        companion.canonicalPathKey,
        companion.fileSize,
        companion.modifiedAtMs,
        companion.fileCreatedAtMs,
        companion.contentSha256,
        companion.mediaFormat,
        now,
        now,
      );
  }

  private legacyImageFormat(mediaFormat: MediaFormat): ImageFormat {
    return mediaFormat === 'png' ? 'png' : 'jpg';
  }

  private isActivePhoto(photoId: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM photo p JOIN library_source s ON s.source_id = p.source_id
           WHERE p.photo_id = ? AND p.lifecycle_state = 'active' AND s.is_active = 1`
        )
        .get(photoId) !== undefined
    );
  }

  private listPhotoTypes(): PhotoType[] {
    return this.database
      .prepare('SELECT type_id, name, is_builtin FROM photo_type ORDER BY is_builtin DESC, name COLLATE NOCASE')
      .all()
      .map((value) => {
        const row = asRecord(value);
        return {
          typeId: stringValue(row, 'type_id'),
          name: stringValue(row, 'name'),
          isBuiltin: Number(row.is_builtin) === 1
        };
      });
  }

  private getLatestProgress(sourceId: string): ScanProgress {
    const value = this.database
      .prepare(
        `SELECT run_id, status, discovered_count, indexed_count, unchanged_count, error_count
         FROM scan_run WHERE source_id = ? ORDER BY started_at DESC LIMIT 1`
      )
      .get(sourceId);
    if (value === undefined) {
      return { ...this.emptyProgress(), sourceId };
    }
    const row = asRecord(value);
    return {
      runId: stringValue(row, 'run_id'),
      sourceId,
      status: stringValue(row, 'status') as ScanProgress['status'],
      counts: {
        discovered: Number(row.discovered_count),
        indexed: Number(row.indexed_count),
        unchanged: Number(row.unchanged_count),
        errors: Number(row.error_count)
      }
    };
  }

  private emptyProgress(): ScanProgress {
    return {
      runId: null,
      sourceId: null,
      status: 'idle',
      counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 }
    };
  }

  private getRevision(): number {
    const value = this.database.prepare("SELECT value FROM metadata WHERE key = 'catalog_revision'").get();
    return value === undefined ? 0 : Number(asRecord(value).value);
  }

  private incrementRevision(): void {
    this.database
      .prepare("UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'catalog_revision'")
      .run();
  }

  private writeTransaction<T>(action: () => T): T {
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Keep the original database error.
      }
      if (error instanceof PhotoMapError) {
        throw error;
      }
      throw new PhotoMapError('INDEX_WRITE_FAILED', '无法保存本地索引，本次更改已撤销。', {
        retryability: 'retry',
        scope: 'task',
        cause: error
      });
    }
  }
}
