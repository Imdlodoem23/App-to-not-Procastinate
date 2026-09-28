/**
 * Last line of defence of a window: a render error is reported to main's log
 * (`app:renderer-error`) and the window shows one sentence and «Recargar» instead of a blank
 * page. Blocks are the guardian's: nothing the window does can stop them.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { CentrateBridge } from '../../../shared/ipc';
import { RENDERER_ES } from '../i18n/es';
import { reportError } from './errors';

interface Props {
  bridge: CentrateBridge | null;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportError(this.props.bridge, error, info.componentStack ?? null);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <FatalMessage title={RENDERER_ES.shell.crashed} help={RENDERER_ES.shell.crashedHelp} />;
  }
}

export function FatalMessage(props: { title: string; help?: string }): React.JSX.Element {
  return (
    <main className="fatal">
      <h1 className="c-section-title">{props.title}</h1>
      {props.help ? (
        <p className="c-help" data-tone="muted">
          {props.help}
        </p>
      ) : null}
      <div>
        <button
          type="button"
          className="c-tile"
          data-size="text"
          data-surface="tile"
          data-hover=""
          onClick={() => window.location.reload()}
        >
          <span className="c-tile-label">{RENDERER_ES.shell.reload}</span>
        </button>
      </div>
    </main>
  );
}
