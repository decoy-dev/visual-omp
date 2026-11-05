import type { AppInstallOperation } from "@shared/contracts/updates";

/** Updates, reinstalls and Homebrew transfers share one installation at a time. */
export class InstallOperation {
	current: AppInstallOperation | null = null;
	constructor(private readonly changed: (operation: AppInstallOperation | null) => void) {}

	begin(operation: AppInstallOperation): void {
		if (this.current) throw new Error(`A visual-omp ${this.current} operation is in progress. Wait for it to finish before starting another installation.`);
		this.current = operation;
		this.changed(operation);
	}

	end(operation: AppInstallOperation): void {
		if (this.current !== operation) return;
		this.current = null;
		this.changed(null);
	}
}
