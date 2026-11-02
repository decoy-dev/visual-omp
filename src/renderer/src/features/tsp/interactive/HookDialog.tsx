import { walkNodes } from "@shared/tsp/view-state";
import { declaredHookAction, type TspHookAnswer } from "@shared/tsp/dialogs";
import { TSP_ACTIONS } from "@shared/tsp/roles";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NodeView } from "../nodes/NodeView";
import type { NodeContext, NodeProps } from "../nodes/context";
import { Button } from "../../../ui/Button";

/** Arbitration comes from main. A submitted dialog stays disabled until its node departs. */
export function HookDialog({ node, context }: NodeProps) {
	const { t } = useTranslation("palette");
	const field = [...walkNodes(node)].find(child => child.k === "editor" || child.k === "input");
	const observed = field?.p?.text ?? "";
	const [draft, setDraft] = useState(observed);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [closed, setClosed] = useState(false);
	const inFlight = useRef(false);
	useEffect(() => setDraft(observed), [observed]);
	const status = context.questionMatches?.find(match => match.surfaceId === context.sf && match.nodeId === node.id)?.status ?? "unavailable";
	const readOnly = context.readOnly || context.closing || status !== "unmatched" || pending || !context.answer;
	const answer = (value: TspHookAnswer) => {
		if (readOnly || inFlight.current) return;
		inFlight.current = true; setPending(true); setError(null);
		void context.answer!(value).catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			const targetGone = message.includes("TSP preview: The question node is no longer available.") || message.includes("TSP preview: The target surface is no longer available.");
			inFlight.current = targetGone; setPending(targetGone); setClosed(targetGone);
			if (!targetGone) setError(message);
		});
	};
	const childContext: NodeContext = {
		...context, readOnly, hook: { id: node.id, draft, setDraft, fieldId: field?.id, declaredButtons: !!declaredHookAction(node, TSP_ACTIONS.submit) },
		send: event => {
			const target = { sf: context.sf, id: node.id };
			if (event.ev === "activate") answer({ ...target, kind: "choose", target: event.id, item: event.item });
			else if (event.ev === "action") {
				if (event.act === TSP_ACTIONS.cancel || event.act === TSP_ACTIONS.close) answer({ ...target, kind: "cancel" });
				else if (event.act === TSP_ACTIONS.submit && field) answer({ ...target, kind: "text", target: field.id, text: draft, len: observed.length });
				else answer({ ...target, kind: "action", target: event.id, act: event.act });
			}
		},
		keys: () => {},
		render: child => <NodeView key={child.id} node={child} context={childContext} />,
	};
	const label = context.closing ? "hookClosing" : closed ? "hookClosed" : pending || status === "answering" ? "hookAnswering" : status === "matched" ? "hookMatched" : status === "ambiguous" ? "hookAmbiguous" : status === "settling" ? "hookSettling" : context.readOnly ? "hookViewOnly" : "hookReadOnly";
	return <div aria-busy={pending || status === "answering" || status === "settling"}>
		{(readOnly || status !== "unmatched") && <p role="status" className="mb-card rounded-sm bg-inset p-3 text-sm text-fg-muted">{t(`tsp.${label}`)}</p>}
		{error && <p role="alert" className="mb-card whitespace-pre-wrap break-words text-err">{error}</p>}
		<NodeView node={node} context={childContext} />
		{!field && !declaredHookAction(node, TSP_ACTIONS.cancel) && !declaredHookAction(node, TSP_ACTIONS.close) && <Button variant="secondary" disabled={readOnly} onClick={() => answer({ kind: "cancel", sf: context.sf, id: node.id })}>{t("tsp.cancel")}</Button>}
	</div>;
}
