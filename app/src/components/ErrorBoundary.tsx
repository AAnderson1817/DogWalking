import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="page">
          <h1>Something went wrong</h1>
          <p style={{ color: "var(--text-2)", marginTop: "var(--s-2)" }}>
            {this.state.error.message}
          </p>
          <button
            style={{
              marginTop: "var(--s-4)",
              background: "var(--brand)",
              color: "var(--white)",
              border: 0,
              borderRadius: "var(--r-md)",
              padding: "var(--s-3) var(--s-4)",
              minHeight: 44,
            }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
