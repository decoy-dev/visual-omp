export class MermaidResourceError extends Error {
	constructor() { super("Mermaid source contains image resources or resource-bearing styles"); }
}
