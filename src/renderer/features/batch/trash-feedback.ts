import type { TrashItemResult } from '../../../shared/contracts';

export function trashResultFeedback(items: TrashItemResult[]): { message: string; tone: 'warning' | 'success' } {
  const moved = items.filter((item) => item.status === 'moved').length;
  if (moved === items.length) {
    return { message: `已将 ${moved} 项媒体移入 Windows 回收站`, tone: 'success' };
  }
  const messages = [`已完整移入回收站 ${moved} 项，${items.length - moved} 项未完整处理。`];
  const partial = items.filter((item) => item.status === 'partial');
  if (partial.length > 0) {
    const names = partial.flatMap((item) => item.movedFileNames ?? []);
    messages.push(`其中 ${partial.length} 项部分完成，已移走：${names.slice(0, 3).join('、')}${names.length > 3 ? '等文件' : ''}。`);
  }
  const reasons = new Set(items.map((item) => item.failureReason ?? item.status));
  if (reasons.has('changed')) messages.push('有文件已在软件外发生变化，请先刷新照片文件夹。');
  if (reasons.has('not_found')) messages.push('有文件已不存在，请刷新照片文件夹并检查实际文件。');
  if (reasons.has('index_failed')) messages.push('索引未能完整保存，请刷新照片文件夹并核对回收站。');
  if (reasons.has('access_denied')) messages.push('请关闭占用文件的程序或检查权限。');
  if (reasons.has('access_denied') || reasons.has('failed')) messages.push('再次删除可继续处理剩余文件。');
  return { message: messages.join(''), tone: 'warning' };
}
