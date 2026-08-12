import { nativeImage, } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readdir, stat, realpath, mkdir, writeFile, } from 'node:fs/promises';
import path from 'node:path';
import type { PhotoMapPaths } from './bootstrap/app-paths';
import type { LibrarySnapshot, PhotoSummary, ScanProgress, } from '../shared/contracts';
import { photoMediaUrl, photoThumbnailUrl } from '../shared/media-url';
import { PhotoMapError } from '../shared/errors';


type Row = Record<string, unknown>;
export class PhotoLibrary {
  private readonly database: DatabaseSync;
  private cancelled = false;
  private scanning = false;
  private progress: ScanProgress = { runId: null, sourceId: null, status: 'idle', counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 } };
  
  constructor(private readonly paths: PhotoMapPaths, private readonly publish: (progress: ScanProgress) => void) {
    this.database = new DatabaseSync(paths.databasePath);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    const version = Number((this.database.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version === 0) {
      this.database.exec(`BEGIN;
CREATE TABLE library_source (
          source_id TEXT PRIMARY KEY,
          root_path TEXT NOT NULL,
          canonical_root_key TEXT NOT NULL UNIQUE,
          is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
          availability TEXT NOT NULL CHECK (availability IN ('unknown', 'available', 'unavailable')),
          last_scan_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX one_active_library_source ON library_source(is_active) WHERE is_active = 1;

        CREATE TABLE photo (
          photo_id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES library_source(source_id),
          display_path TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          canonical_path_key TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          modified_at_ms REAL NOT NULL,
          file_created_at_ms REAL,
          content_sha256 TEXT,
          image_format TEXT NOT NULL CHECK (image_format IN ('png', 'jpg')),
          pixel_width INTEGER,
          pixel_height INTEGER,
          decode_state TEXT NOT NULL CHECK (decode_state IN ('unknown', 'valid', 'corrupt', 'unreadable', 'unsupported')),
          lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'missing', 'trash_pending', 'trashed', 'replaced')),
          last_seen_scan_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX one_current_photo_per_path
          ON photo(source_id, canonical_path_key)
          WHERE lifecycle_state IN ('active', 'missing', 'trash_pending');
        CREATE INDEX photo_by_source_hash ON photo(source_id, content_sha256);



        CREATE TABLE photo_place (
          photo_id TEXT PRIMARY KEY REFERENCES photo(photo_id) ON DELETE CASCADE,
          province_gb TEXT NOT NULL,
          city_gb TEXT,
          assigned_at TEXT NOT NULL
        );

        CREATE TABLE photo_type (
          type_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE,
          is_builtin INTEGER NOT NULL CHECK (is_builtin IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE photo_type_link (
          photo_id TEXT NOT NULL REFERENCES photo(photo_id) ON DELETE CASCADE,
          type_id TEXT NOT NULL REFERENCES photo_type(type_id) ON DELETE RESTRICT,
          assigned_at TEXT NOT NULL,
          PRIMARY KEY (photo_id, type_id)
        );

        CREATE TABLE scan_run (
          run_id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES library_source(source_id),
          status TEXT NOT NULL,
          discovered_count INTEGER NOT NULL,
          indexed_count INTEGER NOT NULL,
          unchanged_count INTEGER NOT NULL,
          error_count INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT
        );

        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO metadata(key, value) VALUES ('catalog_revision', '0');
      
PRAGMA user_version = 2; COMMIT;`);
      const now = new Date().toISOString();
      this.database.prepare('INSERT INTO photo_type(type_id,name,normalized_name,is_builtin,created_at,updated_at) VALUES(?,?,?,1,?,?),(?,?,?,1,?,?)').run('builtin-portrait','人像','人像',now,now,'builtin-landscape','风景','风景',now,now);
    }
    
  }
  close(): void { this.cancelled = true; this.database.close(); }
  getSource(): Row | undefined { return this.database.prepare('SELECT * FROM library_source WHERE is_active = 1').get() as Row | undefined; }
  snapshot(): LibrarySnapshot {
    const source = this.getSource();
    const rows = source ? this.database.prepare("SELECT * FROM photo WHERE source_id = ? AND lifecycle_state IN ('active', 'missing') ORDER BY relative_path").all(String(source.source_id)) as Row[] : [];
    return {
      source: source ? { sourceId: String(source.source_id), displayName: path.basename(String(source.root_path)), availability: source.availability as 'available' | 'unavailable' | 'unknown' } : null,
      photos: rows.map((row): PhotoSummary => {
        const photoId = String(row.photo_id);
        
        return { photoId, fileName: path.basename(String(row.display_path)), folderPath: path.dirname(String(row.relative_path)), mediaUrl: photoMediaUrl(photoId), thumbnailUrl: photoThumbnailUrl(photoId), fileCreatedAtMs: row.file_created_at_ms === null ? null : Number(row.file_created_at_ms), captureTime: null, mediaKind: 'photo', mediaFormat: row.image_format as PhotoSummary['mediaFormat'], pixelWidth: row.pixel_width === null ? null : Number(row.pixel_width), pixelHeight: row.pixel_height === null ? null : Number(row.pixel_height), decodeState: row.decode_state as PhotoSummary['decodeState'], lifecycleState: row.lifecycle_state as PhotoSummary['lifecycleState'], location: null, typeIds: [], note: '' };
      }),
      photoTypes: [],
      scan: this.progress,
      catalogRevision: Number((this.database.prepare("SELECT value FROM metadata WHERE key = 'catalog_revision'").get() as Row).value),
    };
  }
  private revision(): void { this.database.exec("UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'catalog_revision'"); }
  async activate(root: string): Promise<LibrarySnapshot> {
    if (this.scanning) throw new PhotoMapError('SCAN_FAILED', '请等待扫描结束。');
    const rootPath = await realpath(root);
    if (!(await stat(rootPath)).isDirectory()) throw new PhotoMapError('SOURCE_NOT_FOUND', '请选择照片文件夹。');
    const key = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath;
    let source = this.database.prepare('SELECT * FROM library_source WHERE canonical_root_key = ?').get(key) as Row | undefined;
    const now = new Date().toISOString();
    this.database.exec('BEGIN');
    try {
      this.database.exec('UPDATE library_source SET is_active = 0');
      if (source) this.database.prepare("UPDATE library_source SET is_active = 1, availability = 'available', updated_at = ? WHERE source_id = ?").run(now, String(source.source_id));
      else {
        source = { source_id: randomUUID() };
        this.database.prepare("INSERT INTO library_source(source_id,root_path,canonical_root_key,is_active,availability,created_at,updated_at) VALUES(?,?,?,1,'available',?,?)").run(String(source.source_id),rootPath,key,now,now);
      }
      this.revision();this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK');throw error; }
    void this.scan().catch(() => undefined);
    return this.snapshot();
  }
  cancel(): { cancelled: boolean; library: LibrarySnapshot } { const cancelled = this.scanning; this.cancelled = true; return { cancelled, library: this.snapshot() }; }
  async scan(): Promise<{ library: LibrarySnapshot }> {
    if (this.scanning) throw new PhotoMapError('SCAN_FAILED', '照片扫描正在进行。');
    const source = this.getSource();
    if (!source) throw new PhotoMapError('SOURCE_NOT_FOUND', '请先选择照片文件夹。');
    this.scanning = true; this.cancelled = false;
    const sourceId = String(source.source_id), rootPath = String(source.root_path), runId = randomUUID();
    this.progress = { runId, sourceId, status: 'running', counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 } };
    
    this.database.prepare("INSERT INTO scan_run(run_id,source_id,status,discovered_count,indexed_count,unchanged_count,error_count,started_at) VALUES(?,?,'running',0,0,0,0,?)").run(runId,sourceId,new Date().toISOString());
    this.publish(this.progress);
    const walk = async (directory: string): Promise<void> => {
      const items = await readdir(directory, { withFileTypes: true });
      for (const item of items) {
        if (this.cancelled) break;
        const absolutePath = path.join(directory,item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) { try { await walk(absolutePath); } catch { this.progress.counts.errors++; } continue; }
        const extension = path.extname(item.name).slice(1).toLowerCase();
        if (!item.isFile() || !['jpg','jpeg','png'].includes(extension)) continue;
        
        this.progress.counts.discovered++;
        this.progress.currentFileName = item.name;
        try {
          const facts = await stat(absolutePath), relativePath = path.relative(rootPath,absolutePath);
          const key = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
          const existing = this.database.prepare("SELECT * FROM photo WHERE source_id = ? AND canonical_path_key = ? AND lifecycle_state IN ('active','missing')").get(sourceId,key) as Row | undefined;
          const photoId = existing ? String(existing.photo_id) : randomUUID();
          if (existing && Number(existing.file_size) === facts.size && Number(existing.modified_at_ms) === facts.mtimeMs) {
            this.database.prepare("UPDATE photo SET lifecycle_state = 'active', last_seen_scan_run_id = ? WHERE photo_id = ?").run(runId,photoId);
            this.progress.counts.unchanged++;
          } else {
            let image = nativeImage.createEmpty();
            try {
              image = nativeImage.createFromPath(absolutePath);
              if (image.isEmpty()) image = await nativeImage.createThumbnailFromPath(absolutePath,{ width: 512,height: 512 });
            } catch { /* Retain an indexed error entry when decoding fails. */ }
            const size = image.getSize(), decode = image.isEmpty() ? 'corrupt' : 'valid';
            if (decode === 'corrupt') this.progress.counts.errors++;
            const now = new Date().toISOString(), format = extension === 'png' ? 'png' : 'jpg';
            if (existing) this.database.prepare("UPDATE photo SET file_size = ?,modified_at_ms = ?,pixel_width = ?,pixel_height = ?,decode_state = ?,lifecycle_state = 'active',last_seen_scan_run_id = ?,updated_at = ? WHERE photo_id = ?").run(facts.size,facts.mtimeMs,size.width,size.height,decode,runId,now,photoId);
            else this.database.prepare("INSERT INTO photo(photo_id,source_id,display_path,relative_path,canonical_path_key,file_size,modified_at_ms,file_created_at_ms,image_format,pixel_width,pixel_height,decode_state,lifecycle_state,last_seen_scan_run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)").run(photoId,sourceId,absolutePath,relativePath,key,facts.size,facts.mtimeMs,facts.birthtimeMs || null,format,size.width,size.height,decode,runId,now,now);
            if (!image.isEmpty()) { await mkdir(this.paths.thumbnailRoot,{recursive:true}); await writeFile(path.join(this.paths.thumbnailRoot,photoId+'.png'),image.resize({width:320}).toPNG()); }
            this.progress.counts.indexed++;
            this.revision();
          }
          
          
        } catch {
          this.progress.counts.errors++;
        }
        this.publish({ ...this.progress,counts:{...this.progress.counts} });
      }
    };
    try {
      await walk(rootPath);
      this.progress.status = this.cancelled ? 'cancelled' : this.progress.counts.errors ? 'partial' : 'succeeded';
      if (!this.cancelled && this.progress.counts.errors === 0) this.database.prepare("UPDATE photo SET lifecycle_state = 'missing' WHERE source_id = ? AND last_seen_scan_run_id <> ? AND lifecycle_state = 'active'").run(sourceId,runId);
    } catch {
      this.progress.status = 'failed';this.progress.counts.errors++;
      this.database.prepare("UPDATE library_source SET availability = 'unavailable' WHERE source_id = ?").run(sourceId);
    } finally {
      this.scanning = false;
      this.database.prepare('UPDATE scan_run SET status=?,discovered_count=?,indexed_count=?,unchanged_count=?,error_count=?,finished_at=? WHERE run_id=?').run(this.progress.status,this.progress.counts.discovered,this.progress.counts.indexed,this.progress.counts.unchanged,this.progress.counts.errors,new Date().toISOString(),runId);
      this.database.prepare('UPDATE library_source SET last_scan_run_id = ? WHERE source_id = ?').run(runId,sourceId);
      this.revision();this.publish(this.progress);
    }
    return {library:this.snapshot()};
  }
  mediaPath(photoId: string,thumbnail: boolean,playback: boolean): string | undefined {
    const row = this.database.prepare("SELECT * FROM photo WHERE photo_id = ? AND lifecycle_state = 'active'").get(photoId) as Row | undefined;
    if (!row) return undefined;
    void playback;
    return thumbnail ? path.join(this.paths.thumbnailRoot,photoId+'.png') : String(row.display_path);
  }
  
}
