import { useCallback, useState } from 'react';
import { PHOTO_MAP_ASSETS, type AppInfo, type MapDataStatus } from '../../shared/contracts';
import { errorMessage, unwrapResult } from '../bridge';
import type { OperationFeedback, RegionCollection } from '../model';
import { loadRegionCollection } from '../map-scene/scene';
import { withMapDataStatus } from '../map-data-state';

const MAP_DATA_LABELS = {
  province: '省份数据',
  city: '城市数据',
} as const;

export function useMapData(announce: (message: string, kind?: OperationFeedback['kind']) => void) {
  const [provinces, setProvinces] = useState<RegionCollection>();
  const [cities, setCities] = useState<RegionCollection>();
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [appInfoError, setAppInfoError] = useState<string>();
  const [mapError, setMapError] = useState<string>();
  const [mapDataBusy, setMapDataBusy] = useState(false);

  const clearMapCollections = useCallback(() => {
    setProvinces(undefined);
    setCities(undefined);
    setMapError(undefined);
  }, []);

  const loadMapCollections = useCallback(async (status: MapDataStatus): Promise<void> => {
    if (!status.ready) {
      setProvinces(undefined);
      setCities(undefined);
      setMapError(undefined);
      return;
    }
    try {
      const [provinceCollection, cityCollection] = await Promise.all([
        loadRegionCollection(PHOTO_MAP_ASSETS.provinceMap),
        loadRegionCollection(PHOTO_MAP_ASSETS.cityMap),
      ]);
      setProvinces(provinceCollection);
      setCities(cityCollection);
      setMapError(undefined);
    } catch (error) {
      setProvinces(undefined);
      setCities(undefined);
      setMapError(errorMessage(error));
    }
  }, []);

  async function importMapData(): Promise<void> {
    const mapWasReady = appInfo?.mapData.ready === true;
    setMapDataBusy(true);
    try {
      const result = unwrapResult(await window.photoMap.importMapData());
      setAppInfo((current) => withMapDataStatus(current, result.status));
      await loadMapCollections(result.status);
      if (result.cancelled) return;

      const accepted = result.accepted.map((kind) => MAP_DATA_LABELS[kind]);
      if (result.status.error) {
        announce(result.status.error, 'error');
      } else if (result.rejected.length > 0) {
        const prefix = accepted.length > 0 ? `已导入${accepted.join('和')}；` : '';
        const unrecognized = result.rejected.filter((item) => item.reason === 'unrecognized').length;
        const unreadable = result.rejected.filter((item) => item.reason === 'source_unreadable').length;
        const issues = [
          ...(unrecognized > 0 ? [`${unrecognized} 个文件未通过地图数据校验`] : []),
          ...(unreadable > 0 ? [`${unreadable} 个文件无法读取`] : []),
        ];
        announce(`${prefix}${issues.join('；')}`, 'warning');
      } else if (result.status.ready) {
        announce(mapWasReady
          ? '省份和城市地图数据已就绪，照片墙模式可以使用'
          : '省份和城市地图数据已就绪，照片墙模式可以使用；若已有照片源，将在本地重新扫描 GPS 地址与拍摄时间');
      } else if (accepted.length > 0) {
        announce(`已导入${accepted.join('和')}，当前进度 ${result.status.completed} / ${result.status.total}`, 'info');
      }
    } catch (error) {
      announce(errorMessage(error), 'error');
    } finally {
      setMapDataBusy(false);
    }
  }

  async function openMapDownload(): Promise<void> {
    try {
      unwrapResult(await window.photoMap.openMapDownload());
    } catch (error) {
      announce(errorMessage(error), 'error');
    }
  }

  return { provinces, cities, appInfo, setAppInfo, appInfoError, setAppInfoError, mapError, mapDataBusy, loadMapCollections, clearMapCollections, importMapData, openMapDownload };
}
