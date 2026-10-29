import { describe, expect, it } from "vitest";
import { contentText, fenced, hostNotices, jobPayload, type Notice, parseNotice, parseOmpDuration, stripNoticeMarkup } from "./notices";

const helperResult = [
	"<system-notice>",
	"Background job AdvisorContext has completed. Resume your work using the result below.",
	'<task-result id="AdvisorContext" agent="astra" status="completed" duration="21.1s">',
	'<meta lines="4" size="53B" />',
	"<output>",
	"{",
	'  "verdict": "APPROVED",',
	'  "required_changes": []',
	"}",
	"</output>",
	"</task-result>",
	"",
	"AdvisorContext is now idle — message it via `hub` to follow up; transcript at history://AdvisorContext",
	"</system-notice>",
].join("\n");

const jobs = (notice: Notice) => (notice.kind === "jobs" ? notice.jobs : []);

describe("parseNotice: async-result", () => {
	it("reads a helper job from details and its output from the task-result envelope", () => {
		const notice = parseNotice({
			customType: "async-result",
			content: helperResult,
			details: { jobs: [{ jobId: "AdvisorContext", type: "task", label: "AdvisorContext", durationMs: 21_100 }] },
		});
		expect(jobs(notice)).toEqual([
			{
				id: "AdvisorContext",
				type: "task",
				label: "AdvisorContext",
				durationMs: 21_100,
				durationText: null,
				status: "ok",
				result: '{\n  "verdict": "APPROVED",\n  "required_changes": []\n}',
				truncated: false,
			},
		]);
		expect(jobPayload(jobs(notice)[0]!)).toEqual({ kind: "json", text: '{\n  "verdict": "APPROVED",\n  "required_changes": []\n}' });
	});

	it("marks a failed helper, a preview, and a command that exited non-zero", () => {
		const failed = parseNotice({
			customType: "async-result",
			content:
				'<system-notice>\nBackground job Kimi has completed. Resume your work using the result below.\n<task-result id="Kimi" agent="designer" status="failed (exit 1)" duration="929ms">\n<meta lines="1" size="0B" />\n<output>\n402 membership error\n</output>\n</task-result>\n\nKimi is now idle — message it via `hub` to follow up; transcript at history://Kimi\n</system-notice>',
			details: { jobs: [{ jobId: "Kimi", type: "task", label: "Kimi", durationMs: 931 }] },
		});
		expect(jobs(failed)[0]).toMatchObject({ status: "failed", result: "402 membership error" });

		const preview = parseNotice({
			customType: "async-result",
			content:
				'<system-notice>\nBackground job SolAdvice has completed. Resume your work using the result below.\n<task-result id="SolAdvice" agent="sol" status="completed" duration="2m41s">\n<meta lines="3" size="4.9KB" />\n<preview full-output="agent://SolAdvice">\nFirst lines\n</preview>\n</task-result>\n</system-notice>',
			details: { jobs: [{ jobId: "SolAdvice", type: "task", label: "SolAdvice" }] },
		});
		expect(jobs(preview)[0]).toMatchObject({ truncated: true, result: "First lines", durationMs: 161_000, durationText: null });

		const command = parseNotice({
			customType: "async-result",
			content: "<system-notice>\nBackground job bg_4 has completed. Resume your work using the result below.\nTraceback\n\nWall time: 0.11 seconds\n\nCommand exited with code 1\n</system-notice>",
			details: { jobs: [{ jobId: "bg_4", type: "bash", label: "python3 check.py", durationMs: 110 }] },
		});
		expect(jobs(command)[0]).toMatchObject({ type: "bash", status: "failed", result: "Traceback\n\nWall time: 0.11 seconds\n\nCommand exited with code 1" });
		expect(jobPayload(jobs(command)[0]!).kind).toBe("code");
	});

	it("splits a batch at each job header, including a command label that spans lines", () => {
		const content = [
			"<system-notice>",
			"2 background jobs have completed. Resume your work using the results below.",
			"",
			"── Job bg_3 (cat > /tmp/x.sh <<'EOF'",
			"echo hi) ──",
			"hi",
			"Wall time: 0.02 seconds",
			"── Job Sec05 (Sec05) ──",
			'<task-result id="Sec05" agent="task" status="completed" duration="3m">',
			"<output>",
			"Rewrote section 5.",
			"</output>",
			"</task-result>",
			"</system-notice>",
		].join("\n");
		const notice = parseNotice({
			customType: "async-result",
			content,
			details: {
				jobs: [
					{ jobId: "bg_3", type: "bash", label: "cat > /tmp/x.sh <<'EOF'\necho hi", durationMs: 20 },
					{ jobId: "Sec05", type: "task", label: "Sec05", durationMs: 179_388 },
				],
			},
		});
		expect(jobs(notice).map(job => [job.id, job.type, job.status, job.result])).toEqual([
			["bg_3", "bash", "ok", "hi\nWall time: 0.02 seconds"],
			["Sec05", "task", "ok", "Rewrote section 5."],
		]);
	});

	it("prefers the helper's own run time and status over the delivery's details (real woken-helper entry)", () => {
		// ~/.omp/agent/sessions/-visual-omp/2026-09-30T21-01-10-835Z_…jsonl line 1222: woken for a second round, the
		// delivery measured 6ms while the envelope reports the helper's 21.1s run.
		const notice = parseNotice({
			customType: "async-result",
			content: helperResult.replace("\n\nAdvisorContext is now idle — message it via `hub` to follow up; transcript at history://AdvisorContext", ""),
			details: { meta: { source: { type: "report", value: "background job delivery" } }, jobs: [{ jobId: "AdvisorContext", type: "task", label: "AdvisorContext", durationMs: 6 }] },
		});
		expect(jobs(notice)).toMatchObject([{ id: "AdvisorContext", durationMs: 21_100, durationText: null, status: "ok" }]);
		const failed = parseNotice({
			customType: "async-result",
			content: helperResult.replace('status="completed"', 'status="aborted"'),
			details: { jobs: [{ jobId: "AdvisorContext", type: "task", durationMs: 6 }] },
		});
		expect(jobs(failed)[0]?.status).toBe("stopped");
	});

	it("rejects negative durations and keeps subsecond ones", () => {
		const content = "<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\nok\n</system-notice>";
		expect(jobs(parseNotice({ customType: "async-result", content, details: { jobs: [{ jobId: "bg_1", type: "bash", durationMs: -5 }] } }))[0]?.durationMs).toBeNull();
		expect(jobs(parseNotice({ customType: "async-result", content, details: { jobs: [{ jobId: "bg_1", type: "bash", durationMs: 110 }] } }))[0]?.durationMs).toBe(110);
	});

	it("pairs details without a job id with the content, and keeps output whose id the details do not name", () => {
		const content = [
			"<system-notice>",
			"2 background jobs have completed. Resume your work using the results below.",
			"",
			"── Job bg_1 (npm test) ──",
			"12 passed",
			"── Job bg_2 (npm run build) ──",
			"built in 3s",
			"</system-notice>",
		].join("\n");
		const missing = parseNotice({ customType: "async-result", content, details: { jobs: [{ type: "bash", label: "npm test" }, { type: "bash", label: "npm run build" }] } });
		expect(jobs(missing).map(job => [job.id, job.label, job.result])).toEqual([
			["bg_1", "npm test", "12 passed"],
			["bg_2", "npm run build", "built in 3s"],
		]);
		const mismatched = parseNotice({ customType: "async-result", content, details: { jobs: [{ jobId: "bg_2", type: "bash", label: "npm run build", durationMs: 3000 }, { jobId: "bg_9", type: "bash" }] } });
		expect(jobs(mismatched).map(job => [job.id, job.label, job.durationMs, job.result])).toEqual([
			["bg_1", null, null, "12 passed"],
			["bg_2", "npm run build", 3000, "built in 3s"],
			["bg_9", null, null, null],
		]);
		const single = parseNotice({ customType: "async-result", content: helperResult, details: { jobs: [{ type: "task", label: "Review the plan" }] } });
		expect(jobs(single)).toMatchObject([{ id: "AdvisorContext", label: "Review the plan", status: "ok", result: '{\n  "verdict": "APPROVED",\n  "required_changes": []\n}' }]);
	});

	it("falls back to the wrapper text when details are missing", () => {
		const notice = parseNotice({ customType: "async-result", content: helperResult });
		expect(jobs(notice)).toMatchObject([{ id: "AdvisorContext", type: "task", label: null, durationMs: 21_100, durationText: null, status: "ok" }]);
	});
});

describe("parseOmpDuration", () => {
	it("reads every shape omp's formatDuration writes and rejects anything else", () => {
		expect(parseOmpDuration("929ms")).toBe(929);
		expect(parseOmpDuration("21.1s")).toBe(21_100);
		expect(parseOmpDuration("2m41s")).toBe(161_000);
		expect(parseOmpDuration("3m")).toBe(180_000);
		expect(parseOmpDuration("1h3m")).toBe(3_780_000);
		expect(parseOmpDuration("2d4h")).toBe(187_200_000);
		expect(parseOmpDuration("soon")).toBeNull();
		expect(parseOmpDuration("2m 41s")).toBeNull();
		expect(parseOmpDuration("")).toBeNull();
	});
});

describe("parseNotice: other types", () => {
	it("reads IRC from details, and from the wrapper without them", () => {
		const content =
			"<irc>\nIncoming IRC message from agent `ProofFaq`:\n\nPlease migrate **cta.quote**.\n\nSent while waiting/working. Active interruptible wait stopped early for immediate reading.\n\nIf response expected, reply via `hub` (`op: \"send\"`, `to: \"ProofFaq\"`); may finish current step first. No one replies on your behalf.\n</irc>";
		expect(parseNotice({ customType: "irc:incoming", content, details: { id: "1", from: "ProofFaq", message: "Please migrate **cta.quote**." } })).toEqual({
			kind: "irc",
			mode: "incoming",
			from: "ProofFaq",
			to: null,
			body: "Please migrate **cta.quote**.",
		});
		expect(parseNotice({ customType: "irc:incoming", content })).toEqual({ kind: "irc", mode: "incoming", from: "ProofFaq", to: null, body: "Please migrate **cta.quote**." });
		expect(parseNotice({ customType: "irc:relay", content: "[IRC `A` → `B`]\n\nhello" })).toEqual({ kind: "irc", mode: "relay", from: "A", to: "B", body: "hello" });
		expect(parseNotice({ customType: "irc:autoreply", content: "x", details: { to: "Main", body: "On it" } })).toMatchObject({ mode: "autoreply", to: "Main", body: "On it" });
	});

	it("reads process exits from details, and from omp's sentence without them", () => {
		const details = { daemons: [{ name: "lp-static", state: "failed", exitCode: 1 }, { name: "vomp-dev", state: "exited", exitCode: 0 }] };
		const content = "Supervised process lp-static failed with exit code 1.\nSupervised process vomp-dev exited with exit code 0.";
		const expected = {
			kind: "launch",
			processes: [
				{ name: "lp-static", exitCode: 1, failed: true, text: "Supervised process lp-static failed with exit code 1." },
				{ name: "vomp-dev", exitCode: 0, failed: false, text: "Supervised process vomp-dev exited with exit code 0." },
			],
		};
		expect(parseNotice({ customType: "launch-completion", content, details })).toEqual(expected);
		expect(parseNotice({ customType: "launch-completion", content })).toEqual(expected);
	});

	it("reads advisor notes from details, and from advisory tags without them", () => {
		const content = '<advisory severity="blocker" guidance="weigh, don&apos;t blindly obey">\nDo not add the 87% stat.\n</advisory>\n<advisory guidance="x">\nMinor &lt;b&gt; issue\n</advisory>';
		expect(parseNotice({ customType: "advisor", content, details: { notes: [{ note: "Do not add the 87% stat.", severity: "blocker" }] } })).toEqual({
			kind: "advisor",
			notes: [{ note: "Do not add the 87% stat.", severity: "blocker", advisor: null }],
		});
		expect(parseNotice({ customType: "advisor", content })).toEqual({
			kind: "advisor",
			notes: [
				{ note: "Do not add the 87% stat.", severity: "blocker", advisor: null },
				{ note: "Minor <b> issue", severity: null, advisor: null },
			],
		});
	});

	it("reads a skill prompt and keeps only the skill text", () => {
		const content = [
			'[IMPORTANT: User invoked the "prompt-engineer" skill; follow its instructions. Full skill below.]',
			"",
			"# Prompt Engineer",
			"",
			"Body.",
			"",
			"---",
			"",
			"[Skill directory: /Users/x/.claude/skills/prompt-engineer]",
			"Resolve relative paths in this skill against this absolute directory.",
			"User: make it   sharper",
		].join("\n");
		const expected = { kind: "skill", name: "prompt-engineer", args: "make it sharper", path: null, text: "# Prompt Engineer\n\nBody." };
		expect(parseNotice({ customType: "skill-prompt", content: [{ type: "text", text: content }] })).toEqual(expected);
		expect(parseNotice({ customType: "skill-prompt", content, details: { name: "prompt-engineer", path: "/p/SKILL.md", args: "make it   sharper", lineCount: 3 } })).toEqual({
			...expected,
			path: "/p/SKILL.md",
		});
	});

	it("strips omp's wrapper from an unknown notice", () => {
		expect(parseNotice({ customType: "handoff", content: "<system-notice>\nThe build finished.\n</system-notice>" })).toEqual({ kind: "other", text: "The build finished." });
	});
});

describe("stripNoticeMarkup", () => {
	it("keeps the payload of every wrapper omp uses", () => {
		expect(stripNoticeMarkup(helperResult)).toBe('{\n  "verdict": "APPROVED",\n  "required_changes": []\n}');
		expect(stripNoticeMarkup('[Wait interrupted by message]\n<irc from="parent" agent="Main">\nMigrated the quote.\n</irc>')).toBe("Migrated the quote.");
		expect(stripNoticeMarkup("<system-reminder>\nToday is Monday.\n</system-reminder>")).toBe("Today is Monday.");
		expect(stripNoticeMarkup("Plain text with <b>html</b> stays.")).toBe("Plain text with <b>html</b> stays.");
	});
});

describe("fenced", () => {
	it("uses a fence longer than any backtick run in the text", () => {
		expect(fenced("a ``` b", "json")).toBe("````json\na ``` b\n````");
		expect(fenced("plain")).toBe("```\nplain\n```");
	});
});

describe("contentText", () => {
	it("joins text blocks by line and adds nothing for images", () => {
		const image = { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" };
		// omp saves a message with pasted images as its text followed by one block per image.
		expect(contentText([{ type: "text", text: "[Image #1, 398x406] [Image #2, 477x200] Look at these." }, image, image])).toBe(
			"[Image #1, 398x406] [Image #2, 477x200] Look at these.",
		);
		expect(contentText([image, { type: "text", text: "first" }, image, { type: "text", text: "second" }])).toBe("first\nsecond");
		expect(contentText([image])).toBe("");
		expect(contentText("plain")).toBe("plain");
	});
});

it("orders recap and startup side notices, preserving text and deduplicating ids", () => {
	const recap = { id: "recap:1", kind: "recap" as const, timestamp: 20, text: "Resume the next change." };
	const startup = { id: "startup:1", kind: "startup" as const, timestamp: 10, text: "Default model unavailable. Using provider/model." };
	expect(hostNotices([recap, startup, recap])).toEqual([startup, recap]);
	expect(hostNotices(undefined)).toEqual([]);
});
