import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from '../components/EmptyState';

interface Props {
  children: ReactNode;
  /** Headline when a page crashes. */
  title?: string;
}

interface State {
  error: unknown;
}

function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /dynamically imported module|Importing a module script failed|Failed to fetch dynamically|ChunkLoadError/i.test(
      error.message,
    )
  );
}

/**
 * Contains a crashing page so the shell (nav, top bar, decisions inbox) keeps working. Key it by route so
 * navigating away resets it. A failed lazy chunk (deploy happened mid-session) offers a full reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Page crashed', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (error === undefined) return this.props.children;
    if (isChunkLoadError(error)) {
      return (
        <ErrorState
          title="A newer version of the console is available"
          body="Reload to fetch the latest build."
          onRetry={() => window.location.reload()}
        />
      );
    }
    return (
      <ErrorState
        title={this.props.title ?? 'This page failed to render'}
        error={error}
        onRetry={() => this.setState({ error: undefined })}
      />
    );
  }
}
