export function videoCommand(prores?: boolean, regular?: boolean): string;

export function startFixture(options: {
	root: string;
	port?: number;
	durationMs?: number;
	onRequest?: (request: { id: number; fixture: string | undefined; afterTool: boolean; tools: string[] }) => void;
	initializeProfile?: boolean;
}): Promise<{ baseUrl: string; close(): Promise<void> }>;
