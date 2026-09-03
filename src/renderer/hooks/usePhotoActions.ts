import { useMemo, type Dispatch, type SetStateAction } from 'react';
import type { LibrarySnapshot, PhotoType } from '../../shared/contracts';
import type { OperationFeedback } from '../model';
import { errorMessage, unwrapResult } from '../bridge';

interface PhotoActionOptions {
  acceptLibrarySnapshot: (snapshot: LibrarySnapshot) => void;
  setRawLibrary: Dispatch<SetStateAction<LibrarySnapshot | undefined>>;
  announce: (message: string, kind?: OperationFeedback['kind']) => void;
}

export function usePhotoActions({ acceptLibrarySnapshot, setRawLibrary, announce }: PhotoActionOptions) {
  return useMemo(() => {
    async function createType(name: string): Promise<boolean> {
      try {
        const created: PhotoType = unwrapResult(await window.photoMap.createType({ name }));
        setRawLibrary((current) => current ? {
          ...current,
          photoTypes: current.photoTypes.some((type) => type.typeId === created.typeId)
            ? current.photoTypes
            : [...current.photoTypes, created],
        } : current);
        announce(`已创建标签“${created.name}”`);
        return true;
      } catch (error) {
        announce(errorMessage(error), 'error');
        return false;
      }
    }

    async function updateLocation(
      ids: readonly string[],
      provinceCode?: string,
      cityCode?: string,
    ): Promise<boolean> {
      if (ids.length === 0) return false;
      try {
        const result = unwrapResult(await window.photoMap.updateLocations({
          photoIds: [...ids],
          location: provinceCode ? { provinceGb: provinceCode, ...(cityCode ? { cityGb: cityCode } : {}) } : null,
        }));
        acceptLibrarySnapshot(result.library);
        const kind = result.failed > 0 ? 'warning' : 'success';
        announce(`地点操作：成功 ${result.succeeded}，跳过 ${result.skipped}，失败 ${result.failed}`, kind);
        return result.failed === 0;
      } catch (error) {
        announce(errorMessage(error), 'error');
        return false;
      }
    }

    async function updateTypes(ids: readonly string[], add: readonly string[], remove: readonly string[]): Promise<boolean> {
      if (ids.length === 0) return false;
      try {
        const result = unwrapResult(await window.photoMap.updateTypes({ photoIds: [...ids], addTypeIds: [...add], removeTypeIds: [...remove] }));
        acceptLibrarySnapshot(result.library);
        announce(`标签操作：成功 ${result.succeeded}，跳过 ${result.skipped}，失败 ${result.failed}`, result.failed > 0 ? 'warning' : 'success');
        return result.failed === 0;
      } catch (error) {
        announce(errorMessage(error), 'error');
        return false;
      }
    }

    async function updateNote(id: string, note: string): Promise<boolean> {
      try {
        const result = unwrapResult(await window.photoMap.updateNote({ photoId: id, note }));
        acceptLibrarySnapshot(result.library);
        return result.succeeded === 1 && result.skipped === 0 && result.failed === 0;
      } catch (error) {
        announce(errorMessage(error), 'error');
        return false;
      }
    }

    async function updateCaptureTime(id: string, localDateTime: string): Promise<boolean> {
      try {
        const result = unwrapResult(await window.photoMap.updateCaptureTime({
          photoId: id,
          localDateTime,
        }));
        acceptLibrarySnapshot(result.library);
        return result.succeeded === 1 && result.skipped === 0 && result.failed === 0;
      } catch (error) {
        announce(errorMessage(error), 'error');
        return false;
      }
    }

    async function renamePhoto(id: string, newFileName: string): Promise<boolean> {
      try {
        const result = unwrapResult(await window.photoMap.renamePhoto({ photoId: id, newFileName }));
        acceptLibrarySnapshot(result.library);
        announce(
          result.renamed ? `已重命名为“${result.fileName}”` : '文件名未变化',
          result.renamed ? 'success' : 'info',
        );
        return true;
      } catch (error) {
        announce(errorMessage(error), 'error');
        return false;
      }
    }

    return { createType, updateLocation, updateTypes, updateNote, updateCaptureTime, renamePhoto };
  }, [acceptLibrarySnapshot, setRawLibrary, announce]);
}
