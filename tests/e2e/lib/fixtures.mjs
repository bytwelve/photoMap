import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { appRoot, fixturePath, isolatedSourcePath } from './config.mjs';
import { delay, assertCondition, sha256File } from './utils.mjs';

export async function projectFixtureNames() {
  const files = (await readdir(fixturePath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:png|jpg)$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (files.length !== 7) throw new Error(`Expected 7 supported image fixtures, found ${files.length}.`);
  const manifest = JSON.parse(await readFile(path.join(appRoot, 'tests/fixtures/photos/manifest.json'), 'utf8'));
  assertCondition(files.every((name, index) => name === manifest.files[index]?.fileName), 'Photo fixture names do not match the public scenario.');
  if (path.resolve(fixturePath) === path.join(appRoot, 'tests/fixtures/photos')) {
    for (const entry of manifest.files) {
      const file = path.join(fixturePath, entry.fileName);
      assertCondition((await lstat(file)).size === entry.bytes && (await sha256File(file)).toLowerCase() === entry.sha256, `Public fixture changed: ${entry.fileName}`);
    }
  }
  return files;
}

export async function stageProjectFixtures() {
  const files = await projectFixtureNames();
  const existing = await readdir(isolatedSourcePath);
  if (existing.length !== 0) {
    throw new Error(`Isolated scan source must be empty before staging, found ${existing.length} entries.`);
  }
  await copyFile(path.join(fixturePath, files[0]), path.join(isolatedSourcePath, files[0]));
  // The product sorts on the destination file's creation time. Keep two staging
  // generations far enough apart to make that ordering evidence deterministic
  // even on filesystems with coarse timestamp precision.
  await delay(1_100);
  await Promise.all(files.slice(1).map((fileName) => (
    copyFile(path.join(fixturePath, fileName), path.join(isolatedSourcePath, fileName))
  )));
  const staged = (await readdir(isolatedSourcePath)).sort();
  assertCondition(
    staged.length === files.length && staged.every((fileName, index) => fileName === files[index]),
    `Isolated scan source did not contain exactly the project fixtures: ${JSON.stringify(staged)}`,
  );
  const creationTimes = await Promise.all(staged.map(async (fileName) => ({
    fileName,
    fileCreatedAtMs: (await lstat(path.join(isolatedSourcePath, fileName))).birthtimeMs,
  })));
  const distinctCreationTimeCount = new Set(creationTimes.map((item) => item.fileCreatedAtMs)).size;
  assertCondition(
    creationTimes.every((item) => Number.isFinite(item.fileCreatedAtMs) && item.fileCreatedAtMs > 0)
    && distinctCreationTimeCount >= 2,
    `Staged fixtures did not expose at least two distinct creation times: ${JSON.stringify(creationTimes)}`,
  );
  return { files: staged, creationTimes, distinctCreationTimeCount };
}

export async function seedCatalog(runtime) {
  const databasePath = path.join(runtime.photoMapDataRoot, 'data', 'index.sqlite3');
  const files = await projectFixtureNames();

  const now = new Date().toISOString();
  const sourceId = randomUUID();
  const scanRunId = randomUUID();
  const canonicalRoot = path.resolve(isolatedSourcePath).normalize('NFC').toLocaleLowerCase('en-US');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
  try {
    database.prepare(
      `INSERT INTO library_source
        (source_id, root_path, canonical_root_key, is_active, availability, last_scan_run_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'available', NULL, ?, ?)`,
    ).run(sourceId, isolatedSourcePath, canonicalRoot, now, now);
    database.prepare(
      `INSERT INTO scan_run
        (run_id, source_id, status, discovered_count, indexed_count, unchanged_count, error_count, started_at, finished_at)
       VALUES (?, ?, 'succeeded', 0, 0, 0, 0, ?, ?)`,
    ).run(scanRunId, sourceId, now, now);
    database.prepare(
      'UPDATE library_source SET last_scan_run_id = ?, updated_at = ? WHERE source_id = ?',
    ).run(scanRunId, now, sourceId);
    database.prepare("UPDATE metadata SET value = '1' WHERE key = 'catalog_revision'").run();
    const seededPhotoCount = Number(database.prepare('SELECT COUNT(*) AS count FROM photo').get().count);
    if (seededPhotoCount !== 0) {
      throw new Error(`Seed catalog unexpectedly contains ${seededPhotoCount} photos.`);
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
  return { scanRunId, fixtureCount: files.length, seededPhotoCount: 0, sourcePath: isolatedSourcePath };
}
