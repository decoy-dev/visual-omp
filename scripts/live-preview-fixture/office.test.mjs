import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { officeCommand, officePython } from "./office.mjs";

const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"], { encoding: "utf8" }).status === 0;
const cases = ["docx", "xlsx", "pptx"].flatMap(kind =>
  ["native", "CRLF"].map(lineEndings => ({ kind, lineEndings })));
for (const { kind, lineEndings } of cases) {
  test(`${kind} fixture uses standard-library ZIPs, saves three revisions, truncates and writes a bounded bomb (${lineEndings})`, { skip: !available }, async t => {
    const folder = await mkdtemp(join(tmpdir(), "vomp-office-fixture-"));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const inspect = `
import json
valid = package(3)
with zipfile.ZipFile(io.BytesIO(valid)) as archive:
    names = archive.namelist()
    xml = {name:archive.read(name).decode('utf-8') for name in names if name.endswith('.xml') or name.endswith('.rels')}
    image = archive.read('word/media/image.png') if kind == 'docx' else None
    image_size = list(struct.unpack('>II', image[16:24])) if image else None
try:
    zipfile.ZipFile(path).testzip()
    truncated = False
except zipfile.BadZipFile:
    truncated = True
with zipfile.ZipFile(bomb) as archive:
    huge = archive.infolist()[0].file_size
print(json.dumps({'names':names,'xml':xml,'truncated':truncated,'huge':huge,'imageSize':image_size}))
`;
    // Native Windows Python translates print() line endings to CRLF.
    const stdoutSetup = lineEndings === "CRLF" ? "import sys; sys.stdout.reconfigure(newline='\\r\\n')\n" : "";
    const result = spawnSync(python, ["-c", stdoutSetup + officePython(kind, 0) + inspect], { cwd: folder, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    if (lineEndings === "CRLF") assert.match(result.stdout, / save 1\r\n/);
    assert.deepEqual([...result.stdout.matchAll(/ save ([123])\r?\n/g)].map(match => Number(match[1])), [1, 2, 3]);
    const inspected = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(inspected.truncated, true);
    assert.equal(inspected.huge, 64 * 1024 * 1024 + 1);
    if (kind === "docx") {
      assert.match(inspected.xml["word/document.xml"], /Office fixture revision 3/);
      assert.match(inspected.xml["word/document.xml"], /<w:tbl>/);
      assert.ok(inspected.names.includes("word/media/image.png"));
      assert.deepEqual(inspected.imageSize, [480, 160]);
      assert.match(inspected.xml["word/document.xml"], /Quarterly delivery review/);
      assert.match(inspected.xml["word/document.xml"], /Figure 1/);
      assert.match(inspected.xml["word/document.xml"], /w:shd/);
      assert.equal((inspected.xml["word/document.xml"].match(/<w:tr>/g) ?? []).length, 4);
      assert.match(inspected.xml["word/numbering.xml"], /w:val="bullet"/);
      assert.match(inspected.xml["word/numbering.xml"], /w:val="decimal"/);
      assert.match(inspected.xml["word/footer1.xml"], /Illustrative data/);
      assert.match(inspected.xml["word/_rels/document.xml.rels"], /TargetMode="External"/);
    } else if (kind === "xlsx") {
      assert.match(inspected.xml["xl/workbook.xml"], /Summary and cached values/);
      assert.match(inspected.xml["xl/worksheets/sheet1.xml"], /<f>B1\*3<\/f><v>6<\/v>/);
      assert.match(inspected.xml["xl/worksheets/sheet1.xml"], /&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.match(inspected.xml["xl/worksheets/sheet2.xml"], /r="50000"/);
      assert.match(inspected.xml["xl/worksheets/sheet1.xml"], /Delivery summary/);
      assert.match(inspected.xml["xl/worksheets/sheet1.xml"], /<f>SUM\(C5:C7\)<\/f><v>20<\/v>/);
    } else {
      assert.ok(inspected.names.includes("ppt/slides/slide2.xml"));
      assert.match(inspected.xml["ppt/slides/_rels/slide1.xml.rels"], /127\.0\.0\.1:47832/);
    }
    assert.ok(officeCommand(kind).startsWith("python3 - <<'PY'"));
  });
}

test("unknown Office fixtures are refused", () => assert.throws(() => officeCommand("pptm"), /Unknown Office/));
