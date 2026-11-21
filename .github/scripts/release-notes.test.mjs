import test from "node:test";
import assert from "node:assert/strict";
import { classify, previousRelease, readMarker, buildChanges, compareVersions } from "./release-notes.mjs";

test("commits are sorted into Added / Improved / Fixed / Removed / Maintenance", () => {
  assert.deepEqual(classify("feat: add channel info service for Twitch"), { section:"added", text:"Add channel info service for Twitch" });
  assert.equal(classify("feat: enhance VOD download progress").section, "improved");
  assert.equal(classify("feat: implement CPU auto-tuning").section, "added");
  assert.equal(classify("fix: thread_queue_size rejected by FFmpeg").section, "fixed");
  assert.equal(classify("Fix Linux .deb packaging failure in CI").section, "fixed");
  assert.equal(classify("feat: remove classic MPEG-TS HLS support").section, "removed");
  assert.equal(classify("CI: run CastNexus Release on GitHub-hosted runners").section, "maintenance");
  assert.equal(classify("docs: update INSTALL").section, "maintenance");
  assert.equal(classify("perf(compositor): cache frames").section, "improved");
  assert.equal(classify("Update Discord Activity documentation [skip ci]").text, "Update Discord Activity documentation");
});

test("beta compares with the previous release; stable with the previous stable", () => {
  const releases = [
    { tag_name:"v1.4.0-beta.19", prerelease:true }, { tag_name:"v1.4.0-beta.18", prerelease:true },
    { tag_name:"v1.3.3", prerelease:false }, { tag_name:"v1.3.2", prerelease:false }, { tag_name:"v1.5.0", prerelease:false, draft:true },
  ];
  assert.equal(previousRelease(releases, { version:"1.4.0-beta.20", channel:"beta" }).tag_name, "v1.4.0-beta.19");
  assert.equal(previousRelease(releases, { version:"1.4.0", channel:"stable" }).tag_name, "v1.3.3");
  assert.equal(previousRelease(releases, { version:"1.4.0-beta.19", channel:"beta" }).tag_name, "v1.4.0-beta.18", "re-running for an existing tag skips itself");
  assert.equal(compareVersions("1.4.0", "1.4.0-beta.19"), 1);
});

test("branch marker round-trips and changes are deduplicated across branches", () => {
  assert.deepEqual(readMarker("notes\n<!-- castnexus-branches: {\"dashboard\":\"abc\"} -->"), { dashboard:"abc" });
  assert.equal(readMarker("no marker"), null);
  const md = buildChanges([
    { sha:"a".repeat(40), subject:"feat: add YouTube overlay layer", branch:"dashboard" },
    { sha:"b".repeat(40), subject:"feat: add YouTube overlay layer", branch:"desktopapp" },
    { sha:"c".repeat(40), subject:"chore: bump version to 1.4.0 [skip ci]", branch:"main" },
    { sha:"d".repeat(40), subject:"fix: dropdown background", branch:"dashboard" },
  ], { repo:"o/r", previousTag:"v1.4.0-beta.19" });
  assert.match(md, /### ✨ Added\n\n- \*\*Studio:\*\* Add YouTube overlay layer/);
  assert.equal(md.split("Add YouTube overlay layer").length - 1, 1);
  assert.match(md, /### 🐛 Fixed/);
  assert.doesNotMatch(md, /bump version/);
  assert.match(buildChanges([], { repo:"o/r", previousTag:"v1" }), /No code changes/);
});

test("commits are labelled by the folder they changed, not the (shared) branch", async () => {
  const { componentFor } = await import("./release-notes.mjs");
  assert.equal(componentFor(["dashboard/compositor.js", "dashboard/package-lock.json"], ["cli", "dashboard"]), "Studio");
  assert.equal(componentFor(["electron/main.js"], ["desktopapp"]), "Desktop app");
  assert.equal(componentFor(["docker-compose.yml", "install.sh"], ["docker"]), "Docker");
  assert.equal(componentFor(["README.md"], ["cli", "dashboard", "docker"]), "General");
});

test("an empty --highlights stays empty", async () => {
  const { parseArgs } = await import("./release-notes.mjs");
  assert.deepEqual(parseArgs(["--version", "1.0.0", "--highlights", "", "--out", "x.md"]), { version:"1.0.0", highlights:"", out:"x.md" });
});
