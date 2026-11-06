// Recorded examples of omp 18.17 result formats, without starting servers or using the web.
// Sources: coding-agent/src/lsp/tool.ts (diagnostics and references),
// coding-agent/src/web/search/index.ts (failureDetails and executeSearch), and
// src/renderer/src/tool-render/tools/{lsp,web-search}.test.ts.
const text = value => [{ type: "text", text: value }];

export default [
  {
    name: "lsp", args: { action: "references", file: "src/cart.ts", line: 12, column: 7 },
    result: {
      content: text("Found 2 reference(s):\n  src/cart.ts:12:7\n    11: // Calculate the delivery total.\n    12: const total = calculate(cart);\n    13: return total;\n  src/checkout.ts:24:3\n    24: return calculate(cart);"),
      details: { action: "references", serverName: "typescript", success: true, request: { action: "references", file: "src/cart.ts", line: 12, column: 7 } },
    },
  },
  {
    name: "lsp", args: { action: "diagnostics", file: "src/**/*.ts" },
    result: {
      content: text("✗ src/cart.ts: 1 error(s)\n# src/\n## cart.ts\n  12:7 [error] Type 'string' is not assignable to type 'number'.\n✗ src/checkout.ts: 1 warning(s)\n# src/\n## checkout.ts\n  24:3 [warning] Unused value\n✓ src/clean.ts: no issues\n✗ src/broken.ts: all language servers failed (typescript)\n⚠ src/pending.ts: no diagnostics report yet from biome; retry once it finishes analyzing\n⚠ src/cart.ts: some servers failed (eslint)"),
      details: { action: "diagnostics", serverName: "typescript, biome, eslint", success: true },
    },
  },
  {
    name: "lsp", args: { action: "hover", file: "src/broken.ts", line: 1, column: 1 },
    result: { content: text("LSP error: connection closed"), details: { action: "hover", serverName: "typescript", success: false, request: { action: "hover", file: "src/broken.ts", line: 1, column: 1 } } },
  },
  {
    name: "web_search", args: { query: "recorded release notes example" },
    result: {
      content: text("Recorded search answer: this fixture demonstrates a successful fallback with failed providers retained."),
      details: { response: { provider: "keenable", sources: [{ title: "Recorded release notes example", url: "https://example.invalid/releases" }] }, failures: [
        { provider: "zai", label: "Z.ai", reason: "Rate limit exceeded", status: 429 },
        { provider: "exa", label: "Exa", reason: "Connection closed" },
        { provider: "brave", label: "Brave", reason: "Service unavailable", status: 503 },
      ] },
    },
  },
  {
    name: "web_search", args: { query: "recorded all-provider failure example" },
    result: { content: text("Error: All web search providers failed: Brave: Unauthorized"), details: { response: { provider: "brave", sources: [] }, error: "All web search providers failed: Brave: Unauthorized", failures: [{ provider: "brave", label: "Brave", reason: "Unauthorized", status: 401 }] } },
  },
];
