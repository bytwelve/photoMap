import type { ApiResult, AppInfo, MapDataStatus } from '../shared/contracts';
import type { AppMode } from './model';
import { errorMessage, unwrapResult } from './bridge';

export type WallMapGate = 'content' | 'app-info-error' | 'map-data-setup';

export function wallMapGate(
  mode: AppMode,
  appInfo: AppInfo | undefined,
  appInfoError: string | undefined,
): WallMapGate {
  if (mode !== 'wall') return 'content';
  if (appInfo === undefined || appInfoError !== undefined) return 'app-info-error';
  return appInfo.mapData.ready ? 'content' : 'map-data-setup';
}

export function withMapDataStatus(
  appInfo: AppInfo | undefined,
  status: MapDataStatus,
): AppInfo | undefined {
  return appInfo === undefined ? undefined : {
    ...appInfo,
    mapData: status,
  };
}

export type WallAppInfoRefresh =
  | { ok: true; appInfo: AppInfo }
  | { ok: false; error: string };

export async function readWallAppInfo(
  getAppInfo: () => Promise<ApiResult<AppInfo>>,
): Promise<WallAppInfoRefresh> {
  try {
    return { ok: true, appInfo: unwrapResult(await getAppInfo()) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
