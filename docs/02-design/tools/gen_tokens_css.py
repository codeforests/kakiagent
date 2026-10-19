"""Generate CSS custom properties from docs/02-design/tokens.json and check contrast.

Writes the generated block into design.md (between the GENERATED markers) and into
anchors/tokens.css, then prints the WCAG contrast report. Exits 1 if any pair fails.

Usage (from the repo root): python3 docs/02-design/tools/gen_tokens_css.py
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DESIGN = os.path.dirname(HERE)
tokens = json.load(open(os.path.join(DESIGN, "tokens.json")))
MODE = "org.kakiagent.modes"

def walk(node, path=()):
    for k, v in node.items():
        if k.startswith("$"):
            continue
        if isinstance(v, dict) and "$value" in v:
            yield path + (k,), v
        elif isinstance(v, dict):
            yield from walk(v, path + (k,))

flat = {".".join(p): t for p, t in walk(tokens)}

def resolve(val, mode):
    if isinstance(val, str):
        m = re.fullmatch(r"\{(.+)\}", val)
        if m:
            t = flat[m.group(1)]
            return value(t, mode)
    return val

def value(t, mode):
    if mode == "dark" and MODE in t.get("$extensions", {}):
        return resolve(t["$extensions"][MODE]["dark"], mode)
    return resolve(t["$value"], mode)

def css_val(t, v):
    ty = t["$type"]
    if ty == "fontFamily":
        return ", ".join(f'"{f}"' if " " in f else f for f in v)
    if ty == "shadow":
        return f'{v["offsetX"]} {v["offsetY"]} {v["blur"]} {v["spread"]} {v["color"]}'
    if ty == "cubicBezier":
        return "cubic-bezier(" + ", ".join(str(x) for x in v) + ")"
    if ty == "typography":
        return None
    return str(v)

def name(path):
    p = path.split(".")
    if p[0] == "widget":
        return "--kaki-" + "-".join(p[1:])
    return "--" + "-".join(p)

light, dark = [], []
for path, t in flat.items():
    if t["$type"] == "typography":
        v = value(t, "light")
        n = name(path)
        light.append(f"  {n}-size: {v['fontSize']};")
        light.append(f"  {n}-line: {v['lineHeight']};")
        light.append(f"  {n}-weight: {v['fontWeight']};")
        continue
    lv = css_val(t, value(t, "light"))
    light.append(f"  {name(path)}: {lv};")
    dv = css_val(t, value(t, "dark"))
    if dv != lv:
        dark.append(f"  {name(path)}: {dv};")

dark_body = "\n".join("  " + l for l in dark)
css = (":root {\n" + "\n".join(light) + "\n}\n"
       + "@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=\"light\"]) {\n" + dark_body + "\n  }\n}\n"
       + ":root[data-theme=\"dark\"] {\n" + "\n".join(dark) + "\n}\n")

open(os.path.join(DESIGN, "anchors", "tokens.css"), "w").write(
    "/* GENERATED from docs/02-design/tokens.json — do not edit by hand. */\n" + css)
md_path = os.path.join(DESIGN, "design.md")
md = open(md_path).read()
begin, end = "<!-- BEGIN GENERATED: tokens.css — do not edit by hand -->", "<!-- END GENERATED -->"
i, j = md.index(begin) + len(begin), md.index(end)
open(md_path, "w").write(md[:i] + "\n```css\n" + css.rstrip() + "\n```\n" + md[j:])

# Contrast checks: (fg, bg, minimum)
def lum(h):
    h = h.lstrip("#")[:6]
    c = [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
def cr(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)

PAIRS = [
    ("color.text.primary", "color.bg.canvas", 4.5), ("color.text.primary", "color.bg.surface", 4.5),
    ("color.text.secondary", "color.bg.surface", 4.5), ("color.text.secondary", "color.bg.canvas", 4.5),
    ("color.text.secondary", "color.bg.subtle", 4.5),
    ("color.text.on-accent", "color.accent.default", 4.5), ("color.text.on-accent", "color.accent.hover", 4.5),
    ("color.accent.default", "color.bg.surface", 4.5), ("color.accent.default", "color.bg.canvas", 4.5),
    ("color.accent.default", "color.accent.soft", 4.5),
    ("color.border.strong", "color.bg.surface", 3.0), ("color.focus", "color.bg.surface", 3.0),
    ("color.focus", "color.bg.canvas", 3.0),
]
for s in ["success", "warning", "danger", "info", "pending"]:
    PAIRS += [(f"color.{s}.default", f"color.{s}.soft", 4.5), (f"color.{s}.default", "color.bg.surface", 4.5)]
PAIRS += [("color.text.on-accent", "color.danger.default", 4.5)]
fail = False
report = []
for mode in ("light", "dark"):
    for fg, bg, mn in PAIRS:
        r = cr(value(flat[fg], mode), value(flat[bg], mode))
        ok = r >= mn
        fail |= not ok
        report.append(f"{mode:5} {fg:28} on {bg:22} {r:5.2f}  {'ok' if ok else 'FAIL'} (min {mn})")
print("\n".join(report))
sys.exit(1 if fail else 0)
