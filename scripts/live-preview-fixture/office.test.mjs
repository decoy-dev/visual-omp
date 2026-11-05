import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { officeCommand, officePython } from "./office.mjs";

const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"], { encoding: "utf8" }).status === 0;
for (const kind of ["docx", "xlsx", "pptx"]) {
  test(`${kind} fixture uses standard-library ZIPs, saves three revisions, truncates and writes a bounded bomb`, { skip: !available }, async t => {
    const folder = await mkdtemp(join(tmpdir(), "vomp-office-fixture-"));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const inspect = `
import json
valid = package(3)
with zipfile.ZipFile(io.BytesIO(valid)) as archive:
    names = archive.namelist()
    xml = {name:archive.read(name).decode('utf-8') for name in names if name.endswith('.xml') or name.endswith('.rels')}
try:
    zipfile.ZipFile(path).testzip()
    truncated = False
except zipfile.BadZipFile:
    truncated = True
with zipfile.ZipFile(bomb) as archive:
    huge = archive.infolist()[0].file_size
print(json.dumps({'names':names,'xml':xml,'truncated':truncated,'huge':huge}))
`;
    const result = spawnSync(python, ["-c", officePython(kind, 0) + inspect], { cwd: folder, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/ save [123]\n/g) ?? []).length, 3);
    const inspected = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(inspected.truncated, true);
    assert.equal(inspected.huge, 64 * 1024 * 1024 + 1);
    if (kind === "docx") {
      assert.match(inspected.xml["word/document.xml"], /Office fixture revision 3/);
      assert.match(inspected.xml["word/document.xml"], /<w:tbl>/);
      assert.ok(inspected.names.includes("word/media/image.png"));
      assert.match(inspected.xml["word/_rels/document.xml.rels"], /TargetMode="External"/);
    } else if (kind === "xlsx") {
      assert.match(inspected.xml["xl/workbook.xml"], /Summary and cached values/);
      assert.match(inspected.xml["xl/worksheets/sheet1.xml"], /<f>B1\*3<\/f><v>6<\/v>/);
      assert.match(inspected.xml["xl/worksheets/sheet1.xml"], /&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.match(inspected.xml["xl/worksheets/sheet2.xml"], /r="50000"/);
    } else {
      assert.ok(inspected.names.includes("ppt/slides/slide2.xml"));
      assert.match(inspected.xml["ppt/slides/_rels/slide1.xml.rels"], /127\.0\.0\.1:47832/);
    }
    assert.ok(officeCommand(kind).startsWith("python3 - <<'PY'"));
  });
}

test("unknown Office fixtures are refused", () => assert.throws(() => officeCommand("pptm"), /Unknown Office/));
