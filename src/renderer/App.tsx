import { useEffect, useState } from 'react';
import type { LibrarySnapshot, WindowAction } from '../shared/contracts';
import { PROVINCES, CITIES } from '../shared/administrative-regions';
import { errorMessage, regionNamesFromOptions, toLibraryState, unwrapResult } from './bridge';

const names = regionNamesFromOptions(PROVINCES, CITIES);

export function App(): React.JSX.Element {
  const [raw, setRaw] = useState<LibrarySnapshot>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [version, setVersion] = useState('');

  async function execute(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    try { await work(); } catch (error) { setFeedback(errorMessage(error)); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    void execute(async () => {
      setRaw(unwrapResult(await window.photoMap.getLibrary()));
      const info = unwrapResult(await window.photoMap.getAppInfo());
      setVersion(info.version);
    });
    return window.photoMap.subscribeScanProgress((scan) => {
      setRaw((current) => current ? { ...current, scan } : current);
      if (scan.status !== 'running' && scan.status !== 'idle') {
        void execute(async () => { setRaw(unwrapResult(await window.photoMap.getLibrary())); });
      }
    });
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(''), 7000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const library = raw ? toLibraryState(raw, names) : undefined;
  const allPhotos = library?.photos ?? [];
  const photos = allPhotos;

  async function chooseSource(): Promise<void> {
    await execute(async () => {
      const result = unwrapResult(await window.photoMap.chooseLibrary());
      if (!result.cancelled) setRaw(result.library);
    });
  }

  async function refresh(): Promise<void> {
    await execute(async () => { setRaw(unwrapResult(await window.photoMap.refreshLibrary()).library); });
  }

  const windowAction = (action: WindowAction): void => { void execute(async () => { unwrapResult(await window.photoMap.windowAction(action)); }); };

  return <div className="desktop-app" data-testid="app-shell">
    <header className="app-header"><h1>用照片拼地图</h1>
      <button onClick={() => windowAction('minimize')}>最小化</button><button onClick={() => windowAction('toggleMaximize')}>最大化</button><button onClick={() => windowAction('close')}>关闭</button>
    </header>
    <div className="source-toolbar"><strong>{library?.sourceName ?? '尚未选择照片文件夹'}</strong><button disabled={busy} onClick={() => void chooseSource()}>选择照片文件夹</button><button disabled={busy || !raw?.source} onClick={() => void refresh()}>重新扫描</button>
      {raw?.scan.status === 'running' && <button onClick={() => void execute(async () => { setRaw(unwrapResult(await window.photoMap.cancelScan()).library); })}>取消扫描</button>}
    </div>
    {!raw?.source ? <main className="empty-library"><h2>把照片放回走过的地方</h2><p>选择一个照片文件夹，递归扫描后建立本地索引。</p><button disabled={busy} onClick={() => void chooseSource()}>选择照片文件夹</button></main> : <div className="library-layout">
      <section className="library-content">
        {photos.length === 0 ? <div className="empty-library">没有符合条件的照片</div> : <div className="photo-grid">{photos.map((photo) => <article key={photo.id} className={'photo-tile'}>{photo.decodeState === 'valid' ? <img src={photo.thumbnailUrl} alt={photo.name} loading="lazy" /> : <div className="photo-problem">{photo.decodeMessage}</div>}<footer>{photo.name}</footer></article>)}</div>}
      </section>
    </div>}
    <footer className="app-status"><span>{photos.length} 项照片</span><span>扫描：{raw?.scan.status ?? 'idle'} · 已发现 {raw?.scan.counts.discovered ?? 0} 项 · 异常 {raw?.scan.counts.errors ?? 0} 项</span><span>完全离线 · {version}</span></footer>
    {feedback && <div className="feedback-message" role="status">{feedback}</div>}
  </div>;
}
