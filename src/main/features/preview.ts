import { registerPreviewProtocol } from "../services/preview-protocol";
import { registerPreviewWatch } from "../services/preview-watch";

/** Live previews of visual outputs: the `vomp-preview:` protocol and the preview watcher (docs/LIVE-PREVIEW.md). */
export function register(): void {
	registerPreviewProtocol();
	registerPreviewWatch();
}
