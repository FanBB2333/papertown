import { type Agent, type Bucket } from '../api';
import { dur } from '../console/util';
import { tr } from '../i18n';

export const BUCKETS: [Bucket, string][] = [
  ['needs', tr('待处理')], ['failed', tr('出错')], ['review', tr('待查看')],
  ['working', tr('工作中')], ['idle', tr('待命')], ['off', tr('未启动')],
];
export type Watched = { status?: string; watch?: Agent['watch']; down?: string | null };
export const bucketOf = (a: Watched): Bucket => a.watch?.bucket ?? (a.status === 'error' ? 'failed'
  : ['working', 'starting'].includes(a.status ?? '') ? 'working' : ['idle', 'watching'].includes(a.status ?? '') ? 'idle' : 'off');
export const isWorking = (a: Watched) => a.status === 'working' || bucketOf(a) === 'working' || !!a.watch?.permissions.length;
// herdr reports an agent's kind in lower case; the page names the product.
const KINDS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', agy: 'Antigravity', pi: 'pi', opencode: 'OpenCode', copilot: 'Copilot', cursor: 'Cursor' };
export const kindName = (kind?: string | null) => (kind ? KINDS[kind.toLowerCase()] ?? kind : '');
export const agentName = (a: Agent) => a.task?.title || ({ coder: tr('代码员工'), writer: tr('写作员工'), monitor: tr('看田员'), lead: tr('项目负责人'), assistant: tr('小助手') })[a.role];
export function WatchStatus({ agent }: { agent: Watched }) {
  const bucket = bucketOf(agent), name = bucket === 'off' && (agent.down || agent.status === 'offline') ? tr('连不上') : BUCKETS.find(x => x[0] === bucket)![1];
  return <span className={`aw-status aw-${bucket}`}><i className="aw-dot" aria-hidden="true" />{name}</span>;
}
export function TurnTime({ agent }: { agent: Agent }) {
  const since = Date.parse(agent.watch?.turn ?? '');
  return isWorking(agent) && Number.isFinite(since) ? <span className="small muted">{tr('本轮已运行 {0}', dur(Math.max(0, Date.now() - since) / 1000))}</span> : null;
}
