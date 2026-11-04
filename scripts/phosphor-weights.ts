/** Definition module names in @phosphor-icons/react/dist/defs/<Name>.es.js.
 * Regular is always retained. Icon-suffixed exports share these definitions.
 * scripts/phosphor-weights.test.ts keeps this list equal to renderer usage.
 */
export const phosphorExtraWeights: Readonly<Record<string, readonly string[]>> = {
	Broadcast: ["bold"],
	ChatCircle: ["bold"],
	Check: ["bold"],
	CheckCircle: ["fill"],
	Checks: ["bold"],
	CheckSquare: ["fill"],
	Circle: ["bold"],
	CircleHalf: ["fill"],
	CircleNotch: ["bold"],
	ClockCounterClockwise: ["bold"],
	DotsSixVertical: ["bold"],
	DotsThree: ["bold"],
	DownloadSimple: ["bold"],
	Folder: ["fill"],
	Minus: ["bold"],
	Plus: ["bold"],
	Power: ["bold"],
	Question: ["bold"],
	Robot: ["bold"],
	Sparkle: ["fill"],
	Square: ["fill"],
	Warning: ["fill"],
	WarningCircle: ["fill"],
	X: ["bold"],
	XCircle: ["bold", "fill"],
};
