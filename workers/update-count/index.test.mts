import { strict as assert } from "node:assert";
import { test } from "node:test";
import worker from "./src/index.ts";

function makeRequest(body) {
	return new Request("https://worker.test/v1/check", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function makeEnv(writes) {
	const waited = [];
	const env = {
		DB: {
			prepare(sql) {
				return {
					bind(...params) {
						return {
							async run() {
								writes.push({ sql, params });
								return { success: true };
							},
						};
					},
				};
			},
		},
	};
	const ctx = { waitUntil: promise => waited.push(promise) };
	return { env, ctx, drain: () => Promise.all(waited) };
}

test("accepts published semver and prerelease versions", async () => {
	for (const version of ["0.8.7", "1.0.0-beta.1", "2.10.3-alpha.0", "1.2.3-rc.2"]) {
		const writes = [];
		const { env, ctx, drain } = makeEnv(writes);
		const response = await worker.fetch(makeRequest({ version, platform: "darwin", arch: "arm64" }), env, ctx);
		await drain();
		assert.equal(response.status, 204, version);
		assert.equal(writes.length, 1);
		assert.equal(writes[0].params[1], version);
	}
});

test("rejects build metadata, arbitrary prerelease tags, and oversized version fields", async () => {
	for (const version of ["0.8.7+random", "0.8.7-spam123", "0.8.7-dev.1", "99999999.0.0", "1.0.0-beta.10000000000"]) {
		const writes = [];
		const { env, ctx, drain } = makeEnv(writes);
		const response = await worker.fetch(makeRequest({ version, platform: "win32", arch: "x64" }), env, ctx);
		await drain();
		assert.equal(response.status, 400, version);
		assert.equal(writes.length, 0);
	}
});
