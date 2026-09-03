import { useLayoutEffect, useRef, useState } from 'react';
import { MEDIA_KINDS } from '../../shared/contracts';
import { errorMessage } from '../bridge';
import type { AppMode, FilterState, OperationFeedback } from '../model';
import { PreferencesSaveQueue } from '../preferences-save';
import { appSettingsFromRenderer, rendererPreferencesFromSettings, safeDefaultSettings, type RendererMapPreference } from '../settings';

export const EMPTY_FILTERS: FilterState = {
  search: '',
  locationCodes: new Set(),
  includeUnlocated: false,
  mediaKinds: new Set(MEDIA_KINDS),
  folderPaths: new Set(),
  typeIds: new Set(),
};

const DEFAULT_PREFERENCES = rendererPreferencesFromSettings(safeDefaultSettings());

export function useAppPreferences(announce: (message: string, kind?: OperationFeedback['kind']) => void) {
  const [mode, setMode] = useState<AppMode>('wall');
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [mapPreference, setMapPreference] = useState<RendererMapPreference>(DEFAULT_PREFERENCES.map);
  const [settingsReady, setSettingsReady] = useState(false);
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const [settingsSaver] = useState(() => new PreferencesSaveQueue(
    async (settings) => {
      const result = await window.photoMap.updateSettings(settings);
      // Rejects the queued save with the transported AppError shape; see bridge.unwrapResult.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (!result.ok) throw result.error;
    },
    (error) => announceRef.current('设置未能保存，本次操作仍可继续：' + errorMessage(error), 'warning'),
  ));

  useLayoutEffect(() => {
    const unsubscribe = window.photoMap.subscribeSettingsFlush(() => settingsSaver.flush());
    return () => {
      unsubscribe();
      settingsSaver.cancelTimer();
    };
  }, [settingsSaver]);

  useLayoutEffect(() => {
    if (settingsReady) settingsSaver.schedule(appSettingsFromRenderer({ mode, filters, map: mapPreference }));
  }, [filters, mapPreference, mode, settingsReady, settingsSaver]);

  return { mode, setMode, filters, setFilters, mapPreference, setMapPreference, settingsReady, setSettingsReady };
}
