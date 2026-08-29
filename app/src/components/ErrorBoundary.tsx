import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button";
import { BrandLogo } from "./BrandLogo";
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
        // `page--centered` (review L16): a crash screen that lands top-left
        // in an empty page with no mark on it reads as the app having fallen
        // over rather than as the app telling you something.
        <div className="page page--centered">
          <div>
            <BrandLogo className="brand-logo--small" />
            <StateField
              tone="attention"
              label="Needs attention"
              title="Something went wrong"
              detail="This screen couldn't be displayed. Try it again."
              role="alert"
              action={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}
            />
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
