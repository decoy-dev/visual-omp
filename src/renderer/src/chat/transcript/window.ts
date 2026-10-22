/**
 * The transcript's window over a long chat (DESIGN §3.5): it draws the latest entries and loads earlier ones a window at
 * a time as the reader scrolls up. These rules decide when the window moves and which row keeps its place on screen
 * while rows mount above it.
 */

/** Entries one window adds. */
export const WINDOW = 120;
/** Entries the tail window takes in before its start moves on, by this many at once. */
export const WINDOW_STEP = 40;

/**
 * Where the window starts while it follows the end of a chat of `count` entries: the latest `WINDOW` to
 * `WINDOW + WINDOW_STEP - 1` entries. The start moves on by whole steps instead of with every entry, which keeps the
 * first rows, the "Show earlier messages" count and the scrollbar steady while a turn adds entries. Each move drops
 * rows above the view; the transcript keeps the rows on screen in place through it, as it does when earlier rows load.
 */
export function tailStart(count: number): number {
	return Math.max(0, Math.floor((count - WINDOW) / WINDOW_STEP) * WINDOW_STEP);
}

export interface WindowScroll {
	/** The view was pinned to the bottom before this scroll event. */
	wasPinned: boolean;
	/** The view is pinned to the bottom after it. */
	pinned: boolean;
	/** The window keeps its start (the reader scrolled up or loaded earlier entries) instead of following the tail. */
	held: boolean;
	/** The view is close enough to the top to load the previous window. */
	nearTop: boolean;
}

export interface WindowMove {
	/** Follow the tail again: the reader came back to the end. */
	release: boolean;
	/** Keep the current start, so new entries never shift rows out from under the reader. */
	hold: boolean;
	/** Load the previous window above. */
	earlier: boolean;
}

/**
 * What one scroll event does to the window. Only arriving at the bottom releases it, and only a view away from the
 * bottom loads earlier entries. A short window can be at the bottom and near the top at once; if both moves applied
 * there, each would undo the other on every scroll event.
 */
export function windowOnScroll({ wasPinned, pinned, held, nearTop }: WindowScroll): WindowMove {
	if (pinned) return { release: held && !wasPinned, hold: false, earlier: false };
	return { release: false, hold: !held, earlier: nearTop };
}

/** A row's vertical extent, in the same coordinates as the view's. */
export interface RowExtent {
	top: number;
	bottom: number;
}

/**
 * The row that keeps its place while earlier rows mount above it: the lowest drawn row that starts inside the view,
 * else the row across the view's top. The window's first rows can change shape once the entries before them load (a
 * step group extends upward, a reply loses its header), so the anchor sits as far below them as the view allows.
 * Returns -1 when no drawn row is in view. Rows are in document order.
 */
export function anchorRow(rows: readonly RowExtent[], viewTop: number, viewBottom: number): number {
	let anchor = -1;
	for (const [index, row] of rows.entries()) {
		if (row.top >= viewBottom) break;
		if (row.bottom <= row.top || row.bottom <= viewTop) continue;
		if (row.top >= viewTop || anchor === -1) anchor = index;
	}
	return anchor;
}
