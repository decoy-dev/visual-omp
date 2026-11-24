"""Writes the README's outlined lockup and download buttons, light and dark, into assets/readme/.

Text is shaped with HarfBuzz so Geist's kerning applies, then outlined, so the SVGs need no fonts.
The periscope copies the C1 shapes from src/renderer/src/ui/BrandMark.tsx, and the button icons are
Phosphor's fill paths read from node_modules. Run from the repository root after `npm install`:

    python3 -m venv /tmp/lockup-venv
    /tmp/lockup-venv/bin/pip install fonttools uharfbuzz brotli
    /tmp/lockup-venv/bin/python scripts/readme/lockup.py
"""
import io
import json
import subprocess
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "assets/readme"
FONTS = REPO / "node_modules/@fontsource-variable"

# Phosphor's defs modules build React elements; a stand-in createElement collects their path data.
ICON_SCRIPT = """
import { readFileSync } from "node:fs";
const out = {};
for (const name of ["AppleLogo", "WindowsLogo"]) {
  const src = readFileSync(`node_modules/@phosphor-icons/react/dist/defs/${name}.es.js`, "utf8")
    .replace(/^import \\* as a from "react";/m, "").replace(/export\\s*\\{[^}]*\\};?/m, "");
  const a = { Fragment: "frag", createElement: (type, props, ...children) => ({ type, props, children }) };
  const map = new Function("a", `${src}; return e;`)(a);
  const paths = node => node.type === "path" ? [node.props] : node.children.flatMap(paths);
  out[name] = paths(map.get("fill")).map(p => p.d);
}
process.stdout.write(JSON.stringify(out));
"""
ICONS = json.loads(subprocess.run(["node", "--input-type=module", "-e", ICON_SCRIPT], cwd=REPO, check=True,
                                  capture_output=True, text=True).stdout)


class Face:
    def __init__(self, path, weight):
        font = instantiateVariableFont(TTFont(path), {"wght": weight})
        font.flavor = None
        buf = io.BytesIO()
        font.save(buf)
        self.font = TTFont(io.BytesIO(buf.getvalue()))
        self.glyphs = self.font.getGlyphSet()
        self.order = self.font.getGlyphOrder()
        self.upm = self.font["head"].unitsPerEm
        self.hb = hb.Font(hb.Face(buf.getvalue()))

    def shape(self, text, size, tracking=0.0):
        """Glyph names with pen positions in px, and the advance width."""
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self.hb, buf, {"kern": True, "liga": True})
        scale, x, out = size / self.upm, 0.0, []
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            out.append((self.order[info.codepoint], x + pos.x_offset * scale, pos.y_offset * scale))
            x += pos.x_advance * scale + tracking * size
        return out, x - tracking * size

    def path(self, text, size, x, baseline, tracking=0.0):
        glyphs, width = self.shape(text, size, tracking)
        pen = SVGPathPen(self.glyphs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
        scale = size / self.upm
        for name, gx, gy in glyphs:
            self.glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x + gx, baseline - gy)))
        return pen.getCommands(), width

    def cap_height(self, size):
        pen = BoundsPen(self.glyphs)
        self.glyphs[self.font.getBestCmap()[ord("H")]].draw(pen)
        return pen.bounds[3] * size / self.upm


SANS = FONTS / "geist/files/geist-latin-wght-normal.woff2"
MONO = FONTS / "geist-mono/files/geist-mono-latin-wght-normal.woff2"
HEAD, LABEL, WORD = Face(SANS, 700), Face(SANS, 600), Face(MONO, 600)

THEMES = {
    "light": dict(ink="#141C1C", lens="#10726F", primary="#10726F", on_primary="#FFFFFF", secondary="#FEFFFF",
                  border="rgba(20,28,28,0.22)", label="#141C1C", icon="#10726F"),
    "dark": dict(ink="#E9EEEE", lens="#5FCCC8", primary="#5FCCC8", on_primary="#031A19", secondary="#151919",
                 border="rgba(233,238,238,0.20)", label="#E9EEEE", icon="#5FCCC8"),
}

# Periscope C1 "Heavy" on its 1024 grid; MARK_BOX is BrandMark.tsx's MARK_VIEWBOX (x, y, size).
MARK = ('<path d="M230 600L342 682L230 764" fill="none" stroke="{ink}" stroke-width="88" stroke-linecap="round" stroke-linejoin="round"/>'
        '<rect x="420" y="712" width="382" height="72" fill="{ink}"/>'
        '<path d="M474 392L650 216H762V392H606V748H474Z" fill="{ink}"/>'
        '<rect x="790" y="234" width="48" height="140" rx="10" fill="{lens}"/>')
MARK_BOX = (186, 186, 652)

HEADLINE = ["The omp coding agent", "in a desktop window"]
ALT = "visual-omp: " + " ".join(HEADLINE)


def lockup(theme):
    c = THEMES[theme]
    width, height, mark_size, gap, word_size, center_y = 800, 220, 34, 8, 28, 42
    _, word_width = WORD.shape("visual-omp", word_size, -0.02)
    left = (width - (mark_size + gap + word_width)) / 2
    scale = mark_size / MARK_BOX[2]
    mark = (f'<g transform="translate({left:.2f} {center_y - mark_size / 2:.2f}) scale({scale:.5f}) '
            f'translate({-MARK_BOX[0]} {-MARK_BOX[1]})">' + MARK.format(**c) + "</g>")
    word, _ = WORD.path("visual-omp", word_size, left + mark_size + gap, center_y + WORD.cap_height(word_size) / 2, -0.02)
    lines = ""
    for text, baseline in zip(HEADLINE, (116, 174)):
        _, line_width = HEAD.shape(text, 54, -0.02)
        d, _ = HEAD.path(text, 54, (width - line_width) / 2, baseline, -0.02)
        lines += f'<path d="{d}" fill="{c["ink"]}"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
            f'role="img" aria-label="{ALT}"><title>{ALT}</title>{mark}<path d="{word}" fill="{c["ink"]}"/>{lines}</svg>\n')


BUTTONS = [
    ("download-apple-silicon", "Apple silicon Mac", "AppleLogo", 432, True),
    ("download-intel", "Intel Mac", "AppleLogo", 368, False),
    ("download-windows", "Windows", "WindowsLogo", 336, False),
]


def button(theme, text, icon, width, primary):
    c = THEMES[theme]
    height, icon_size, gap, size = 104, 36, 16, 30
    _, text_width = LABEL.shape(text, size)
    x0 = (width - (icon_size + gap + text_width)) / 2
    label, _ = LABEL.path(text, size, x0 + icon_size + gap, height / 2 + LABEL.cap_height(size) / 2)
    icon_paths = "".join(f'<path d="{d}"/>' for d in ICONS[icon])
    icon_fill = c["on_primary"] if primary else c["icon"]
    border = "" if primary else f' stroke="{c["border"]}" stroke-width="2"'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width // 2}" height="{height // 2}" '
            f'role="img" aria-label="Download for {text}"><title>Download for {text}</title>'
            f'<rect x="1" y="1" width="{width - 2}" height="{height - 2}" rx="24" fill="{c["primary"] if primary else c["secondary"]}"{border}/>'
            f'<g fill="{icon_fill}" transform="translate({x0:.2f} {(height - icon_size) / 2:.2f}) scale({icon_size / 256})">{icon_paths}</g>'
            f'<path d="{label}" fill="{c["on_primary"] if primary else c["label"]}"/></svg>\n')


OUT.mkdir(parents=True, exist_ok=True)
for theme in THEMES:
    (OUT / f"lockup-{theme}.svg").write_text(lockup(theme))
    for slug, text, icon, width, primary in BUTTONS:
        (OUT / f"{slug}-{theme}.svg").write_text(button(theme, text, icon, width, primary))
print("\n".join(sorted(p.name for p in OUT.glob("*.svg"))))
