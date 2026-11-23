// Keeps one part of the page from blanking the whole app: when it throws while rendering, this part shows what failed
// and a retry, and the rest of the page keeps working. Give it a key that changes with the route so a new page starts clean.
import { Component, type ReactNode } from 'react';
import { tr } from '../i18n';

export class Guard extends Component<{ children: ReactNode; onClose?: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="guard" role="alert">
        <b>{tr('此处内容未能显示')}</b>
        <p className="muted small">{tr('渲染出错，页面其余部分照常可用。错误信息：')}</p>
        <code>{error.message || String(error)}</code>
        <div className="btns">
          <button className="btn pri" onClick={() => this.setState({ error: null })}>{tr('重试')}</button>
          {this.props.onClose && <button className="btn" onClick={this.props.onClose}>{tr('关闭')}</button>}
        </div>
      </div>
    );
  }
}
