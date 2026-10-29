import { describe, expect, it } from "vitest";
import { selfContainedMermaid } from "./mermaid-source";
import { MermaidResourceError } from "./mermaid-policy";

describe("self-contained Mermaid source", () => {
	it.each([
		'flowchart LR\nA@{img: "https://images.example/pixel"}',
		'flowchart LR\nA@{label: "A } label", img: "//images.example/pixel"}',
		'flowchart LR\nA@{shape: image, label: "Preview"}',
		'flowchart LR\nA["<img src=https://images.example/pixel>"]',
		'flowchart LR\nA["![preview](https://images.example/pixel)"]',
		'flowchart LR\nA-->B\nstyle A fill:url(https://images.example/pixel)',
		'flowchart LR\nA-->B;classDef x fill:u\\72l(https://images.example/pixel)',
		'flowchart LR\nA-->B\nlinkStyle 0 stroke:url(//images.example/pixel)',
		String.raw`flowchart LR
A@{ "\u0069mg": "https://images.example/escaped-key" }`,
		String.raw`flowchart LR
A@{ "im\x67": "https://images.example/hex-key" }`,
		String.raw`flowchart LR
A@{ "\U00000069mg": "https://images.example/long-key" }`,
		String.raw`flowchart LR
A@{ "sh\u0061pe": "image" }`,
		String.raw`flowchart LR
A@{
  "\u0069mg": https://images.example/multiline-key
}`,
		'flowchart LR\nA@{type: &resource image, shape: *resource}',
	])("refuses resource-bearing syntax before rendering: %s", source => {
		expect(() => selfContainedMermaid(source)).toThrow(MermaidResourceError);
	});

	it("retains ordinary diagrams, textual URLs, links and static styling", () => {
		const source = 'flowchart LR\nA["https://docs.example"] --> B[Read documentation]\nclick A "https://docs.example"\nclassDef quiet fill:var(--surface),stroke:var(--border)';
		expect(selfContainedMermaid(source)).toBe(source);
	});

	it("decodes metadata labels without mistaking their text for resource properties", () => {
		const source = 'flowchart LR\nA@{label: "Example img: metadata", shape: rect}';
		expect(selfContainedMermaid(source)).toBe(source);
	});

	it("allows a style to reference a definition inside the drawing", () => {
		const source = "flowchart LR\nA --> B\nstyle A fill:url(#local-fill)";
		expect(selfContainedMermaid(source)).toBe(source);
	});

	it("removes source configuration directives and frontmatter before the engine reads them", () => {
		const source = '\n---\nconfig:\n  securityLevel: loose\n---\n%%{init: {"securityLevel":"loose","htmlLabels":true}}%%\nflowchart LR\nA --> B';
		expect(selfContainedMermaid(source)).toContain("flowchart LR");
		expect(selfContainedMermaid(source)).not.toMatch(/loose|htmlLabels|config:/);
	});
});
