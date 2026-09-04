import { describe, expect, it } from 'vitest';
import { trashResultFeedback } from '../../src/renderer/features/batch/trash-feedback';

describe('recycle-bin feedback', () => {
  it('identifies_partial_success_and_explains_how_to_continue', () => {
    const feedback = trashResultFeedback([
      { photoId: 'a', status: 'moved' },
      { photoId: 'b', status: 'partial', movedFileNames: ['旅行.mov'], failureReason: 'access_denied' },
    ]);
    expect(feedback.tone).toBe('warning');
    expect(feedback.message).toContain('已完整移入回收站 1 项');
    expect(feedback.message).toContain('已移走：旅行.mov');
    expect(feedback.message).toContain('再次删除可继续处理剩余文件');
  });

  it('requires_refresh_for_changed_files_and_does_not_claim_they_were_recycled', () => {
    const feedback = trashResultFeedback([{ photoId: 'a', status: 'changed' }]);
    expect(feedback.tone).toBe('warning');
    expect(feedback.message).toContain('已完整移入回收站 0 项');
    expect(feedback.message).toContain('请先刷新照片文件夹');
  });

  it('reports_success_only_when_every_item_was_moved', () => {
    expect(trashResultFeedback([{ photoId: 'a', status: 'moved' }])).toEqual({
      message: '已将 1 项媒体移入 Windows 回收站', tone: 'success',
    });
  });
});
