import { Component, type ErrorInfo, type ReactNode } from "react";

interface PromptRowBoundaryProps {
  children: ReactNode;
  /** What the row shows instead once its children have thrown. */
  fallback: ReactNode;
}

interface PromptRowBoundaryState {
  failed: boolean;
}

/**
 * Keeps one prompt row's failure, including React's update-depth limit (#185) from a
 * measurement loop, inside that row. The row shows its fallback and the rest of the chat
 * keeps working. Each boundary logs its failure once.
 */
export class PromptRowBoundary extends Component<PromptRowBoundaryProps, PromptRowBoundaryState> {
  state: PromptRowBoundaryState = { failed: false };

  static getDerivedStateFromError(): PromptRowBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(
      "[Sticky prompts] A prompt row fell back to its plain message",
      error,
      info.componentStack,
    );
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
