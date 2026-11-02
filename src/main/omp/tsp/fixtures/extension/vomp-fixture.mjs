// Explicitly loaded by record-fixtures.ts. This extension never invokes a model.
export default function vompFixture(pi) {
	pi.registerCommand("vomp-fixture-select", {
		description: "Record the hook selector",
		handler: async (_args, ctx) => {
			const answer = await ctx.ui.select("Choose a fixture option", [
				{ label: "First option", description: "The initial selection" },
				{ label: "Second option", description: "The recorded answer" },
				{ label: "A long fixture option label that should remain readable when the omp screen is narrow or the text size is increased", description: "Exercises wrapping and full-label access" },
				"Fourth option",
			]);
			ctx.ui.notify(`Fixture select answer: ${JSON.stringify(answer ?? null)}`, "info");
		},
	});
	pi.registerCommand("vomp-fixture-input", {
		description: "Record the hook input",
		handler: async (_args, ctx) => {
			// omp 18.14.0 exposes a placeholder here, without a prefill option.
			const answer = await ctx.ui.input("Enter a fixture value", "Fixture default value");
			ctx.ui.notify(`Fixture input answer: ${JSON.stringify(answer ?? null)}`, "info");
		},
	});
	pi.registerCommand("vomp-fixture-editor", {
		description: "Record the hook editor",
		handler: async (_args, ctx) => {
			const answer = await ctx.ui.editor("Edit the fixture notes", "First fixture line\nSecond fixture line");
			ctx.ui.notify(`Fixture editor answer: ${JSON.stringify(answer ?? null)}`, "info");
		},
	});
	pi.registerCommand("vomp-fixture-confirm", {
		description: "Record the hook confirmation",
		handler: async (_args, ctx) => {
			const answer = await ctx.ui.confirm("Confirm the fixture", "Keep this fixture answer?");
			ctx.ui.notify(`Fixture confirm answer: ${JSON.stringify(answer)}`, "info");
		},
	});
	pi.registerCommand("vomp-fixture-rows", {
		description: "Record a custom component without a semantic description",
		handler: async (_args, ctx) => {
			const answer = await ctx.ui.custom((_tui, _theme, _keybindings, done) => ({
				render: () => ["Fixture custom rows", "Press Enter to complete or Escape to cancel."],
				invalidate() {},
				handleInput(data) {
					if (data === "\r" || data === "\n") done("completed");
					else if (data === "\u001b") done("cancelled");
				},
			}));
			ctx.ui.notify(`Fixture rows answer: ${JSON.stringify(answer)}`, "info");
		},
	});
}
