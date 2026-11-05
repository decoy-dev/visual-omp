/** Keep drive letters and any further colons in omp's reported export path. */
export function parseSessionExportOutput(lines: readonly string[]): { path: string; message: string } | null {
	for (const message of lines) {
		const path = /Session exported to:[ \t]+(\S[^\r\n]*)/i.exec(message)?.[1]?.trim();
		if (path) return { path, message };
	}
	return null;
}
