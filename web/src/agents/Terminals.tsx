// Every terminal an agent runs in, side by side (/terminals): what is on each screen now, and one of them opened
// to work in (/terminals/<agent>). The agents run in the background; this is where their terminals are looked at.

import { ScreenWall, useScreens } from '@teletty/web';
import { useMemo } from 'react';
import { api, type Agent, type Overview, type ProjectRef, type Terminal } from '../api';
import { Icon } from '../console/icons';
import { tr } from '../i18n';
import { follow, go, href, terminalPath } from '../route';
import { useOverview } from './overview';
import { HostedRoom, TerminalRoom } from './Terminal';
import { figures } from '../emphasis';
import { agentName, bucketOf, BUCKETS, kindName } from './watch';
import './terminals.css';

export interface OpenTerminal {
  id: string; name: string; about: string; line: ProjectRef | null; bucket: ReturnType<typeof bucketOf>;
  agent?: Agent; terminal?: Terminal;
}

const STATES: Record<string, string> = { ...Object.fromEntries(BUCKETS), off: tr('已关闭') };
const ORDER = ['needs', 'failed', 'working', 'review', 'idle', 'off'];

// the terminals that are open now: employees, leads and the assistant in tmux, herdr or the background, and herdr's
// own sessions. `closed` keeps the ones whose terminal has exited (one opened by its address still shows).
export function openTerminals(o: Overview | null, closed = false): OpenTerminal[] {
  if (!o) return [];
  const out: OpenTerminal[] = [];
  for (const g of o.groups) {
    for (const a of g.agents) {
      if (!a.term || (!closed && a.term.status === 'exited')) continue;
      out.push({ id: a.id, name: agentName(a), about: [kindName(a.term.provider), a.runtime, a.term.model].filter(Boolean).join(' · '), line: g.line, bucket: bucketOf(a), agent: a });
    }
    for (const t of g.terminals) out.push(herdr(t, g.line));
  }
  for (const t of o.others) out.push(herdr(t, null));
  return out.sort((x, y) => ORDER.indexOf(x.bucket) - ORDER.indexOf(y.bucket));
}
const herdr = (t: Terminal, line: ProjectRef | null): OpenTerminal => ({
  id: t.id, name: t.name || t.title || tr('终端会话'), about: [kindName(t.kind), 'herdr'].filter(Boolean).join(' · '), line, bucket: bucketOf(t), terminal: t,
});

function State({ t }: { t: OpenTerminal }) {
  return <span className="tw-st" data-b={t.bucket}><i aria-hidden="true" />{STATES[t.bucket]}</span>;
}
const where = (t: OpenTerminal) => (t.line ? `#${t.line.seq} ${t.line.title}` : t.agent?.role === 'assistant' ? tr('全局') : tr('未归属项目'));

export function Terminals({ id, toast, onClose }: { id?: string; toast: (t: string, error?: boolean) => void; onClose: () => void }) {
  const { data, error } = useOverview();
  const list = useMemo(() => openTerminals(data), [data]);
  const one = useMemo(() => (id ? openTerminals(data, true).find(t => t.id === id) : undefined), [data, id]);
  const wall = !id;

  const { screens, unread } = useScreens(api.screens, wall ? 2500 : null);

  const needs = list.filter(t => t.bucket === 'needs').length, working = list.filter(t => t.bucket === 'working').length;
  return (
    <div className={`tw${wall ? '' : ' tw-one'}`}>
      <header className="tw-head">
        {wall ? <span className="tw-ic"><Icon n="term" size={17} /></span>
          : <a className="btn tw-back" href={href(terminalPath())} onClick={e => follow(e, terminalPath())}><Icon n="left" size={14} />{tr('全部终端')}</a>}
        {wall && <h1>{tr('后台终端')}</h1>}
        {wall ? !!list.length && <p className="tw-sum">
          <span>{figures(tr('{0} 个终端', list.length))}</span>
          {!!working && <span>{figures(tr('{0} 个工作中', working))}</span>}
          {!!needs && <span className="tw-st" data-b="needs"><i aria-hidden="true" />{tr('{0} 个待处理', needs)}</span>}
        </p> : one && <p className="tw-sum"><span>{where(one)}</span></p>}
        <button className="ib tw-close" title={tr('关闭')} aria-label={tr('关闭')} onClick={onClose}><Icon n="close" size={17} /></button>
      </header>

      <div className={wall ? 'tw-body' : 'tw-split'}>
        {wall ? <ScreenWall container={false} items={data ? list : null} screens={screens} unread={unread}
          href={t => href(terminalPath(t.id))} onSelect={t => go(terminalPath(t.id))} bucket={t => t.bucket}
          labels={{ loading: error || tr('加载中…'), reading: tr('读取中…'), unread: tr('未能读取终端画面，打开后可查看。'),
            empty: tr('终端暂未输出内容。'), openTerminal: tr('打开此终端进行操作') }}
          empty={<div className="tw-blank"><b>{tr('当前没有运行中的终端')}</b><p>{tr('员工、项目负责人或小助手以终端方式启动后，其终端显示在此。')}</p></div>}
          renderHeader={t => <><div className="tw-who"><b>{t.name}</b><span>{where(t)}</span></div><State t={t} /></>}
          renderFooter={t => <><span>{t.about}</span><em>{tr('打开')}<Icon n="right" size={12} /></em></>} />
        : <>
          <nav className="tw-rail" aria-label={tr('全部终端')}>
            {list.map(t => (
              <a key={t.id} className={t.id === id ? 'on' : ''} aria-current={t.id === id ? 'page' : undefined} href={href(terminalPath(t.id))} onClick={e => follow(e, terminalPath(t.id))}>
                <div className="tw-who"><b>{t.name}</b><span>{where(t)}</span></div>
                <State t={t} />
              </a>
            ))}
          </nav>
          <div className="tw-room" key={id}>
            {one?.agent ? <HostedRoom agent={one.agent} toast={toast} open="screen" />
              : one?.terminal ? <TerminalRoom terminal={one.terminal} toast={toast} open="screen" />
                : <p className="tw-blank">{data ? tr('没有这个终端，可能已关闭。') : error || tr('加载中…')}</p>}
          </div>
        </>}
      </div>
    </div>
  );
}
