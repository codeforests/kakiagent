#!/usr/bin/env node
// Checks that the RTM (docs/01-requirements/rtm.md) carries every feature's refs.
//
//   node scripts/check-rtm.mjs                         every feature (run by `pnpm lint`)
//   node scripts/check-rtm.mjs FEAT-045                one feature
//   node scripts/check-rtm.mjs FEAT-045 --stage verify also require the acceptance report,
//                                                      tasks.md status `accepted` and Test refs
//   node scripts/check-rtm.mjs --fix                   append the missing Design and Plan refs
//
// A feature's requirements are the IDs in its technical-design.md "Implements:" segment
// (up to the first " · "). For each one:
//   - the row exists and isn't Removed;
//   - Design ref names features/<dir>/technical-design.md (detailed design appends it);
//   - Plan ref names the feature;
//   - once features/<dir>/acceptance-report.md exists, Test ref cites it (verify appends it).
// For every row, each acceptance report its Test ref cites must exist, and that feature
// must also be in the row's Plan ref and its technical design in the row's Design ref.
// --fix appends the Design and Plan refs (never Test refs: those need the verifier's
// judgement of full or partial). Exit 1 if anything is missing.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RTM = 'docs/01-requirements/rtm.md';
const FEATURES = 'docs/features';

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const stageIdx = args.indexOf('--stage');
const stage = stageIdx >= 0 ? args[stageIdx + 1] : undefined;
const only = args.filter((a) => /^FEAT-\d{3}$/.test(a));
if (stageIdx >= 0 && stage !== 'verify') {
  console.error('--stage takes only "verify"');
  process.exit(2);
}
if (stage === 'verify' && only.length === 0) {
  console.error('--stage verify needs the feature ID, e.g. FEAT-045');
  process.exit(2);
}

const COL = { id: 0, status: 3, design: 6, plan: 7, test: 8 };
const lines = readFileSync(RTM, 'utf8').split('\n');
const rows = new Map(); // req ID -> { index, cells }
lines.forEach((line, index) => {
  const m = /^\| ([A-Z]+-\d+) \|/.exec(line);
  if (!m) return;
  const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split(' | ');
  cells[0] = cells[0].trim();
  cells[cells.length - 1] = cells[cells.length - 1].trim();
  if (cells.length !== 9) {
    console.error(`${RTM}:${index + 1}: ${m[1]} has ${cells.length} cells, expected 9`);
    process.exit(1);
  }
  rows.set(m[1], { index, cells });
});
const prefixes = [...new Set([...rows.keys()].map((id) => id.split('-')[0]))];
const reqPattern = new RegExp(`\\b(?:${prefixes.join('|')})-\\d+\\b`, 'g');

const dirs = new Map(); // FEAT-NNN -> dir name
for (const d of readdirSync(FEATURES)) {
  const m = /^(FEAT-\d{3})-/.exec(d);
  if (m) dirs.set(m[1], d);
}

const problems = new Set();
const fixed = [];
const append = (row, col, text, sep) => {
  const cell = row.cells[col];
  row.cells[col] = cell === '_TBD_' ? text : `${cell}${sep}${text}`;
  lines[row.index] = `| ${row.cells.join(' | ')} |`;
};
const featIdIn = (cell, feat) => new RegExp(`\\b${feat}\\b`).test(cell);

function implementsOf(dir) {
  const path = join(FEATURES, dir, 'technical-design.md');
  if (!existsSync(path)) return null;
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((l) => /^> *Implements:/.test(l));
  if (!line) return [];
  const segment = line.replace(/^> *Implements:/, '').split(' · ')[0];
  return [...new Set(segment.match(reqPattern) ?? [])];
}

function checkDesignAndPlan(feat, dir, id, row, why) {
  const design = `features/${dir}/technical-design.md`;
  if (!row.cells[COL.design].includes(design)) {
    if (fix) {
      append(row, COL.design, design, '; ');
      const ui = `features/${dir}/ui-design.md`;
      if (existsSync(join(FEATURES, dir, 'ui-design.md')) && !row.cells[COL.design].includes(ui))
        append(row, COL.design, ui, '; ');
      fixed.push(`${id}: Design ref += ${design}`);
    } else problems.add(`${id}: Design ref lacks ${design} (${why})`);
  }
  if (!featIdIn(row.cells[COL.plan], feat)) {
    if (fix) {
      append(row, COL.plan, feat, ', ');
      fixed.push(`${id}: Plan ref += ${feat}`);
    } else problems.add(`${id}: Plan ref lacks ${feat} (${why})`);
  }
}

const featuresToCheck = only.length ? only : [...dirs.keys()].sort();
for (const feat of featuresToCheck) {
  const dir = dirs.get(feat);
  if (!dir) {
    problems.add(`${feat}: no docs/features/${feat}-*/ folder`);
    continue;
  }
  const reqs = implementsOf(dir);
  if (reqs === null) {
    problems.add(`${feat}: no technical-design.md`);
    continue;
  }
  if (reqs.length === 0) {
    problems.add(`${feat}: technical-design.md has no "> Implements:" line naming requirement IDs`);
    continue;
  }
  const report = `features/${dir}/acceptance-report.md`;
  const reportExists = existsSync(join('docs', report));
  if (stage === 'verify') {
    if (!reportExists) problems.add(`${feat}: no ${report}`);
    const tasks = join(FEATURES, dir, 'tasks.md');
    const status = existsSync(tasks) && /Status: *`?([a-z-]+)/.exec(readFileSync(tasks, 'utf8'));
    if (!status || status[1] !== 'accepted')
      problems.add(
        `${feat}: tasks.md status is ${status ? status[1] : 'missing'}, expected accepted`,
      );
  }
  for (const id of reqs) {
    const row = rows.get(id);
    if (!row) {
      problems.add(`${feat}: implements ${id}, which has no RTM row`);
      continue;
    }
    if (row.cells[COL.status].startsWith('Removed')) {
      problems.add(`${feat}: implements ${id}, which is ${row.cells[COL.status]}`);
      continue;
    }
    checkDesignAndPlan(feat, dir, id, row, `${feat} implements it`);
    if (reportExists && !row.cells[COL.test].includes(report))
      problems.add(`${id}: Test ref lacks ${report} (${feat} implements it and has a report)`);
  }
}

// Test refs must point at real reports of features the row's Design and Plan refs name.
for (const [id, row] of rows) {
  for (const m of row.cells[COL.test].matchAll(
    /features\/((FEAT-\d{3})-[a-z0-9-]+)\/acceptance-report\.md/g,
  )) {
    const [, dir, feat] = m;
    if (only.length && !only.includes(feat)) continue;
    if (!existsSync(join(FEATURES, dir, 'acceptance-report.md'))) {
      problems.add(`${id}: Test ref cites ${m[0]}, which doesn't exist`);
      continue;
    }
    checkDesignAndPlan(feat, dir, id, row, `its Test ref cites ${feat}'s report`);
  }
}

if (fix && fixed.length) {
  writeFileSync(RTM, lines.join('\n'));
  console.log(`Fixed ${fixed.length} refs in ${RTM}:\n  ${fixed.join('\n  ')}`);
}
if (problems.size) {
  console.error(`RTM check failed (${problems.size}):\n  ${[...problems].join('\n  ')}`);
  if (!fix)
    console.error(
      'Design and Plan refs: run with --fix. Test refs: the verify stage appends them.',
    );
  process.exit(1);
}
console.log(
  `RTM check passed (${only.length ? only.join(', ') : `${featuresToCheck.length} features`}).`,
);
