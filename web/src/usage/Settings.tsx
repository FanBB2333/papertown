import { Button, Input } from '@cloudflare/kumo';
import { useEffect, useState } from 'react';
import { api, type UsageSettings as Settings } from '../api';
import { Card, Note, Row, Toggle } from '../components/controls';
import { tr } from '../i18n';
import { BudgetFields } from './Usage';

export function UsageSettings() {
  const [value, setValue] = useState<Settings | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  useEffect(() => {
    let alive = true;
    api.usageSettings().then(v => alive && setValue(v), e => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, []);
  const change = (v: Settings) => { setValue(v); setSaved(false); };
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!value) return;
    setBusy(true); setError('');
    try { setValue(await api.setUsageSettings(value)); setSaved(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Card title={tr('订阅用量与项目预算')}>
    {error && <p role="alert" className="em-state" data-tone="bad">{tr(error)}</p>}
    {value ? <form onSubmit={save}>
      <Row label={tr('默认 Agent 用量预算（美元）')} desc={tr('按 API 价格折算，开启项目时预填。留空表示不设预算。')} />
      <BudgetFields value={value.default_budget} onChange={default_budget => change({ ...value, default_budget })} disabled={busy} />
      <Row label={tr('轮询间隔（秒）')} desc={tr('每隔此时间读取本机会话日志，最短 60 秒。订阅余量只在打开页面和点刷新时读取。')}>
        <Input aria-label={tr('轮询间隔（秒）')} type="number" min={60} max={86400} required value={value.poll} disabled={busy} onChange={e => change({ ...value, poll: Number(e.target.value) })} />
      </Row>
      <Row label={tr('读取本机会话日志')} desc={tr('仅统计 token、模型、时间、会话 ID 和目录。关闭后保留已有统计并停止读取新用量。')}>
        <Toggle label={tr('读取本机会话日志')} value={value.logs} onChange={logs => change({ ...value, logs })} />
      </Row>
      <div className="usage-actions">{saved && <Note>{tr('用量设置已保存。')}</Note>}<Button type="submit" variant="primary" loading={busy}>{tr('保存')}</Button></div>
    </form> : !error && <Note>{tr('加载中…')}</Note>}
  </Card>;
}
