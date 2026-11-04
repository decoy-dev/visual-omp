import { createElement } from "react";
import { lazyView } from "../../registry/lazy";
import { setResumeGuard } from "../../registry/guards";
import { chatSlots, globals, sheets, type ChatSlotProps } from "../../registry/slots";
import { registerNativeOverlay } from "../palette/overlays";
import { parseOmpDialog } from "./ompDialog";
import { NativeCardLoading, NativeCardPresentation } from "./NativeCardLoading";
import { ModelButton, PermissionButton, ThinkingButton } from "./pickers";
import { parsePlanReview } from "./screen";
import { isAdvisorConfigure } from "./advisorApply";
import "./modes";

const PlanReviewCard = lazyView(() => import("./PlanReviewCard").then(m => m.PlanReviewCard), NativeCardLoading);
const OmpDialogCard = lazyView(() => import("./OmpDialogCard").then(m => m.OmpDialogCard), NativeCardLoading);

chatSlots.register({ id: "session-permission", placement: "composerTools", order: 20, component: PermissionButton });
chatSlots.register({ id: "session-model", placement: "composerTools", order: 70, component: ModelButton });
chatSlots.register({ id: "session-thinking", placement: "composerTools", order: 80, component: ThinkingButton });
chatSlots.register({ id: "session-plan-review", placement: "transcriptEnd", order: 10,
	component: (props: ChatSlotProps) => createElement(NativeCardPresentation, { ...props, kind: "plan" }, createElement(PlanReviewCard, props)) });
chatSlots.register({ id: "session-omp-dialog", placement: "transcriptEnd", order: 20,
	component: (props: ChatSlotProps) => createElement(NativeCardPresentation, { ...props, kind: "dialog" }, createElement(OmpDialogCard, props)) });

// The cards above draw these omp screens, so the terminal sheet stays closed for them. The matchers
// claim exactly what the cards render; anything they cannot read still opens the sheet.
registerNativeOverlay(lines => parsePlanReview(lines) !== null);
registerNativeOverlay(lines => parseOmpDialog(lines) !== null);
registerNativeOverlay(isAdvisorConfigure);

// The chat map and the session-file parsing behind it load from their own chunk; the sheet slides in once loaded.
sheets.register({ id: "session-tree", component: lazyView(() => import("./TreeSheet").then(m => m.TreeSheet)) });
sheets.register({ id: "session-advisor", component: lazyView(() => import("./AdvisorSheet").then(m => m.AdvisorSheet)) });

// Before omp resumes a very large saved chat, the user chooses to resume it, start a new chat or cancel. The warning
// loads from its own chunk on the first question or in idle time.
const largeResume = () => import("./largeResume");
setResumeGuard(async request => (await largeResume()).askLargeResume(request));
globals.register({ id: "session-large-resume", component: lazyView(() => largeResume().then(m => m.LargeResumeHost)) });
