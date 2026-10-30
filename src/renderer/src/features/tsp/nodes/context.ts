import type { TspNode } from "@shared/tsp";
import type { TspRendererEvent } from "@shared/tsp-host";
import type { ReactNode } from "react";
export interface NodeContext {
	sf: string;
	hostId?: string;
	readOnly: boolean;
	role?: string;
	send(event: TspRendererEvent): void;
	keys(data: string): void;
	render(node: TspNode, readOnly?: boolean): ReactNode;
}
export interface NodeProps { node: TspNode; context: NodeContext }
