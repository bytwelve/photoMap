import type { WindowAction } from '../shared/contracts';

export function App(): React.JSX.Element {
  const windowAction = (action: WindowAction): void => { void window.photoMap.windowAction(action); };
  return <div className="desktop-app"><header className="app-header"><h1>用照片拼地图</h1><button onClick={() => windowAction('minimize')}>最小化</button><button onClick={() => windowAction('toggleMaximize')}>最大化</button><button onClick={() => windowAction('close')}>关闭</button></header><main className="empty-library"><h2>把照片放回走过的地方</h2><p>本地照片地图 · 完全离线</p></main></div>;
}
