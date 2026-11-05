import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PendingHang } from "./hang";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function fixture() {
	const folder = await mkdtemp(join(tmpdir(), "vomp-hang-"));
	folders.push(folder);
	return new PendingHang(join(folder, "pending-hang.json"));
}
it("recovers a confirmed long hang once, preserving its duration without adding downtime", async () => {
	const hang = await fixture();
	hang.save(1, 10_500);
	await hang.flush();
	const next = new PendingHang(hang.file);
	expect(await next.recover()).toEqual({ event: "window-responsive", windowId: 1, durationMs: 10_500, recovered: true });
	expect(await next.recover()).toBeNull();
});
it("serializes save then clear so a responsive window leaves no stale marker", async () => {
	const hang = await fixture();
	hang.save(1, 10_000);
	hang.clear();
	expect(await hang.recover()).toBeNull();
});
it.each(["invalid", '{"windowId":1,"durationMs":9999}', '{"windowId":"prompt","durationMs":10000}'])("ignores damaged or short hang markers: %s", async text => {
	const hang = await fixture();
	await writeFile(hang.file, text);
	expect(await hang.recover()).toBeNull();
	expect(await hang.recover()).toBeNull();
});
