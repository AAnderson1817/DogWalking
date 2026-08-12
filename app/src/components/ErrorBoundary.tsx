import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button";
import { StateField } from "./StateField";

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
          <StateField
            tone="attention"
            label="Needs attention"
            title="Something went wrong"
            detail="This screen couldn't be displayed. Try it again."
            role="alert"
            action={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
