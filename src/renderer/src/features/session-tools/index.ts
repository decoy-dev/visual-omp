import { lazyView } from "../../registry/lazy";
import { chatSlots, sheets } from "../../registry/slots";
import { registerNativeOverlay } from "../palette/overlays";
import { OmpDialogCard } from "./OmpDialogCard";
import { parseOmpDialog } from "./ompDialog";
import { ModelButton, PermissionButton, ThinkingButton } from "./pickers";
import { PlanReviewCard } from "./PlanReviewCard";
import { parsePlanReview } from "./screen";
import "./modes";

chatSlots.register({ id: "session-permission", placement: "composerTools", order: 20, component: PermissionButton });
chatSlots.register({ id: "session-model", placement: "composerTools", order: 70, component: ModelButton });
chatSlots.register({ id: "session-thinking", placement: "composerTools", order: 80, component: ThinkingButton });
chatSlots.register({ id: "session-plan-review", placement: "transcriptEnd", order: 10, component: PlanReviewCard });
chatSlots.register({ id: "session-omp-dialog", placement: "transcriptEnd", order: 20, component: OmpDialogCard });

// The cards above draw these omp screens, so the terminal sheet stays closed for them. The matchers
// claim exactly what the cards render; anything they cannot read still opens the sheet.
registerNativeOverlay(lines => parsePlanReview(lines) !== null);
registerNativeOverlay(lines => parseOmpDialog(lines) !== null);

// The chat map and the session-file parsing behind it load from their own chunk; the sheet slides in once loaded.
sheets.register({ id: "session-tree", component: lazyView(() => import("./TreeSheet").then(m => m.TreeSheet)) });
