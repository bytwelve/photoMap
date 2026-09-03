import { mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { CATALOG_SCHEMA_VERSION, CATALOG_V1_COLUMNS, CATALOG_V4_COLUMNS, CATALOG_V5_COLUMNS, CATALOG_REQUIRED_INDEXES } from './catalog-schema';
import { asRecord } from './row-mapping';

export class CatalogMigrations {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly databasePath: string,
    private readonly backupsDirectory: string,
    private readonly now: () => string,
    private readonly createId: () => string,
  ) {}

  public async migrate(): Promise<void> {
    const versionRow = asRecord(this.database.prepare('PRAGMA user_version').get());
    const version = Number(versionRow.user_version ?? 0);
    if (version > CATALOG_SCHEMA_VERSION) {
      throw new Error(`Unsupported future schema version ${version}`);
    }
    if (version === CATALOG_SCHEMA_VERSION) {
      return;
    }
    if (version === 1) {
      await this.migrateV1ToV2();
      await this.migrateV2ToV3();
      await this.migrateV3ToV4();
      await this.migrateV4ToV5();
      return;
    }
    if (version === 2) {
      await this.migrateV2ToV3();
      await this.migrateV3ToV4();
      await this.migrateV4ToV5();
      return;
    }
    if (version === 3) {
      await this.migrateV3ToV4();
      await this.migrateV4ToV5();
      return;
    }
    if (version === 4) {
      await this.migrateV4ToV5();
      return;
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
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
          media_kind TEXT NOT NULL CHECK (media_kind IN ('photo', 'video', 'live')),
          media_format TEXT NOT NULL CHECK (media_format IN ('png', 'jpg', 'heic', 'avif', 'mp4', 'mov', 'm4v')),
          pixel_width INTEGER,
          pixel_height INTEGER,
          decode_state TEXT NOT NULL CHECK (decode_state IN ('unknown', 'valid', 'corrupt', 'unreadable', 'unsupported')),
          lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'missing', 'trash_pending', 'trashed', 'replaced')),
          note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 60),
          capture_time_local TEXT,
          capture_time_offset_minutes INTEGER CHECK (
            capture_time_offset_minutes IS NULL
            OR capture_time_offset_minutes BETWEEN -840 AND 840
          ),
          capture_time_source TEXT CHECK (capture_time_source IN ('metadata', 'user')),
          last_seen_scan_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX one_current_photo_per_path
          ON photo(source_id, canonical_path_key)
          WHERE lifecycle_state IN ('active', 'missing', 'trash_pending');
        CREATE INDEX photo_by_source_hash ON photo(source_id, content_sha256);

        CREATE TABLE photo_companion (
          photo_id TEXT PRIMARY KEY REFERENCES photo(photo_id) ON DELETE CASCADE,
          display_path TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          canonical_path_key TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          modified_at_ms REAL NOT NULL,
          file_created_at_ms REAL,
          content_sha256 TEXT,
          media_format TEXT NOT NULL CHECK (media_format IN ('mp4', 'mov', 'm4v')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

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
      `);
      const now = this.now();
      this.database
        .prepare(
          `INSERT INTO photo_type (type_id, name, normalized_name, is_builtin, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?), (?, ?, ?, 1, ?, ?)`
        )
        .run(
          'builtin-portrait',
          '人像',
          '人像',
          now,
          now,
          'builtin-landscape',
          '风景',
          '风景',
          now,
          now
        );
      this.database.exec(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}; COMMIT`);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private async migrateV1ToV2(): Promise<void> {
    const countsBefore = this.readTableCounts(this.database);
    await this.createVerifiedMigrationBackup(1, 2, countsBefore);
    this.assertCatalogStructure(this.database, 1);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        ALTER TABLE photo ADD COLUMN file_created_at_ms REAL;
        PRAGMA user_version = 2;
      `);
      this.assertSchemaVersion(this.database, 2);
      this.assertCatalogStructure(this.database, 2);
      this.assertTableCounts(this.database, countsBefore);
      this.checkDatabaseIntegrity(this.database);
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // The original migration error is more actionable than a secondary rollback error.
      }
      throw error;
    }
  }

  private async migrateV2ToV3(): Promise<void> {
    const countsBefore = this.readTableCounts(this.database);
    await this.createVerifiedMigrationBackup(2, 3, countsBefore);
    this.assertCatalogStructure(this.database, 2);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        ALTER TABLE photo ADD COLUMN note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 60);
        PRAGMA user_version = 3;
      `);
      this.assertSchemaVersion(this.database, 3);
      this.assertCatalogStructure(this.database, 3);
      this.assertTableCounts(this.database, countsBefore);
      this.checkDatabaseIntegrity(this.database);
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // The original migration error is more actionable than a secondary rollback error.
      }
      throw error;
    }
  }

  private async migrateV3ToV4(): Promise<void> {
    const countsBefore = this.readTableCounts(this.database);
    await this.createVerifiedMigrationBackup(3, 4, countsBefore);
    this.assertCatalogStructure(this.database, 3);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const photoColumns = new Set(
        this.database.prepare('PRAGMA table_info(photo)').all().map((column) => String(column.name)),
      );
      if (!photoColumns.has('media_kind')) {
        this.database.exec(
          "ALTER TABLE photo ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'photo' CHECK (media_kind IN ('photo', 'video', 'live'));",
        );
      }
      if (!photoColumns.has('media_format')) {
        this.database.exec(
          "ALTER TABLE photo ADD COLUMN media_format TEXT NOT NULL DEFAULT 'jpg' CHECK (media_format IN ('png', 'jpg', 'heic', 'avif', 'mp4', 'mov', 'm4v'));",
        );
        this.database.exec('UPDATE photo SET media_format = image_format;');
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS photo_companion (
          photo_id TEXT PRIMARY KEY REFERENCES photo(photo_id) ON DELETE CASCADE,
          display_path TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          canonical_path_key TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          modified_at_ms REAL NOT NULL,
          file_created_at_ms REAL,
          content_sha256 TEXT,
          media_format TEXT NOT NULL CHECK (media_format IN ('mp4', 'mov', 'm4v')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 4;
      `);
      this.assertSchemaVersion(this.database, 4);
      this.assertCatalogStructure(this.database, 4);
      const countsAfter = this.readTableCounts(this.database);
      for (const [tableName, count] of Object.entries(countsBefore)) {
        if (countsAfter[tableName] !== count) {
          throw new Error(
            `SQLite migration count check failed: ${tableName} expected ${count}, received ${String(countsAfter[tableName])}`,
          );
        }
      }
      if ((countsAfter.photo_companion ?? 0) !== (countsBefore.photo_companion ?? 0)) {
        throw new Error('SQLite migration count check failed: photo_companion row count changed');
      }
      this.checkDatabaseIntegrity(this.database);
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // The original migration error is more actionable than a secondary rollback error.
      }
      throw error;
    }
  }

  private async migrateV4ToV5(): Promise<void> {
    const countsBefore = this.readTableCounts(this.database);
    await this.createVerifiedMigrationBackup(4, 5, countsBefore);
    this.assertCatalogStructure(this.database, 4);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        ALTER TABLE photo ADD COLUMN capture_time_local TEXT;
        ALTER TABLE photo ADD COLUMN capture_time_offset_minutes INTEGER CHECK (
          capture_time_offset_minutes IS NULL
          OR capture_time_offset_minutes BETWEEN -840 AND 840
        );
        ALTER TABLE photo ADD COLUMN capture_time_source TEXT CHECK (
          capture_time_source IN ('metadata', 'user')
        );
        PRAGMA user_version = 5;
      `);
      this.assertSchemaVersion(this.database, 5);
      this.assertCatalogStructure(this.database, 5);
      this.assertTableCounts(this.database, countsBefore);
      this.checkDatabaseIntegrity(this.database);
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // The original migration error is more actionable than a secondary rollback error.
      }
      throw error;
    }
  }

  private async createVerifiedMigrationBackup(
    fromVersion: number,
    toVersion: number,
    sourceCounts: Readonly<Record<string, number>>,
  ): Promise<void> {
    mkdirSync(this.backupsDirectory, { recursive: true });
    const timestamp = this.safePathSegment(this.now());
    const uniqueId = this.safePathSegment(this.createId());
    const directoryName = `schema-v${fromVersion}-to-v${toVersion}-${timestamp}-${uniqueId}`;
    const partialDirectory = path.join(this.backupsDirectory, `.partial-${directoryName}`);
    const backupDirectory = path.join(this.backupsDirectory, directoryName);
    mkdirSync(partialDirectory);
    const backupPath = path.join(partialDirectory, path.basename(this.databasePath));
    await backup(this.database, backupPath);

    const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
    try {
      this.assertSchemaVersion(backupDatabase, fromVersion);
      this.assertTableCounts(backupDatabase, sourceCounts);
      this.checkDatabaseIntegrity(backupDatabase);
    } finally {
      backupDatabase.close();
    }
    renameSync(partialDirectory, backupDirectory);
  }

  private readTableCounts(database: DatabaseSync): Record<string, number> {
    const tableNames = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    const counts: Record<string, number> = {};
    for (const tableName of tableNames) {
      const quotedTableName = `"${tableName.replace(/"/gu, '""')}"`;
      const row = asRecord(database.prepare(`SELECT COUNT(*) AS count FROM ${quotedTableName}`).get());
      counts[tableName] = Number(row.count);
    }
    return counts;
  }

  private assertTableCounts(
    database: DatabaseSync,
    expected: Readonly<Record<string, number>>,
  ): void {
    const actual = this.readTableCounts(database);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `SQLite migration count check failed: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      );
    }
  }

  private assertSchemaVersion(database: DatabaseSync, expected: number): void {
    const row = asRecord(database.prepare('PRAGMA user_version').get());
    const actual = Number(row.user_version ?? 0);
    if (actual !== expected) {
      throw new Error(`SQLite schema version check failed: expected ${expected}, received ${actual}`);
    }
  }

  private assertCatalogStructure(database: DatabaseSync, version: 1 | 2 | 3 | 4 | 5): void {
    for (const [tableName, requiredColumns] of Object.entries(CATALOG_V1_COLUMNS)) {
      const actualColumns = new Set(
        database.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => String(column.name)),
      );
      const expectedColumns = tableName === 'photo'
        ? [
            ...requiredColumns,
            ...(version >= 2 ? ['file_created_at_ms'] : []),
            ...(version >= 3 ? ['note'] : []),
          ]
        : requiredColumns;
      const missingColumns = expectedColumns.filter((columnName) => !actualColumns.has(columnName));
      if (missingColumns.length > 0) {
        throw new Error(
          `SQLite migration structure check failed: ${tableName} is missing ${missingColumns.join(', ')}`,
        );
      }
    }
    if (version >= 4) {
      for (const [tableName, requiredColumns] of Object.entries(CATALOG_V4_COLUMNS)) {
        const actualColumns = new Set(
          database.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => String(column.name)),
        );
        const missingColumns = requiredColumns.filter((columnName) => !actualColumns.has(columnName));
        if (missingColumns.length > 0) {
          throw new Error(
            `SQLite migration structure check failed: ${tableName} is missing ${missingColumns.join(', ')}`,
          );
        }
      }
    }
    if (version >= 5) {
      for (const [tableName, requiredColumns] of Object.entries(CATALOG_V5_COLUMNS)) {
        const actualColumns = new Set(
          database.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => String(column.name)),
        );
        const missingColumns = requiredColumns.filter((columnName) => !actualColumns.has(columnName));
        if (missingColumns.length > 0) {
          throw new Error(
            `SQLite migration structure check failed: ${tableName} is missing ${missingColumns.join(', ')}`,
          );
        }
      }
    }
    const actualIndexes = new Set(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")
        .all()
        .map((index) => String(index.name)),
    );
    const missingIndexes = CATALOG_REQUIRED_INDEXES.filter((indexName) => !actualIndexes.has(indexName));
    if (missingIndexes.length > 0) {
      throw new Error(
        `SQLite migration structure check failed: missing indexes ${missingIndexes.join(', ')}`,
      );
    }
    const revisionRow = database
      .prepare("SELECT value FROM metadata WHERE key = 'catalog_revision'")
      .get();
    const revision = revisionRow === undefined ? Number.NaN : Number(revisionRow.value);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('SQLite migration structure check failed: catalog_revision is missing or invalid');
    }
  }

  private safePathSegment(value: string): string {
    const safe = value.replace(/[^0-9A-Za-z-]+/gu, '-').replace(/^-+|-+$/gu, '');
    return safe || 'unknown';
  }

  public checkIntegrity(): void {
    this.checkDatabaseIntegrity(this.database);
  }

  private checkDatabaseIntegrity(database: DatabaseSync): void {
    const value = database.prepare('PRAGMA quick_check').get();
    const result = value === undefined ? '' : String(Object.values(asRecord(value))[0]);
    if (result !== 'ok') {
      throw new Error(`SQLite quick_check failed: ${result}`);
    }
    const foreignKeyError = database.prepare('PRAGMA foreign_key_check').get();
    if (foreignKeyError !== undefined) {
      throw new Error('SQLite foreign_key_check failed');
    }
  }

}
