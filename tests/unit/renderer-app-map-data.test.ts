import { describe, expect, it, vi } from 'vitest';

import {
  readWallAppInfo,
  wallMapGate,
  withMapDataStatus,
} from '../../src/renderer/map-data-state';
import type { AppInfo, MapDataStatus } from '../../src/shared/contracts';

function mapStatus(province: boolean, city: boolean): MapDataStatus {
  const completed = Number(province) + Number(city);
  return {
    items: [
      { kind: 'province', label: '省份数据', imported: province },
      { kind: 'city', label: '城市数据', imported: city },
    ],
    completed,
    total: 2,
    ready: completed === 2,
  };
}

function appInfo(status: MapDataStatus): AppInfo {
  return {
    name: 'PhotoMap',
    version: '1.0.0',
    platform: 'win32',
    isPackaged: true,
    mapData: status,
  };
}

describe('renderer photo-wall map-data gate', () => {
  it('fails closed when app info is absent or its refresh failed', () => {
    const readyInfo = appInfo(mapStatus(true, true));

    expect(wallMapGate('wall', undefined, undefined)).toBe('app-info-error');
    expect(wallMapGate('wall', readyInfo, '状态读取失败')).toBe('app-info-error');
    expect(wallMapGate('memory', undefined, '状态读取失败')).toBe('content');
  });

  it('shows setup until both current map-data files are ready', () => {
    expect(wallMapGate('wall', appInfo(mapStatus(true, false)), undefined)).toBe('map-data-setup');
    expect(wallMapGate('wall', appInfo(mapStatus(true, true)), undefined)).toBe('content');
  });

  it('reads fresh app info for a wall transition and preserves a public failure message', async () => {
    const current = appInfo(mapStatus(false, true));
    const getReadyInfo = vi.fn(async () => ({ ok: true as const, value: current }));
    const getFailedInfo = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'MAP_IMPORT_FAILED' as const,
        userMessage: '地图状态暂时不可用',
        retryability: 'retry' as const,
        scope: 'task' as const,
      },
    }));

    await expect(readWallAppInfo(getReadyInfo)).resolves.toEqual({ ok: true, appInfo: current });
    await expect(readWallAppInfo(getFailedInfo)).resolves.toEqual({
      ok: false,
      error: '地图状态暂时不可用',
    });
    expect(getReadyInfo).toHaveBeenCalledTimes(1);
    expect(getFailedInfo).toHaveBeenCalledTimes(1);
  });

  it('applies the returned status even when an import dialog was cancelled', () => {
    const before = appInfo(mapStatus(true, true));
    const latestAfterCancel = mapStatus(true, false);

    expect(withMapDataStatus(before, latestAfterCancel)).toEqual({
      ...before,
      mapData: latestAfterCancel,
    });
  });
});
