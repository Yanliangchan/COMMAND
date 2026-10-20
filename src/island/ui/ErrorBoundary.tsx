import { Component, ReactNode } from 'react';

/**
 * A render error inside the match shouldn't blank the page. The match is saved
 * at the start of every round, so the way out is back to the title, where
 * "Continue" picks it up again.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; onReset: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('Island Ops crashed:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="io-modal-backdrop">
        <div className="io-card io-crash" role="alertdialog" aria-labelledby="io-crash-title">
          <h2 id="io-crash-title">Something went wrong</h2>
          <p>The exercise hit an error. Your match was saved at the start of this round — you can pick it up from the main menu.</p>
          <div className="io-actions">
            <button
              className="io-btn io-btn-primary"
              onClick={() => {
                this.setState({ error: null });
                this.props.onReset();
              }}
            >
              Back to main menu
            </button>
          </div>
        </div>
      </div>
    );
  }
}
