import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ScanMetadataDialog } from '../../src/renderer/components/ScanMetadataDialog';

function renderDialog(overrides: Partial<Parameters<typeof ScanMetadataDialog>[0]> = {}): string {
  return renderToStaticMarkup(createElement(ScanMetadataDialog, {
    total: 128,
    exifCount: 92,
    gpsCount: 48,
    resolvedLocationCount: 41,
    captureTimeCount: 76,
    metadataErrorCount: 3,
    busy: false,
    onDecision: vi.fn(),
    ...overrides,
  }));
}

function openingButton(markup: string, testId: string): string {
  const match = markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`, 'u'));
  expect(match).not.toBeNull();
  return match?.[0] ?? '';
}

describe('scan metadata decision dialog static contract', () => {
  it('renders the three accessible metadata decisions in the intended order', () => {
    const markup = renderDialog();
    const ignoreIndex = markup.indexOf('data-testid="scan-metadata-ignore"');
    const overwriteIndex = markup.indexOf('data-testid="scan-metadata-overwrite"');
    const fillIndex = markup.indexOf('data-testid="scan-metadata-fill-unlabeled"');

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="scan-metadata-title"');
    expect(markup).toContain('如何处理扫描到的照片信息？');
    expect(markup).toContain('data-testid="scan-metadata-total">128');
    expect(markup).toContain('data-testid="scan-metadata-exif">92');
    expect(markup).toContain('data-testid="scan-metadata-gps">48');
    expect(markup).toContain('data-testid="scan-metadata-resolved">41');
    expect(markup).toContain('data-testid="scan-metadata-capture-time">76');
    expect(markup).toContain('忽略 GPS 地址与拍摄时间');
    expect(markup).toContain('应用 GPS 地址与拍摄时间');
    expect(markup).toContain('会覆盖已有地址');
    expect(markup).toContain('仅为缺少信息的照片补充');
    expect(markup).toContain('推荐');
    expect(markup).toContain('3 张照片有部分元数据无效');
    expect(markup).toContain('可用信息仍会保留');
    expect(markup).toContain('没有可用 GPS 地址或拍摄时间的照片不会写入空值');
    expect(markup).toContain('手动修改的拍摄时间不会被扫描覆盖');
    expect(ignoreIndex).toBeGreaterThan(-1);
    expect(overwriteIndex).toBeGreaterThan(ignoreIndex);
    expect(fillIndex).toBeGreaterThan(overwriteIndex);
    expect(openingButton(markup, 'scan-metadata-ignore')).toContain('autofocus');
    expect(openingButton(markup, 'scan-metadata-ignore')).not.toContain('disabled');
    expect(openingButton(markup, 'scan-metadata-overwrite')).not.toContain('disabled');
    expect(openingButton(markup, 'scan-metadata-fill-unlabeled')).not.toContain('disabled');
  });

  it('keeps both write choices available when capture times exist without resolved GPS locations', () => {
    const markup = renderDialog({ resolvedLocationCount: 0, captureTimeCount: 12, metadataErrorCount: 0 });

    expect(markup).not.toContain('data-testid="scan-metadata-errors"');
    expect(openingButton(markup, 'scan-metadata-ignore')).not.toContain('disabled');
    expect(openingButton(markup, 'scan-metadata-overwrite')).not.toContain('disabled');
    expect(openingButton(markup, 'scan-metadata-fill-unlabeled')).not.toContain('disabled');
  });

  it('keeps ignore available and disables both write choices without any applicable metadata', () => {
    const markup = renderDialog({ resolvedLocationCount: 0, captureTimeCount: 0, metadataErrorCount: 0 });

    expect(markup).not.toContain('data-testid="scan-metadata-errors"');
    expect(openingButton(markup, 'scan-metadata-ignore')).not.toContain('disabled');
    expect(openingButton(markup, 'scan-metadata-overwrite')).toContain('disabled');
    expect(openingButton(markup, 'scan-metadata-fill-unlabeled')).toContain('disabled');
  });

  it('disables every decision while busy and shows a spinner only on the pending choice', () => {
    const markup = renderDialog({
      busy: true,
      pendingDecision: 'overwrite-all-resolved',
    });

    expect(markup).toContain('aria-busy="true"');
    expect(openingButton(markup, 'scan-metadata-ignore')).toContain('disabled');
    expect(openingButton(markup, 'scan-metadata-overwrite')).toContain('disabled');
    expect(openingButton(markup, 'scan-metadata-fill-unlabeled')).toContain('disabled');
    expect(markup.match(/class="spin"/gu)).toHaveLength(1);
  });

  it('maps Escape and backdrop dismissal to the safe ignore decision', () => {
    const componentSource = readFileSync(
      new URL('../../src/renderer/components/ScanMetadataDialog.tsx', import.meta.url),
      'utf8',
    );

    expect(componentSource).toContain("event.key === 'Escape' && !props.busy");
    expect(componentSource).toContain("props.onDecision('ignore')");
    expect(componentSource).toContain("window.addEventListener('keydown', ignoreOnEscape)");
    expect(componentSource).toContain("window.removeEventListener('keydown', ignoreOnEscape)");
    expect(componentSource).toContain('event.target === event.currentTarget && !props.busy');
  });
});
