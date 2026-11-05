/** Only explicit web/mail links and in-document anchors survive Office preview sanitization. */
export function safeOfficeLink(value: string): boolean {
	if (value.startsWith("#")) return !/[\u0000-\u0020\u007f]/.test(value);
	try { return /^(https?:|mailto:)$/.test(new URL(value).protocol) && !/[\u0000-\u0020\u007f]/.test(value); }
	catch { return false; }
}
