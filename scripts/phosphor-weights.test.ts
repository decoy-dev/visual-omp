import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { phosphorExtraWeights } from "./phosphor-weights";

type Policy = Readonly<Record<string, readonly string[]>>;
type Binding = { imported: string; namespace?: boolean } | { value: Node } | { component: true; factory?: true } | { reactCall: true } | null;
const phosphor = dirname(createRequire(import.meta.url).resolve("@phosphor-icons/react"));
const renderer = resolve(import.meta.dirname, "../src/renderer/src");
type Boundary = { file: string; shape: string; reason: string };
const nonIconBoundaries: Boundary[] = [
	{ file: "features/live-preview/Stage.tsx", shape: "adapter.Frame", reason: "LiveAdapter.Frame renders a file-format preview with LiveFrameProps." },
	{ file: "registry/lazy.tsx", shape: "use(preload())", reason: "lazyView loads a registered view component with its generic page props." },
	{ file: "registry/lazy.tsx", shape: "Fallback", reason: "lazyView's fallback is the caller's page or section loading component." },
	{ file: "registry/lazy.tsx", shape: "Failure", reason: "lazyView's failure state is the caller's page or section failure component." },
];

function children(node: Node): Node[] {
	return Object.values(node).flatMap(value => {
		const values: unknown[] = Array.isArray(value) ? value : [value];
		return values.filter((child): child is Node => !!child && typeof child === "object" && "type" in child);
	});
}
function key(node: Node): string | undefined {
	if ((node.type !== "ObjectProperty" && node.type !== "ObjectMethod") || node.computed) return;
	return node.key.type === "Identifier" ? node.key.name : node.key.type === "StringLiteral" ? node.key.value : undefined;
}

/** Extra weights must be explicit JSX props. Icon/context props cannot use dynamic object construction. */
function inspect(source: string, file: string, policy: Policy, used: Set<string>, boundaries: Boundary[], matched: Set<Boundary>): string[] {
	const ast = parse(source, { sourceType: "module", plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] });
	const nodes: Node[] = [];
	const parents = new Map<Node, Node>();
	const bindings = new Map<string, Binding>();
	const errors: string[] = [];
	const alternatives = new Map<string, Binding[]>();
	function fail(node: Node, message: string) { errors.push(`${file}:${node.loc?.start.line}: ${message}`); }
	function bind(name: string, binding: Binding) {
		// Repeated declarations and shadowed imports are ambiguous under this convention.
		alternatives.set(name, [...(alternatives.get(name) ?? []), binding]);
		bindings.set(name, bindings.has(name) ? null : binding);
	}
	function pattern(node: Node) {
		if (node.type === "Identifier") bind(node.name, null);
		else if (node.type === "ObjectProperty") pattern(node.value);
		else if (node.type === "AssignmentPattern") pattern(node.left);
		else if (node.type === "ObjectPattern") for (const prop of node.properties) pattern(prop);
		else if (node.type === "ArrayPattern") for (const element of node.elements) { if (element) pattern(element); }
		else if (node.type === "RestElement") pattern(node.argument);
		else if (node.type === "TSParameterProperty") pattern(node.parameter);
	}
	function visit(node: Node) {
		nodes.push(node);
		if (node.type === "ImportDeclaration") for (const specifier of node.specifiers) {
			if (node.source.value === "@phosphor-icons/react" && node.importKind !== "type") {
				if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type") bind(specifier.local.name, { imported: specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value });
				else if (specifier.type === "ImportNamespaceSpecifier") bind(specifier.local.name, { imported: "*", namespace: true });
			} else if (node.source.value === "react" && specifier.type === "ImportSpecifier" && specifier.imported.type === "Identifier" && ["createElement", "cloneElement"].includes(specifier.imported.name)) bind(specifier.local.name, { reactCall: true });
			else if (specifier.type === "ImportSpecifier" && specifier.imported.type === "Identifier" && ((node.source.value === "react" && ["lazy", "memo", "forwardRef"].includes(specifier.imported.name)) || (/\/lazy$/.test(node.source.value) && specifier.imported.name === "lazyView"))) bind(specifier.local.name, { component: true, factory: true });
			else bind(specifier.local.name, { component: true });
		}
		if (node.type === "VariableDeclarator") {
			const declaration = parents.get(node);
			if (node.id.type === "Identifier" && node.init && declaration?.type === "VariableDeclaration" && declaration.kind === "const") bind(node.id.name, { value: node.init });
			else pattern(node.id);
		}
		if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "ObjectMethod" || node.type === "ClassMethod" || node.type === "ClassPrivateMethod") {
			for (const param of node.params) pattern(param);
			if ("id" in node && node.id) bind(node.id.name, { component: true });
		}
		if (node.type === "CatchClause" && node.param) pattern(node.param);
		if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.id) bind(node.id.name, { component: true });
		for (const child of children(node)) { parents.set(child, node); visit(child); }
	}
	visit(ast);
	function unwrap(node: Node, seen = new Set<string>()): Node | undefined {
		if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression" || node.type === "TSNonNullExpression" || node.type === "ParenthesizedExpression") return unwrap(node.expression, seen);
		if (node.type !== "Identifier" && node.type !== "JSXIdentifier") return node;
		if (seen.has(node.name)) return;
		const binding = bindings.get(node.name);
		return binding && "value" in binding ? unwrap(binding.value, new Set([...seen, node.name])) : node;
	}
	function imported(node: Node, seen = new Set<string>()): string | undefined {
		if (node.type === "Identifier" || node.type === "JSXIdentifier") {
			if (seen.has(node.name)) return;
			const binding = bindings.get(node.name);
			if (binding && "value" in binding) return imported(binding.value, new Set([...seen, node.name]));
			return binding && "imported" in binding ? binding.imported : undefined;
		}
		if (node.type === "JSXMemberExpression" || (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier")) {
			const base = imported(node.object, seen);
			const name = node.property.type === "Identifier" || node.property.type === "JSXIdentifier" ? node.property.name : undefined;
			if (base && name) return base === "*" ? name : `${base}.${name}`;
		}
		return;
	}
	function icons(node: Node): string[] | undefined {
		const name = imported(node);
		if (name) {
			const definition = name.endsWith("Icon") ? name.slice(0, -4) : name;
			return existsSync(join(phosphor, "defs", `${definition}.es.js`)) ? [definition] : undefined;
		}
		const value = unwrap(node);
		if (value?.type === "ConditionalExpression") {
			const yes = icons(value.consequent), no = icons(value.alternate);
			return yes && no ? [...yes, ...no] : undefined;
		}
		return;
	}
	function weights(node: Node): string[] | undefined {
		const value = unwrap(node);
		if (value?.type === "StringLiteral") return [value.value];
		if (value?.type === "NullLiteral") return ["regular"];
		if (value?.type === "ConditionalExpression") {
			const yes = weights(value.consequent), no = weights(value.alternate);
			return yes && no ? [...yes, ...no] : undefined;
		}
		return;
	}
	function component(node: Node, seen = new Set<string>(), native = true): boolean {
		if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression" || node.type === "TSNonNullExpression") return component(node.expression, seen);
		if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return true;
		if (node.type === "Identifier" || node.type === "JSXIdentifier") {
			if (native && node.type === "JSXIdentifier" && node.name[0] === node.name[0]?.toLowerCase()) return true;
			if (seen.has(node.name)) return false;
			const candidates = alternatives.get(node.name) ?? [];
			const next = new Set([...seen, node.name]);
			return candidates.length > 0 && candidates.every(binding => !!binding && ("component" in binding || ("value" in binding && component(binding.value, next, false))));
		}
		if (node.type === "JSXMemberExpression" || node.type === "MemberExpression") return component(node.object, seen, false);
		if (node.type === "CallExpression" && node.callee.type === "Identifier") {
			const binding = bindings.get(node.callee.name);
			return !!binding && "factory" in binding;
		}
		return false;
	}
	function boundary(target: Node): boolean {
		const shape = source.slice(target.start ?? 0, target.end ?? 0).replace(/\s+/g, "");
		const entry = boundaries.find(entry => entry.file === file && entry.shape.replace(/\s+/g, "") === shape);
		if (entry) matched.add(entry);
		return !!entry;
	}
	function reactCall(node: Node, seen = new Set<string>()): boolean {
		if (node.type === "Identifier") {
			if (seen.has(node.name)) return false;
			const binding = bindings.get(node.name);
			if (binding && "value" in binding) return reactCall(binding.value, new Set([...seen, node.name]));
			return !!binding && "reactCall" in binding || ["createElement", "cloneElement"].includes(node.name);
		}
		if (node.type === "MemberExpression") {
			const name = node.property.type === "Identifier" && !node.computed ? node.property.name : node.property.type === "StringLiteral" ? node.property.value : "";
			return ["createElement", "cloneElement"].includes(name);
		}
		return false;
	}
	function check(node: Node, value: Node, target?: Node) {
		const values = weights(value);
		if (!values) { fail(node, "Cannot resolve icon weight. Use literal weights or conditional literal branches."); return; }
		for (const weight of new Set(values)) {
			if (weight === "regular") continue;
			const definitions = target && icons(target);
			if (!definitions) { fail(node, `Cannot resolve icon for ${weight} weight. Use explicit Phosphor JSX with a weight prop.`); continue; }
			for (const definition of definitions) {
				used.add(`${definition}:${weight}`);
				if (!policy[definition]?.includes(weight)) fail(node, `${definition} uses ${weight} without an allowance in scripts/phosphor-weights.ts.`);
			}
		}
	}
	function props(node: Node, strict: boolean, site: Node, forbidWeight = false, seen = new Set<Node>()) {
		const value = unwrap(node);
		if (!value || seen.has(value)) { fail(site, "Cannot resolve icon props."); return; }
		if (value.type === "NullLiteral") return;
		if (value.type !== "ObjectExpression") {
			if (strict) fail(site, "Cannot resolve icon props. Use explicit JSX attributes.");
			return;
		}
		for (const [name, binding] of bindings) if (binding && "value" in binding && unwrap(binding.value) === value) {
			for (const reference of nodes) if (reference.type === "Identifier" && reference.name === name) {
				const parent = parents.get(reference);
				if (parent?.type === "VariableDeclarator" && parent.id === reference) continue;
				if (parent?.type === "JSXSpreadAttribute" && parent.argument === reference) continue;
				if (parent?.type === "CallExpression" && reactCall(parent.callee) && parent.arguments[1] === reference) continue;
				fail(reference, "Cannot resolve escaping or mutated icon props. Use explicit JSX attributes.");
			}
		}
		seen.add(value);
		for (const prop of value.properties) {
			if (prop.type === "SpreadElement") { props(prop.argument, strict, prop, forbidWeight, seen); continue; }
			if (prop.computed || (prop.type === "ObjectMethod" && (strict || key(prop) === "weight"))) { fail(prop, "Cannot resolve computed or method icon props. Use explicit JSX attributes."); continue; }
			if (key(prop) === "weight" && prop.type === "ObjectProperty") {
				if (forbidWeight) fail(prop, "Declared non-icon boundaries cannot receive a weight prop.");
				else check(prop, prop.value);
			}
		}
	}
	function context(node: Node, value: Node | undefined) {
		const object = value && unwrap(value);
		if (object?.type !== "ObjectExpression") { fail(node, "IconContext value must be a static regular-weight object."); return; }
		const keys = new Set<string>();
		let regular = false;
		for (const prop of object.properties) {
			const name = key(prop);
			if (prop.type !== "ObjectProperty" || !name || keys.has(name) || !["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(prop.value.type)) { fail(prop, "IconContext value cannot contain spreads, computed keys, methods, duplicate keys or dynamic values."); continue; }
			keys.add(name);
			if (name === "weight") regular = prop.value.type === "StringLiteral" && prop.value.value === "regular";
		}
		if (!regular) fail(node, "IconContext must retain an explicit regular weight default.");
		// A shared defaults object may only be declared and passed directly as a provider value.
		for (const [name, binding] of bindings) if (binding && "value" in binding && unwrap(binding.value) === object) {
			for (const reference of nodes) if (reference.type === "Identifier" && reference.name === name) {
				const parent = parents.get(reference);
				if (parent?.type === "VariableDeclarator" && parent.id === reference) {
					const declaration = parents.get(parent), owner = declaration && parents.get(declaration);
					if (owner?.type !== "ExportNamedDeclaration") continue;
				}
				if (parent?.type === "JSXExpressionContainer") {
					const attr = parents.get(parent), opening = attr && parents.get(attr);
					if (attr?.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === "value" && opening?.type === "JSXOpeningElement" && ["IconContext", "IconContext.Provider"].includes(imported(opening.name) ?? "")) continue;
				}
				fail(reference, "IconContext defaults cannot escape or be mutated. Pass a static object directly to the provider.");
			}
		}
	}
	for (const node of nodes) {
		if (node.type === "JSXOpeningElement") {
			const declared = boundary(node.name);
			for (const attr of node.attributes) {
				if (attr.type === "JSXSpreadAttribute") props(attr.argument, !declared && (!!icons(node.name) || !component(node.name)), attr, declared);
				else if (attr.name.type === "JSXIdentifier" && attr.name.name === "weight") {
					const value = attr.value?.type === "JSXExpressionContainer" ? attr.value.expression : attr.value;
					if (declared) fail(attr, "Declared non-icon boundaries cannot receive a weight prop.");
					else if (value) check(attr, value, node.name); else fail(attr, "Cannot resolve icon weight.");
				}
			}
			if (["IconContext", "IconContext.Provider"].includes(imported(node.name) ?? "")) {
				for (const attr of node.attributes) if (attr.type === "JSXSpreadAttribute") fail(attr, "IconContext providers cannot receive spread attributes.");
				const values = node.attributes.filter(attr => attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === "value");
				if (values.length > 1) fail(node, "IconContext providers cannot receive duplicate value attributes.");
				const attr = values[0];
				context(node, attr?.type === "JSXAttribute" && attr.value?.type === "JSXExpressionContainer" ? attr.value.expression : undefined);
			}
		}
		if (node.type === "CallExpression" && reactCall(node.callee)) {
			const [target, attributes] = node.arguments;
			if (target && attributes) {
				const declared = boundary(target);
				props(attributes, !declared && (!!icons(target) || !component(target)), node, declared);
			}
			if (target && ["IconContext", "IconContext.Provider"].includes(imported(target) ?? "")) fail(node, "Use JSX for IconContext providers so their regular defaults can be checked.");
		}
		if (["Identifier", "JSXIdentifier", "MemberExpression", "JSXMemberExpression"].includes(node.type) && ["IconContext", "IconContext.Provider"].includes(imported(node) ?? "")) {
			const parent = parents.get(node);
			const declaration = parent?.type === "VariableDeclarator" ? parents.get(parent) : undefined;
			const owner = declaration && parents.get(declaration);
			if (parent?.type === "ImportSpecifier") continue;
			if ((parent?.type === "JSXOpeningElement" || parent?.type === "JSXClosingElement") && parent.name === node) continue;
			if ((parent?.type === "MemberExpression" || parent?.type === "JSXMemberExpression") && imported(parent) === "IconContext.Provider") continue;
			if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier" && imported(parent.id) === imported(parent.init ?? parent.id) && owner?.type !== "ExportNamedDeclaration") continue;
			fail(node, "IconContext aliases must stay local const provider aliases rendered directly in JSX.");
		}
	}
	return errors;
}
function checkSources(sources: Record<string, string>, policy: Policy, boundaries: Boundary[] = []): string[] {
	const used = new Set<string>();
	const matched = new Set<Boundary>();
	const errors = Object.entries(sources).flatMap(([file, source]) => inspect(source, file, policy, used, boundaries, matched));
	for (const [icon, weights] of Object.entries(policy)) {
		if (weights.length === 0 || new Set(weights).size !== weights.length) errors.push(`Invalid extra weights for ${icon}.`);
		for (const weight of weights) if (!used.has(`${icon}:${weight}`)) errors.push(`Unused icon weight allowance: ${icon}:${weight}.`);
	}
	for (const boundary of boundaries) if (!matched.has(boundary)) errors.push(`Unused non-icon boundary: ${boundary.file}: ${boundary.shape}.`);
	return errors;
}
function sources(directory: string, base = directory): Record<string, string> {
	return Object.assign({}, ...readdirSync(directory, { withFileTypes: true }).map(entry => {
		const file = join(directory, entry.name);
		return entry.isDirectory() ? sources(file, base) : /\.(?:ts|tsx)$/.test(entry.name) && !/\.(?:test|d)\.tsx?$/.test(entry.name) ? { [relative(base, file).replaceAll("\\", "/")]: readFileSync(file, "utf8") } : {};
	}));
}

// Parses every renderer source file: about 1.6 s alone, and slower while the full suite runs in parallel.
it("checks the icon-authoring convention in renderer TS and TSX sources", () => {
	expect(checkSources(sources(renderer), phosphorExtraWeights, nonIconBoundaries)).toEqual([]);
}, 30_000);
const prelude = 'import { Gear, Folder, FolderIcon as ProjectFolder, IconContext } from "@phosphor-icons/react";';
it("resolves aliases, const icons and both conditional branches", () => {
	const source = `${prelude} const Glyph = Folder; const weight = active ? "fill" : "regular";
		const a = <Glyph weight={weight} />; const b = <ProjectFolder weight="fill" />;`;
	expect(checkSources({ "fixture.tsx": source }, { Folder: ["fill"] })).toEqual([]);
});
it("does not confuse chart weights with icon props in TS modules", () => {
	expect(checkSources({ "chart.ts": 'const fact = { weight: Math.log(value) }; text(1, 2, label, { weight: 600 });' }, {})).toEqual([]);
});
it.each(['<Gear weight="bold" />', '<Gear weight={active ? "fill" : "regular"} />'])("rejects a missing allowance: %s", jsx => {
	expect(checkSources({ "fixture.tsx": `${prelude} const view = ${jsx};` }, {})).toEqual([expect.stringContaining("without an allowance")]);
});
it.each([
	'function Tile({ icon: Icon }) { return <Icon weight="bold" />; } const view = <Tile icon={Gear} />;',
	'function Tile({ icon: Icon }) { const Glyph = Icon; return <Glyph weight={active ? "fill" : "regular"} />; }',
	'const Glyph = lookupIcon(name); const view = <Glyph weight="bold" />;',
	'function Tile(Gear) { return <Gear weight="bold" />; }',
	'class Tile { render(Folder) { return <Folder weight="fill" />; } }',
	'const view = <Gear weight={unknownWeight} />;',
	'const props = { weight: "bold" }; const view = <Gear {...props} />;',
	'const props = { get weight() { return "bold"; } }; const view = <Gear {...props} />;',
	'const props = { weight() { return "bold"; } }; const view = <Gear {...props} />;',
	'const props = { [key]: "bold" }; const view = <Gear {...props} />;',
	'const Glyph = [Gear][0]; const view = <Glyph {...{ [key]: "bold" }} />;',
	'const props = {}; props.weight = "bold"; const view = <Gear {...props} />;',
	'function Tile(props) { return <Gear {...props} />; }',
	'function Tile(props) { return <props.icon {...props} />; } const view = <Tile icon={Gear} weight="bold" />;',
	'function Tile(props) { return <Gear {...props} />; } const props = { get weight() { return "bold"; } }; const view = <Tile {...props} />;',
])("rejects dynamic or forwarded icon props: %s", source => {
	expect(checkSources({ "fixture.tsx": `${prelude} ${source}` }, {})).toEqual(expect.arrayContaining([expect.stringContaining("Cannot resolve")]));
});
it.each([
	'export const view = createElement(Gear, { weight: "bold" });',
	'export const view = createElement(unknownIcon, { weight: "bold" });',
	'export const view = cloneElement(element, { weight: "fill" });',
	'export const view = React.cloneElement(element, { [key]: "fill" });',
	'export const view = createElement(Gear, { get weight() { return "bold"; } });',
	'export const view = createElement(Gear, props);',
	'export const view = createElement(unknownIcon, props);',
	'import { createElement as h } from "react"; export const view = h(Gear, { weight: "bold" });',
	'import { cloneElement } from "react"; const clone = cloneElement; export const view = clone(unknownIcon, { weight: "fill" });',
])("checks element construction in plain TS: %s", source => {
	expect(checkSources({ "fixture.ts": `${prelude} ${source}` }, {})).toEqual(expect.arrayContaining([expect.stringContaining("Cannot resolve")]));
});
it("rejects unused allowances, including an unused weight on a used icon", () => {
	expect(checkSources({ "fixture.tsx": `${prelude} const view = <Folder weight="fill" />;` }, { Folder: ["bold", "fill"], Gear: ["bold"] })).toEqual([
		"Unused icon weight allowance: Folder:bold.", "Unused icon weight allowance: Gear:bold.",
	]);
});
it("accepts static regular defaults and provider aliases, including nested providers", () => {
	const source = `${prelude} const defaults = { weight: "regular", size: "1em" }; const Provider = IconContext.Provider;
		const view = <IconContext.Provider value={defaults}><Provider value={{ weight: "regular" }} /></IconContext.Provider>;`;
	expect(checkSources({ "fixture.tsx": source }, {})).toEqual([]);
});
it.each([
	'const view = <IconContext.Provider value={{ weight: "fill" }} />;',
	'const view = <IconContext.Provider value={dynamicDefaults} />;',
	'const view = <IconContext.Provider value={{ size: "1em" }} />;',
	'const view = <IconContext.Provider value={{ weight: "regular", [key]: "bold" }} />;',
	'const view = <IconContext.Provider value={{ weight: "regular", get color() { mutate(); return "red"; } }} />;',
	'const view = <IconContext.Provider value={{ weight: "regular", ...extra }} />;',
	'const view = <IconContext.Provider value={{ weight: "regular", weight: "fill" }} />;',
	'const view = <IconContext.Provider value={{ weight: "regular" }} {...{ value: { weight: "bold" } }} />;',
	'const Provider = IconContext.Provider; const view = <Provider value={{ weight: "regular" }} {...{ value: { weight: "bold" } }} />;',
	'const view = <IconContext.Provider value={{ weight: "regular" }} value={{ weight: "bold" }} />;',
	'const defaults = { weight: "regular" }; defaults.weight = "bold"; const view = <IconContext.Provider value={defaults} />;',
	'const defaults = { weight: "regular" }; Object.assign(defaults, extra); const view = <IconContext.Provider value={defaults} />;',
	'const defaults = { weight: "regular" }; const alias = defaults; alias[key] = "bold"; const view = <IconContext.Provider value={defaults} />;',
	'const Provider = IconContext.Provider; const view = <Provider value={{ weight: "regular", [key]: "bold" }} />;',
	'const Provider = IconContext.Provider; const view = <IconContext.Provider value={{ weight: "regular" }}><Provider value={{ weight: "fill" }} /></IconContext.Provider>;',
	'const { Provider } = IconContext; const view = <Provider value={{ weight: "bold" }} />;',
	'let Provider = IconContext.Provider; const view = <Provider value={{ weight: "bold" }} />;',
	'const Provider = IconContext["Provider"]; const view = <Provider value={{ weight: "bold" }} />;',
	'function provider() { return IconContext.Provider; } const Provider = provider(); const view = <Provider value={{ weight: "bold" }} />;',
	'export const defaults = { weight: "regular" }; const view = <IconContext.Provider value={defaults} />;',
	'export const Provider = IconContext.Provider; const view = <Provider value={{ weight: "regular" }} />;',
])("rejects context overrides and escaping defaults: %s", source => {
	expect(checkSources({ "fixture.tsx": source.startsWith("import") ? source : `${prelude} ${source}` }, {})).toEqual(expect.arrayContaining([expect.stringContaining("IconContext")]));
});

const fixtureBoundary: Boundary[] = [{ file: "fixture.tsx", shape: "adapter.Frame", reason: "Fixture preview adapter." }];
it("permits unresolved non-icon props only at the declared file and target shape", () => {
	expect(checkSources({ "fixture.tsx": 'const view = <adapter.Frame {...props} />;' }, {}, fixtureBoundary)).toEqual([]);
	expect(checkSources({ "different.tsx": 'const view = <adapter.Frame {...props} />;' }, {}, fixtureBoundary)).toEqual(expect.arrayContaining([expect.stringContaining("Cannot resolve")]));
	expect(checkSources({ "fixture.tsx": 'const view = <adapter.Other {...props} />;' }, {}, fixtureBoundary)).toEqual(expect.arrayContaining([expect.stringContaining("Cannot resolve")]));
});
it("rejects stale declared non-icon boundaries", () => {
	expect(checkSources({ "fixture.tsx": 'const view = <div />;' }, {}, fixtureBoundary)).toEqual(["Unused non-icon boundary: fixture.tsx: adapter.Frame."]);
});
it.each([
	'const view = <adapter.Frame weight="bold" />;',
	'const view = <adapter.Frame weight="regular" />;',
	'const props = { weight: "bold" }; const view = <adapter.Frame {...props} />;',
	'const props = { weight: "regular" }; const view = <adapter.Frame {...props} />;',
	'const view = <adapter.Frame {...{ [key]: "bold" }} />;',
	'const view = <adapter.Frame {...{ get weight() { return "bold"; } }} />;',
])("rejects weight-bearing props at declared boundaries: %s", source => {
	expect(checkSources({ "fixture.tsx": source }, {}, fixtureBoundary)).not.toEqual([]);
});
it("checks context values even at a declared target", () => {
	const boundary: Boundary[] = [{ file: "fixture.tsx", shape: "Provider", reason: "Fixture provider alias." }];
	expect(checkSources({ "fixture.tsx": `${prelude} const Provider = IconContext.Provider; const view = <Provider value={{ weight: "fill" }} />;` }, {}, boundary)).toEqual(expect.arrayContaining([expect.stringContaining("IconContext")]));
});
