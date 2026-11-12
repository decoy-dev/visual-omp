import { Component, type ReactNode } from "react";

/**
 * Keeps a viewer failure inside its bash card: the card falls back to its ordinary command and output instead of
 * the error reaching the window's root and replacing the whole window. React still logs the error to the console.
 */
export class ShellViewBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}
