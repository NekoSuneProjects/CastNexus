#!/usr/bin/env node
// Builds the "what changed" part of a CastNexus release from git history.
//
// CastNexus keeps each component on its own branch (dashboard, desktopapp,
// cli, docker, oauth-broker, ...) and commits are pushed directly, so GitHub's
// generated notes (pull requests only, main branch only) came out empty.
// This script reads every branch instead:
//
//   1. Finds the previous release (beta: the previous release of any kind;
//      stable: the previous stable, so it collects everything since then).
//   2. Reads the branch heads that release recorded in a hidden marker
//      (<!-- castnexus-branches: {...} -->). Releases without a marker fall
//      back to "commits since the previous release date".
//   3. Groups the new commits into Added / Improved / Fixed / Removed /
//      Maintenance from their conventional-commit prefix and wording.
//   4. Prints Markdown, ending with a new marker for the next release.
//
// Usage (needs full history: actions/checkout with fetch-depth: 0):
//   node .github/scripts/release-notes.mjs --version 1.4.0-beta.20 --channel beta \
//        --repo owner/name [--git-dir path] [--highlights "text"] [--out file.md]
// GITHUB_TOKEN / GH_TOKEN is used to read previous releases.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const MARKER = /<!--\s*castnexus-branches:\s*(\{[\s\S]*?\})\s*-->/;
const COMPONENTS = {
  dashboard:"Studio", desktopapp:"Desktop app", cli:"CLI", docker:"Docker", "oauth-broker":"OAuth broker",
  dns:"Console DNS", intercept:"Console intercept", relaystream:"Relaystream", "vrchat-relay":"VRChat relay", main:"Release & packaging",
};
const SECTIONS = [
  ["added", "✨ Added"],
  ["improved", "🛠 Improved"],
  ["fixed", "🐛 Fixed"],
  ["removed", "🗑 Removed"],
  ["maintenance", "🔧 Maintenance"],
];

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

// ---------------------------------------------------------- versions
export function parseVersion(tag) {
  const m = String(tag || "").replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  return m ? { nums:[+m[1], +m[2], +m[3]], pre:m[4] || "" } : null;
}
function comparePre(a, b) {
  const x = a.split("."), y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    if (x[i] === y[i]) continue;
    const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
    if (xn && yn) return +x[i] > +y[i] ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return comparePre(x.pre, y.pre);
}

// The release this one is compared against.
export function previousRelease(releases, { version, channel }) {
  const current = `v${String(version).replace(/^v/i, "")}`;
  return (releases || [])
    .filter(r => !r.draft && parseVersion(r.tag_name) && r.tag_name !== current && compareVersions(r.tag_name, current) < 0)
    .filter(r => channel === "stable" ? !r.prerelease : true)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] || null;
}

export function readMarker(body) {
  const m = MARKER.exec(String(body || ""));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// ---------------------------------------------------------- commits
const SKIP = [
  /^chore(\(.+\))?: (sync|bump) version/i,
  /^merge (branch|pull request|remote-tracking)/i,
  /^bump version to /i,
];

export function classify(subject) {
  const m = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/.exec(subject.trim());
  const type = m ? m[1].toLowerCase() : "";
  const text = (m ? m[4] : subject).trim();
  const lower = text.toLowerCase();
  let section;
  if (/^(remove|removed|delete|deleted|drop|dropped|deprecate)\b/.test(lower)) section = "removed";
  else if (type === "fix" || type === "hotfix" || /^(fix|fixed|fixes|resolve|resolved|correct)\b/.test(lower)) section = "fixed";
  else if (["chore", "ci", "build", "test", "tests", "docs", "doc", "style"].includes(type) || /^(ci|docs?|test)\b/.test(lower)) section = "maintenance";
  else if (type === "feat" && /^(add|added|adds|implement|implemented|introduce|new|support|create)\b/.test(lower)) section = "added";
  else if (["perf", "refactor"].includes(type) || /^(enhance|enhanced|improve|improved|update|updated|refactor|optimi[sz]e|rework|change|tweak|streamline|polish|move|rename)\b/.test(lower)) section = "improved";
  else if (type === "feat") section = "added";
  else if (/^(add|added|implement|introduce|new|support)\b/.test(lower)) section = "added";
  else section = "improved";
  const clean = text.replace(/\s*\[skip ci\]\s*/gi, " ").replace(/\s+/g, " ").trim();
  return { section, text:clean.charAt(0).toUpperCase() + clean.slice(1) };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding:"utf8", maxBuffer:64 * 1024 * 1024 });
}

// Only the component branches (snapshot / experiment branches are ignored).
export function listBranches(cwd) {
  return git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], cwd)
    .split("\n").map(s => s.trim().replace(/^origin\//, ""))
    .filter(b => Object.prototype.hasOwnProperty.call(COMPONENTS, b));
}

function isAncestor(cwd, sha, ref) {
  try { git(["merge-base", "--is-ancestor", sha, ref], cwd); return true; } catch { return false; }
}

export function commitsFor(cwd, branch, { since = null, fromSha = null } = {}) {
  const ref = `origin/${branch}`;
  const range = fromSha && isAncestor(cwd, fromSha, ref) ? [`${fromSha}..${ref}`] : [ref, ...(since ? [`--since=${since}`] : ["-n", "0"])];
  const raw = git(["log", "--no-merges", "--format=%H%x1f%s%x1e", ...range], cwd);
  return raw.split("\x1e").map(s => s.trim()).filter(Boolean).map(line => {
    const [sha, subject] = line.split("\x1f");
    return { sha, subject:subject || "" };
  });
}

// ---------------------------------------------------------- markdown
export function buildChanges(entries, { repo, previousTag = null }) {
  const groups = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
  const seen = new Set();
  for (const e of entries) {
    if (SKIP.some(re => re.test(e.subject))) continue;
    const { section, text } = classify(e.subject);
    const key = text.toLowerCase();
    if (seen.has(key)) continue; // same change pushed to several branches
    seen.add(key);
    groups[section].push(`- **${COMPONENTS[e.branch] || e.branch}:** ${text} ([\`${e.sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${e.sha}))`);
  }
  const out = [];
  const total = SECTIONS.reduce((n, [k]) => n + groups[k].length, 0);
  out.push(`## What's changed${previousTag ? ` since ${previousTag}` : ""}`, "");
  if (!total) { out.push("_No code changes since the previous release._", ""); return out.join("\n"); }
  for (const [key, title] of SECTIONS) {
    if (!groups[key].length) continue;
    if (key === "maintenance") out.push("<details><summary>🔧 Maintenance (" + groups[key].length + ")</summary>", "", ...groups[key], "", "</details>", "");
    else out.push(`### ${title}`, "", ...groups[key], "");
  }
  return out.join("\n");
}

async function fetchReleases(repo, token) {
  const headers = { Accept:"application/vnd.github+json", "User-Agent":"castnexus-release-notes", ...(token ? { Authorization:`Bearer ${token}` } : {}) };
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
  if (!res.ok) throw new Error(`GitHub releases request failed (${res.status})`);
  return res.json();
}

export async function generate({ version, channel = "beta", repo, cwd = process.cwd(), highlights = "", releases = null, token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN }) {
  const all = releases || await fetchReleases(repo, token);
  const prev = previousRelease(all, { version, channel });
  const marker = prev ? readMarker(prev.body) : null;
  const since = prev ? (prev.published_at || prev.created_at) : null;
  const branches = listBranches(cwd);
  const entries = [];
  const heads = {};
  for (const branch of branches) {
    heads[branch] = git(["rev-parse", `origin/${branch}`], cwd).trim();
    if (!prev) continue; // first release ever: no history to diff against
    for (const c of commitsFor(cwd, branch, { since, fromSha:marker?.[branch] || null })) entries.push({ ...c, branch });
  }
  const parts = [];
  if (String(highlights || "").trim()) parts.push("## Highlights", "", String(highlights).trim().replace(/\\n/g, "\n"), "");
  parts.push(prev ? buildChanges(entries, { repo, previousTag:prev.tag_name }) : "## What's changed\n\n_First release._\n");
  parts.push(`<!-- castnexus-branches: ${JSON.stringify(heads)} -->`);
  return { markdown:parts.join("\n"), previous:prev?.tag_name || null, count:entries.length };
}

// Run as a CLI only when executed directly (tests import the functions).
if (String(process.argv[1] || "").replace(/\\/g, "/").endsWith("/release-notes.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version || !args.repo) { console.error("usage: --version X --repo owner/name [--channel beta|stable] [--git-dir path] [--highlights text] [--out file]"); process.exit(2); }
  generate({ version:args.version, channel:args.channel || "beta", repo:args.repo, cwd:args["git-dir"] || process.cwd(), highlights:args.highlights || "" })
    .then(({ markdown, previous, count }) => {
      if (args.out) writeFileSync(args.out, markdown + "\n");
      else process.stdout.write(markdown + "\n");
      console.error(`[release-notes] ${count} commit(s) since ${previous || "(none)"}`);
    })
    .catch(err => { console.error(`[release-notes] ${err.message}`); process.exit(1); });
}
