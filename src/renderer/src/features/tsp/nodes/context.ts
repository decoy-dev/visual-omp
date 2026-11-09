import type { TspNode } from "@shared/tsp";
import type { TspRendererEvent } from "@shared/tsp-host";
import type { TspHookAnswer } from "@shared/tsp/dialogs";
import type { QuestionMatch } from "@shared/tsp/question-match";
import type { ReactNode } from "react";
export interface NodeContext {
	sf: string;
	hostId?: string;
	generation?: number;
	epoch?: number;
	readOnly: boolean;
	closing?: boolean;
	role?: string;
	questionMatches?: QuestionMatch[];
	answer?(answer: TspHookAnswer): Promise<void>;
	hook?: { id: string; draft: string; setDraft(text: string): void; fieldId?: string; declaredButtons: boolean };
	send(event: TspRendererEvent): void;
	keys(data: string): void;
	render(node: TspNode, readOnly?: boolean): ReactNode;
}
export interface NodeProps { node: TspNode; context: NodeContext }
