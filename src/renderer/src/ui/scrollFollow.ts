/**
 * How `useScrollFollow` (motion.tsx) tells what moved a scroller: its own writes, the reader, or the page's layout.
 * Kept apart from the hook so the rules can be tested without a browser.
 */

/** What moved the view since the follow last knew where it was: the reader moving it up, or any other move. */
export type ScrollMove = "up" | "other";

/**
 * The follow's record of where it left the view. A scroll event is compared with it, so a write the follow made is
 * recognized and a reader's move keeps its direction even when layout shifted the view in between.
 */
export class ScrollLedger {
	/** The `scrollTop` the follow wrote last; a scroll event reporting it is the follow's own. */
	#written: number | null = null;
	/** Where the last scroll event or write left the view, to tell a move up from a move down. */
	#seen = 0;

	/** The follow set `scrollTop` to `top`. */
	wrote(top: number): void {
		this.#written = top;
		this.#seen = top;
	}

	/**
	 * A layout change moved the view by `delta` px (rows mounted or dropped above it while the view kept its rows in
	 * place). Both references move with it, so whatever the reader scrolled before the next scroll event is still
	 * measured from where the reader left the view.
	 */
	shift(delta: number): void {
		this.#seen += delta;
		if (this.#written !== null) this.#written += delta;
	}

	/**
	 * Reads one scroll event at `top`, `distance` px above the bottom. "known" means the view is where the follow left it:
	 * at its own write, or where a reported layout shift moved it. Neither changes the pin, so a window change in a
	 * short chat (where the top and the bottom are both in reach) never pins or unpins the view by itself.
	 */
	read(top: number, distance: number): ScrollMove | "known" {
		if (this.#written !== null && Math.abs(top - this.#written) < 1) return "known";
		this.#written = null;
		if (Math.abs(top - this.#seen) < 0.5) return "known";
		const up = top < this.#seen && distance > 1;
		this.#seen = top;
		return up ? "up" : "other";
	}
}

/**
 * Whether the view is pinned to the bottom after a scroll event the follow did not write. A move up unpins. Any other
 * move keeps a pinned view pinned, since the browser's scroll anchoring can push it down while content grows below,
 * and pins an unpinned view once it is within `threshold` px of the bottom.
 */
export function pinnedAfterScroll(move: ScrollMove, pinned: boolean, distance: number, threshold: number): boolean {
	return move !== "up" && (pinned || distance <= threshold);
}
