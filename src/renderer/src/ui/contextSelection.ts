interface SelectionRect { left: number; right: number; top: number; bottom: number }
interface TextSelection<T> {
	isCollapsed: boolean;
	rangeCount: number;
	toString(): string;
	getRangeAt(index: number): {
		intersectsNode(node: T): boolean;
		getClientRects(): ArrayLike<SelectionRect>;
	};
}

/** Pointer menus defer only within the selected text's rectangles; keyboard menus use target containment. */
export function selectionContainsTarget<T>(selection: TextSelection<T> | null, target: T, point?: { x: number; y: number }): boolean {
	if (!selection || selection.isCollapsed || selection.toString().length === 0) return false;
	for (let index = 0; index < selection.rangeCount; index++) {
		const range = selection.getRangeAt(index);
		if (!range.intersectsNode(target)) continue;
		if (!point) return true;
		for (const rect of Array.from(range.getClientRects())) {
			if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) return true;
		}
	}
	return false;
}
