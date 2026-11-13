#!/usr/bin/env python3
"""Cross-document seam sweep (the pipeline-verify skill's mechanical checks).

    python3 scripts/pipeline-verify.py            counts + errors + warnings (info as counts only)
    python3 scripts/pipeline-verify.py --info     also list info findings
    python3 scripts/pipeline-verify.py --json F   also write every finding and the dashboard to F

Read-only: it never edits a pipeline document. Exit 1 if there are errors.
The report (docs/pipeline-verify-report.md) is written by hand from this output.
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

DOCS = "docs"
SRS = f"{DOCS}/01-requirements/SRS.md"
UCS = f"{DOCS}/01-requirements/use-cases.md"
RTM = f"{DOCS}/01-requirements/rtm.md"
UXF = f"{DOCS}/02-design/ux-foundations.md"
ADRS = f"{DOCS}/02-design/adr"
PLAN = f"{DOCS}/03-planning/implementation-plan.md"
MANIFEST = f"{DOCS}/design-manifest.json"
FEATURES = f"{DOCS}/features"
DESIGN = f"{DOCS}/02-design/design.md"
TOKENS = f"{DOCS}/02-design/tokens.json"

findings = []  # (level, owner, text)


def find(level, owner, text):
    findings.append((level, owner, text))


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def table_rows(text):
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("| ") and not line.startswith("|---"):
            yield [c.strip() for c in line.strip().strip("|").split("|")]


def expand_ids(cell, prefixes):
    """IDs in a cell, expanding 'SCR-APP-011, -037' and 'SCR-APP-006..011'."""
    out = []
    pat = re.compile(r"\b((?:%s)-)(\d+)(?:\.\.(\d+))?|(?<![\w-])-(\d{2,3})\b" % "|".join(prefixes))
    last = None
    for m in pat.finditer(cell):
        if m.group(1):
            last, n = m.group(1), m.group(2)
            out.append(last + n)
            if m.group(3):
                w = len(n)
                out += [f"{last}{i:0{w}d}" for i in range(int(n) + 1, int(m.group(3)) + 1)]
        elif last and m.group(4):
            out.append(last + m.group(4).zfill(len(out[-1].rsplit("-", 1)[1])))
    return out


def slug(heading):
    s = heading.strip().lower()
    s = re.sub(r"[^\w\- ]", "", s)
    return s.replace(" ", "-")


def anchors_of(path):
    if not os.path.exists(path):
        return None
    seen = Counter()
    out = set()
    for line in read(path).split("\n"):
        m = re.match(r"^#{1,6} (.+)", line)
        if m:
            s = slug(m.group(1))
            out.add(s if not seen[s] else f"{s}-{seen[s]}")
            seen[s] += 1
    return out


# ---------- Phase 1: inventory ----------
srs = read(SRS)
req_pri = {}
for cells in table_rows(srs):
    if re.fullmatch(r"[A-Z]+-\d+", cells[0]) and len(cells) > 2:
        if cells[1] in ("M", "S", "C") or cells[0].startswith("NFR-"):
            req_pri.setdefault(cells[0], cells[1])
REQ_PREFIXES = sorted({r.split("-")[0] for r in req_pri})
ucs = set(re.findall(r"^### (UC-\d+)", read(UCS), re.M))
scr = {}
for cells in table_rows(read(UXF)):
    if re.fullmatch(r"SCR-[A-Z]+-\d+", cells[0]):
        scr[cells[0]] = cells[1]
adrs = {re.match(r"(ADR-\d+)", f).group(1) for f in os.listdir(ADRS) if f.startswith("ADR-")}
plan = read(PLAN)
sec4 = plan[plan.index("## 4. Epic"):plan.index("## 5. Build sequence")]
sec7 = plan[plan.index("## 7. Engineering"):plan.index("## 8. Risks")]
feat_rows = {}
for cells in table_rows(sec4):
    if re.fullmatch(r"FEAT-\d{3}", cells[0]) and len(cells) >= 6:
        feat_rows[cells[0]] = {
            "name": cells[1],
            "frs": set(expand_ids(cells[3], REQ_PREFIXES + ["NFR"])),
            "screens": set(expand_ids(cells[5], ["SCR-APP", "SCR-WGT", "SCR-OPS"])),
            "removed": "Removed" in cells[1],
        }
nfr_plan = defaultdict(set)  # NFR -> features from §7 table
nfr_generic = set()  # §7 rows that assign an NFR to "every ... feature"
for cells in table_rows(sec7):
    m = re.match(r"(NFR-\d+)", cells[0])
    if m and len(cells) > 1:
        nfr_plan[m.group(1)] |= set(re.findall(r"FEAT-\d{3}", cells[1]))
        if re.search(r"\bevery\b", cells[1]):
            nfr_generic.add(m.group(1))

rtm_text = read(RTM)
rtm = {}
for cells in table_rows(rtm_text):
    if re.fullmatch(r"[A-Z]+-\d+", cells[0]) and len(cells) == 9:
        rtm[cells[0]] = dict(zip(["id", "req", "pri", "status", "src", "uc", "design", "plan", "test"], cells))
removed = {r for r, v in rtm.items() if v["status"].startswith("Removed")}

feat_dirs = {}
for d in sorted(os.listdir(FEATURES)):
    m = re.match(r"(FEAT-\d{3})-", d)
    if m:
        feat_dirs[m.group(1)] = d

# ---------- Phase 2: checks ----------
# Resolution: every cited ID in docs resolves.
defined = {"REQ": set(req_pri), "UC": ucs, "SCR": set(scr), "ADR": adrs, "FEAT": set(feat_rows)}
cite_pat = {
    "REQ": re.compile(r"\b(?:%s)-\d+\b" % "|".join(REQ_PREFIXES)),
    "UC": re.compile(r"\bUC-\d+\b"),
    "SCR": re.compile(r"\bSCR-(?:APP|WGT|OPS)-\d+\b"),
    "ADR": re.compile(r"\bADR-\d+\b"),
    "FEAT": re.compile(r"\bFEAT-\d{3}\b"),
}
cited = defaultdict(lambda: defaultdict(set))  # ns -> id -> files
doc_files = []
for root, _, files in os.walk(DOCS):
    if "/archive" in root or "/reviews" in root:
        continue
    doc_files += [os.path.join(root, f) for f in files if f.endswith((".md", ".json"))]
for f in doc_files:
    t = read(f)
    for ns, p in cite_pat.items():
        for i in p.findall(t):
            cited[ns][i].add(f)
NEXT_FREE = re.compile(r"[Nn]ext free|free gap|have gaps|reserved|next ID|never reused|pipeline-verify-report")
counts = {}
for ns in cite_pat:
    unresolved = sorted(set(cited[ns]) - defined[ns])
    counts[ns] = (len(defined[ns]), len(cited[ns]), len(set(cited[ns]) & defined[ns]), len(unresolved))
    for i in unresolved:
        files = sorted(cited[ns][i])
        noted = all(any(NEXT_FREE.search(l) for l in read(f).split("\n") if i in l) for f in files)
        if noted:
            find("info", "—", f"{i} cited only in a next-free/gap note ({', '.join(files)})")
        else:
            find("error", "owner of citing doc", f"{i} doesn't resolve; cited in {', '.join(files)}")

# RTM integrity
for r in sorted(set(req_pri) - set(rtm)):
    find("error", "requirements-engineering", f"{r} is in the SRS but has no RTM row")
for r in sorted(set(rtm) - set(req_pri)):
    find("error", "requirements-engineering", f"RTM row {r} isn't in the SRS")
PRI = {"M": "Must", "S": "Should", "C": "Could"}
for r, v in rtm.items():
    p = req_pri.get(r)
    if p in PRI and v["pri"] != PRI[p]:
        find("error", "requirements-engineering", f"{r} priority RTM {v['pri']} vs SRS {PRI[p]}")

# RTM Plan ref -> plan §4 row (or §7 NFR table)
for r, v in rtm.items():
    for feat in sorted(set(re.findall(r"FEAT-\d{3}", v["plan"]))):
        row = feat_rows.get(feat)
        if not row:
            continue
        if r in row["frs"] or feat in nfr_plan.get(r, set()):
            continue
        if r in nfr_generic:
            find("info", "implementation-planning", f"RTM Plan ref of {r} names {feat}; §7 assigns {r} to every such feature")
            continue
        find("error", "implementation-planning", f"RTM Plan ref of {r} names {feat}, but its §4 row doesn't list {r}")
# plan §4 -> RTM Plan ref
for feat, row in feat_rows.items():
    for r in sorted(row["frs"]):
        if r in rtm and feat not in rtm[r]["plan"]:
            find("warning", "implementation-planning", f"§4 row {feat} lists {r}, but its RTM Plan ref doesn't name {feat}")

# Tombstones
for feat, row in feat_rows.items():
    for r in row["frs"] & removed:
        find("error", "implementation-planning", f"{feat} §4 row cites removed {r}")

# Feature folders
report_verdict = {}
for feat, d in feat_dirs.items():
    base = f"{FEATURES}/{d}"
    if feat not in feat_rows:
        find("error", "implementation-planning", f"folder {d} has no plan §4 row")
    for f in ("technical-design.md", "tasks.md"):
        if not os.path.exists(f"{base}/{f}"):
            find("error", "detailed-design", f"{d} has no {f}")
    ar = f"{base}/acceptance-report.md"
    if os.path.exists(ar):
        t = read(ar)
        m = re.search(r"^> (?:Current )?[Vv]erdict: \*\*([^*]+)", t, re.M) or re.search(
            r"## Verdict[^\n]*\n+(.*?)(?=\n## |\Z)", t, re.S)
        verdict = (m.group(1) if m else "").strip("* ")
        ok = re.search(r"\baccepted\b|meets its criteria", verdict, re.I) and not re.search(
            r"verdict: (rework|design defect)|\bnot accepted\b", verdict, re.I)
        report_verdict[feat] = "accepted" if ok else verdict
        if not ok:
            find("warning", "acceptance-verification", f"{feat} report verdict not Accepted: {verdict[:80]!r}")
    td = f"{base}/technical-design.md"
    if os.path.exists(td):
        line = next((l for l in read(td).split("\n") if re.match(r"^> *Implements:", l)), "")
        impl = set(cite_pat["REQ"].findall(line))  # Implements + "Also serves"
        credited = {r for r, v in rtm.items() if f"features/{d}/acceptance-report.md" in v["test"]}
        for r in sorted(credited - impl):
            find("info" if r.startswith("NFR-") else "warning", "detailed-design", f"{feat} Test ref credits {r}, not in its technical-design Implements:")

# Test refs resolve
for r, v in rtm.items():
    for p in re.findall(r"features/[\w.-]+/acceptance-report\.md", v["test"]):
        if not os.path.exists(f"{DOCS}/{p}"):
            find("error", "acceptance-verification", f"{r} Test ref cites missing {p}")

# NFR §7 assignments vs Test refs
for n, feats in sorted(nfr_plan.items()):
    for feat in sorted(feats):
        d = feat_dirs.get(feat)
        if d and feat in report_verdict and f"features/{d}/acceptance-report.md" not in rtm.get(n, {}).get("test", ""):
            find("warning", "acceptance-verification", f"§7 assigns {n} to accepted {feat}, but {n}'s Test ref has no entry for it")

# Manifest
man = json.load(open(MANIFEST))["screens"]
for sid, e in man.items():
    if sid not in scr:
        find("error", "ui-design", f"manifest screen {sid} isn't in the ux-foundations inventory")
    f = e.get("feature")
    if f and f != "anchor" and f not in feat_rows:
        find("error", "ui-design", f"manifest {sid} feature {f} isn't in the plan")
    if f in feat_rows and sid not in feat_rows[f]["screens"]:
        find("warning", "implementation-planning", f"manifest {sid} is built by {f}, but {f}'s §4 Screens column doesn't list it")
    src = e.get("source", {})
    locs = [src.get("spec"), src.get("prototype"), src.get("anchor")] + list(src.get("extended_by", []) or [])
    locs += list(e.get("extended_by", []) or []) + list(e.get("amended_by", []) or [])
    for loc in filter(None, locs):
        path, _, frag = loc.partition("#")
        full = f"{DOCS}/{path}"
        if not os.path.exists(full):
            find("error", "ui-design", f"manifest {sid} locator {loc}: file missing")
        elif frag and path.endswith(".md") and frag not in anchors_of(full):
            find("error", "ui-design", f"manifest {sid} locator {loc}: heading anchor missing")
# ui-design sections not referenced by the manifest
for feat, d in feat_dirs.items():
    ud = f"{FEATURES}/{d}/ui-design.md"
    if not os.path.exists(ud):
        continue
    for line in read(ud).split("\n"):
        m = re.match(r"^## (SCR-[A-Z]+-\d+)\b", line)
        if not m:
            continue
        sid = m.group(1)
        e = man.get(sid)
        if not e:
            find("warning", "ui-design", f"{d}/ui-design.md designs {sid}, which has no manifest entry")
            continue
        if f"features/{d}/ui-design.md" not in json.dumps(e):
            find("warning", "ui-design", f"{d}/ui-design.md has a section for {sid}, but the manifest entry ({e.get('feature')}) doesn't reference it")

# Value authority: design.md CSS block hex ⊆ tokens.json
tok = read(TOKENS).lower()
dz = read(DESIGN)
css = "\n".join(re.findall(r"```css\n(.*?)```", dz, re.S))
hexes = set(h.lower() for h in re.findall(r"#[0-9a-fA-F]{6}\b", css))
for h in sorted(hexes):
    if h not in tok:
        find("error", "ux-foundations", f"design.md CSS colour {h} isn't in tokens.json")
ux_hex = re.findall(r"#[0-9a-fA-F]{6}\b", read(UXF))
if ux_hex:
    find("warning", "ux-foundations", f"ux-foundations.md restates {len(ux_hex)} hex values")

# ---------- Phase 3: dashboard ----------
def lifecycle(r, v):
    plan_ref = v["plan"]
    feats = re.findall(r"FEAT-\d{3}", plan_ref)
    other = re.sub(r"FEAT-\d{3}|\(.*?\)|[,;\s]", "", plan_ref)
    designed = "yes" if "technical-design.md" in v["design"] else ("ADR only" if v["design"] not in ("", "_TBD_") else "no")
    entries = [e.strip() for e in v["test"].split(";") if "acceptance-report.md" in e]
    if not entries:
        return designed, "pending"
    full = not other and all(
        any(f"/{feat_dirs.get(f, '?')}/" in e and "(partial" not in e for e in entries) for f in feats
    )
    return designed, "fully" if full else "partially"


dash = Counter()
for r, v in rtm.items():
    if r in removed:
        continue
    kind = "NFR" if r.startswith("NFR-") else v["pri"]
    dash[(kind, lifecycle(r, v)[1])] += 1

# ---------- Output ----------
show_info = "--info" in sys.argv
print("Namespaces (defined / cited / resolved / unresolved):")
for ns, c in counts.items():
    print(f"  {ns:5} {c[0]:4} {c[1]:4} {c[2]:4} {c[3]:4}")
print(f"RTM rows {len(rtm)} | SRS IDs {len(req_pri)} | removed {sorted(removed)}")
print(f"Plan §4 features {len(feat_rows)} | feature folders {len(feat_dirs)} | accepted reports "
      f"{sum(1 for v in report_verdict.values() if v.lower().startswith('accepted'))}")
print(f"Manifest screens {len(man)} of {len(scr)} | design.md CSS hexes {len(hexes)}")
print("Requirements (strict Plan⨝Test rule):")
for kind in ("Must", "Should", "Could", "NFR"):
    print(f"  {kind:6} fully {dash[(kind,'fully')]:3} partially {dash[(kind,'partially')]:3} pending {dash[(kind,'pending')]:3}")
lv = Counter(f[0] for f in findings)
print(f"\nVerdict: {lv['error']} errors, {lv['warning']} warnings, {lv['info']} info")
for level in ("error", "warning") + (("info",) if show_info else ()):
    for _, owner, text in sorted(f for f in findings if f[0] == level):
        print(f"[{level.upper()}] ({owner}) {text}")
if "--json" in sys.argv:
    out = sys.argv[sys.argv.index("--json") + 1]
    json.dump({"findings": findings, "dash": {f"{k[0]}:{k[1]}": n for k, n in dash.items()},
               "lifecycle": {r: lifecycle(r, v) for r, v in rtm.items()}}, open(out, "w"), indent=1)
sys.exit(1 if lv["error"] else 0)
