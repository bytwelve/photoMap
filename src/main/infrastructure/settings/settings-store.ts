import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings } from '../../../shared/contracts';
import { PhotoMapError } from '../../../shared/errors';
import { cloneAppSettings, defaultAppSettings, parseAppSettings, parseStoredAppSettings } from '../../../shared/settings';

// Covers the strict schema's worst-case valid filter arrays while keeping reads bounded.
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;

export interface SettingsLoadResult {
  settings: AppSettings;
  created: boolean;
  recoveredFromInvalid: boolean;
}

export interface SettingsStorePort {
  get(): AppSettings;
  update(settings: AppSettings): Promise<AppSettings>;
}

export class AtomicSettingsStore implements SettingsStorePort {
  private current = defaultAppSettings();
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly settingsPath: string,
    private readonly createId: () => string = randomUUID
  ) {}

  public async initialize(): Promise<SettingsLoadResult> {
    try {
      const fileStats = await stat(this.settingsPath);
      if (!fileStats.isFile() || fileStats.size > MAX_SETTINGS_BYTES) {
        throw new Error('Settings file is not a bounded regular file.');
      }
      const text = await readFile(this.settingsPath, 'utf8');
      this.current = parseStoredAppSettings(JSON.parse(text) as unknown);
      return { settings: this.get(), created: false, recoveredFromInvalid: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.current = defaultAppSettings();
        await this.persist(this.current);
        return { settings: this.get(), created: true, recoveredFromInvalid: false };
      }
      this.current = defaultAppSettings();
      return { settings: this.get(), created: false, recoveredFromInvalid: true };
    }
  }

  public get(): AppSettings {
    return cloneAppSettings(this.current);
  }

  public async update(settings: AppSettings): Promise<AppSettings> {
    const validated = parseAppSettings(settings);
    const operation = this.writeQueue.then(async () => {
      await this.persist(validated);
      this.current = cloneAppSettings(validated);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return this.get();
  }

  private async persist(settings: AppSettings): Promise<void> {
    const directory = path.dirname(this.settingsPath);
    const temporaryPath = path.join(directory, `.settings-${this.createId()}.tmp`);
    const serialized = `${JSON.stringify(settings)}\n`;
    let handle;
    try {
      if (Buffer.byteLength(serialized, 'utf8') > MAX_SETTINGS_BYTES) {
        throw new Error('Settings document exceeds the bounded schema size.');
      }
      await mkdir(directory, { recursive: true });
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.settingsPath);
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await unlink(temporaryPath).catch(() => undefined);
      throw new PhotoMapError('SETTINGS_WRITE_FAILED', '无法保存应用设置，本次更改未生效。', {
        retryability: 'retry',
        scope: 'task',
        cause: error
      });
    }
  }
}
