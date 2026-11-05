import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VisualProofsStatus } from "@shared/contracts/skills";
import { analyzeSkillFile } from "../features/skills/parse";
import { ompAgentDir } from "../omp/config-file";

export const VISUAL_PROOFS_VERSION = 1;
export const VISUAL_PROOFS_SKILL = `---
name: visual-proofs
description: Before a long render or credit-consuming visual generation, make the cheapest useful proof and ask the person whether to continue. Applies to videos, long documents, slide decks, generated images and 3D outputs.
managed-by: visual-omp
managed-version: 1
---

# Visual proofs

Before starting a long render or a visual generation that costs provider credits, make the cheapest useful proof with tools already available. Do not install a renderer or start a paid request without the person's permission.

- For a document, make its first page. For a deck, make its first two slides.
- For video, make three to five representative key frames using Remotion still or ffmpeg with -ss <t> -frames:v 1. Avoid running the full render to obtain the proof.
- For a generated image or 3D output, use a low-resolution or low-quality draft when the provider supports it. Explain any charge before requesting a paid proof and explain that the final generation may differ.

Save proofs in a proofs/ folder beside the intended output. Print each proof's absolute path so the person can view it.

Before continuing, check that the proof files exist, their paths were printed, and the full render has not started. Call the ask tool with the exact question: "The proof is ready. Continue with the full render?" Offer Yes and No. Wait for the person's explicit answer before starting any full render, expensive conversion or final provider request. Do not launch that work in parallel with the question or as a background job.

Continue only after an explicit Yes. If the answer is No, cancelled, missing or interrupted, stop without rendering. If the person requests changes, revise the proof and ask again. Never treat silence, a timeout or unrelated feedback as approval.
`;

interface ProofsDependencies {
	getEnabled(): boolean;
	setEnabled(enabled: boolean): void;
	/** Reuses the existing omp skill service's native user-source filtering. */
	availability(): Promise<"skillsDisabled" | "ignored" | null>;
	changed(): void;
	agentDir?: () => Promise<string>;
}

interface Snapshot { content: string; ino: number; size: number; mtimeMs: number }
const unavailable = (): VisualProofsStatus => ({ state: "unavailable", reason: "unreadable" });

/** Owns only the marked SKILL.md, discovered and loaded by omp's existing skill mechanism. */
export class VisualProofsService {
	readonly #deps: ProofsDependencies;
	#pending: Promise<unknown> = Promise.resolve();
	constructor(deps: ProofsDependencies) { this.#deps = deps; }

	#serialized<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#pending.catch(() => {}).then(work);
		this.#pending = next;
		return next;
	}

	async #path(): Promise<string> {
		return join(await (this.#deps.agentDir ?? ompAgentDir)(), "skills", "visual-proofs", "SKILL.md");
	}

	async #read(file: string): Promise<Snapshot | null> {
		try {
			// Never replace a linked skill directory or follow a linked file for mutation.
			const folder = await lstat(dirname(file));
			if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("Linked skill directory");
			const info = await lstat(file);
			if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Unreadable skill file");
			return { content: await readFile(file, "utf8"), ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	#metadata(snapshot: Snapshot): Record<string, unknown> {
		return analyzeSkillFile(snapshot.content, "visual-proofs").frontmatter;
	}

	#conflict(path: string): VisualProofsStatus {
		this.#deps.setEnabled(false);
		return { state: "conflict", path };
	}

	async #status(file: string, snapshot: Snapshot | null): Promise<VisualProofsStatus> {
		if (snapshot && this.#metadata(snapshot)["managed-by"] !== "visual-omp") return this.#conflict(file);
		if (!this.#deps.getEnabled()) return { state: "off" };
		const reason = await this.#deps.availability();
		if (reason) return { state: "unavailable", reason };
		const version = snapshot ? this.#metadata(snapshot)["managed-version"] : undefined;
		return { state: typeof version === "number" && Number.isInteger(version) && version >= VISUAL_PROOFS_VERSION ? "on" : "outdated" };
	}

	status(): Promise<VisualProofsStatus> {
		return this.#serialized(async () => {
			try { const file = await this.#path(); return await this.#status(file, await this.#read(file)); }
			catch { return unavailable(); }
		});
	}

	/** Repair missing or older managed files on startup only when the person opted in. */
	sync(): Promise<VisualProofsStatus> {
		return this.#serialized(() => this.#set(this.#deps.getEnabled(), true));
	}

	set(enabled: boolean): Promise<VisualProofsStatus> {
		if (typeof enabled !== "boolean") return Promise.reject(new Error("A boolean proof setting is required."));
		return this.#serialized(() => this.#set(enabled, false));
	}

	async #set(enabled: boolean, startup: boolean): Promise<VisualProofsStatus> {
		let temporary: string | null = null;
		try {
			const file = await this.#path();
			const previous = await this.#read(file);
			if (previous && this.#metadata(previous)["managed-by"] !== "visual-omp") return this.#conflict(file);
			if (startup && !enabled) return { state: "off" };
			const reason = enabled ? await this.#deps.availability() : null;
			if (reason && !startup) return { state: "unavailable", reason };
			const version = previous ? this.#metadata(previous)["managed-version"] : undefined;
			const needsWrite = enabled && (typeof version !== "number" || !Number.isInteger(version) || version < VISUAL_PROOFS_VERSION);
			if (needsWrite) {
				await mkdir(dirname(file), { recursive: true });
				temporary = join(dirname(file), `.visual-omp-${randomUUID()}.tmp`);
				await writeFile(temporary, VISUAL_PROOFS_SKILL, { flag: "wx", mode: 0o600 });
			}
			if (needsWrite || (!enabled && previous)) {
				const current = await this.#read(file);
				if (current?.content !== previous?.content || current?.ino !== previous?.ino || current?.mtimeMs !== previous?.mtimeMs || current?.size !== previous?.size) {
					return current && this.#metadata(current)["managed-by"] !== "visual-omp" ? this.#conflict(file) : unavailable();
				}
				if (temporary) {
					if (previous) await rename(temporary, file);
					// An absent target is published without clobbering a file created meanwhile.
					else await link(temporary, file);
				} else await unlink(file);
				this.#deps.changed();
			}
			this.#deps.setEnabled(enabled);
			return reason ? { state: "unavailable", reason } : { state: enabled ? "on" : "off" };
		} catch { return unavailable(); }
		finally { if (temporary) await unlink(temporary).catch(() => {}); }
	}
}
