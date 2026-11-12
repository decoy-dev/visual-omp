import { createContext, type PropsWithChildren, useContext, useMemo } from "react";

/** A main transcript alone owns live shell actions. Helper and saved views omit this scope. */
export interface LiveShellScope {
	hostId: string;
	generation: number;
	epoch: number;
	readOnly: boolean;
}
const ShellScope = createContext<LiveShellScope | null>(null);

export function LiveShellProvider({ hostId, generation, epoch, readOnly, children }: PropsWithChildren<LiveShellScope>) {
	const scope = useMemo(() => ({ hostId, generation, epoch, readOnly }), [hostId, generation, epoch, readOnly]);
	return <ShellScope.Provider value={scope}>{children}</ShellScope.Provider>;
}

export function useLiveShellScope(): LiveShellScope | null {
	return useContext(ShellScope);
}
