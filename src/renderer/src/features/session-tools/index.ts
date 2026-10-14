import { chatSlots, sheets } from "../../registry/slots";
import { ModelButton, PermissionButton, ThinkingButton } from "./pickers";
import { PlanReviewCard } from "./PlanReviewCard";
import { TreeSheet } from "./TreeSheet";
import "./modes";

chatSlots.register({ id: "session-permission", placement: "composerTools", order: 20, component: PermissionButton });
chatSlots.register({ id: "session-model", placement: "composerTools", order: 70, component: ModelButton });
chatSlots.register({ id: "session-thinking", placement: "composerTools", order: 80, component: ThinkingButton });
chatSlots.register({ id: "session-plan-review", placement: "transcriptEnd", order: 10, component: PlanReviewCard });

sheets.register({ id: "session-tree", component: TreeSheet });
