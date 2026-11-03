export type BtwStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";
export interface BtwInputScope { generation: number; epoch: number }
/** An omp record id is unique only inside its owning history directory. */
export interface BtwTopicRef { id: string; scope?: string }

export interface BtwTurn {
	question: string;
	answer: string;
	status: BtwStatus;
	createdAt: number;
	updatedAt?: number;
	error?: string;
	inject?: { text: string; sent: boolean };
}

export interface BtwTopic extends BtwTopicRef {
	title: string;
	turns: BtwTurn[];
	live: boolean;
}

export interface BtwState {
	hostId: string;
	generation: number;
	revision: number;
	epoch: number;
	topics: BtwTopic[];
	overlay: {
		epoch: number;
		surfaceId: string;
		nodeId: string;
		selectedTopic: BtwTopicRef | null;
		/** Topics established as belonging to this exact omp overlay's history scope. */
		topics: BtwTopicRef[];
		actions: string[];
		followUp: boolean;
		supported: boolean;
		notice: string | null;
		draft: string | null;
	} | null;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		"btw:list": { args: [hostId: string]; result: BtwState };
		"btw:select": { args: [hostId: string, topic: BtwTopicRef, scope: BtwInputScope]; result: void };
		"btw:ask": { args: [hostId: string, question: string, scope: BtwInputScope]; result: void };
		"btw:followUp": { args: [hostId: string, topic: BtwTopicRef, text: string, scope: BtwInputScope]; result: void };
		"btw:stop": { args: [hostId: string, topic: BtwTopicRef, scope: BtwInputScope]; result: void };
		"btw:close": { args: [hostId: string, topic: BtwTopicRef | null, scope: BtwInputScope]; result: void };
		"btw:inject": { args: [hostId: string, topic: BtwTopicRef, scope: BtwInputScope]; result: void };
	}
	interface IpcEventMap {
		"btw:changed": BtwState;
	}
}
