import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/native-headers-release.yml", import.meta.url), "utf8");
function stepScript(name) {
  const block = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n      - /)[0];
  assert.ok(block, `Missing workflow step: ${name}`);
  const run = block.split("        run: |\n")[1];
  assert.ok(run, `Missing shell script: ${name}`);
  return run.split("\n").filter((line) => line.startsWith("          ")).map((line) => line.slice(10)).join("\n");
}
const preflight = stepScript("Check tag publishing before building");
const publish = stepScript("Push the fork release tag");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "paseo-tag-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git");
  const cwd = join(dir, "work");
  function git(...args) {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "--bare", remote);
  git("-C", remote, "config", "core.hooksPath", join(remote, "hooks"));
  git("init", cwd);
  git("-C", cwd, "config", "user.name", "Release test");
  git("-C", cwd, "config", "user.email", "release@example.invalid");
  git("-C", cwd, "remote", "add", "origin", remote);
  git("-C", cwd, "commit", "--allow-empty", "-m", "old");
  const old = git("-C", cwd, "rev-parse", "HEAD");
  git("-C", cwd, "commit", "--allow-empty", "-m", "new");
  const commit = git("-C", cwd, "rev-parse", "HEAD");
  const ref = "refs/tags/v0.8.0-native-headers";
  const output = join(dir, "output");
  writeFileSync(output, "");
  const env = { ...process.env, GH_TOKEN: "test-token", FORK_TAG: ref.slice(10), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_OUTPUT: output, COMMIT: commit, PREVIOUS_TAG: "" };
  const run = (script, extra = {}) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  const target = () => git("ls-remote", "--refs", remote, ref).split("\t")[0];
  const seed = (sha = old) => git("-C", cwd, "push", "--force", "origin", `${sha}:${ref}`);
  const rejectPushes = () => writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'simulated permission rejection' >&2\nexit 1\n", { mode: 0o755 });
  return { git, cwd, remote, ref, old, commit, output, run, target, seed, rejectPushes };
}

test("preflight runs before signing, dependencies and APK build", () => {
  const at = workflow.indexOf("      - name: Check tag publishing before building");
  for (const step of ["Configure APK signing", "Install JS dependencies", "Prebuild and assemble the release APK"]) {
    assert.ok(at < workflow.indexOf(`      - name: ${step}`));
  }
});

test("preflight checks real writes, cleans its probe, and preserves existing tag", (t) => {
  const f = fixture(t);
  f.seed();
  const result = f.run(preflight);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.target(), f.old);
  assert.equal(readFileSync(f.output, "utf8"), `previous_tag=${f.old}\n`);
  assert.equal(f.git("ls-remote", "--refs", f.remote, "refs/tags/native-headers-preflight-*"), "");
});

test("preflight rejects denied pushes before build and preserves existing tag", (t) => {
  const f = fixture(t);
  f.seed();
  f.rejectPushes();
  const result = f.run(preflight);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Tag publishing preflight failed/);
  assert.equal(f.target(), f.old);
});

test("preflight cleanup failure blocks build and names the leftover probe", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.remote, "hooks", "pre-receive"), '#!/bin/sh\nwhile read old new ref; do\n case "$new" in 0000000000000000000000000000000000000000) exit 1;; esac\ndone\n', { mode: 0o755 });
  const result = f.run(preflight);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Could not remove temporary tag/);
  assert.equal(f.target(), "");
});

test("publish creates a missing tag", (t) => {
  const f = fixture(t);
  const result = f.run(publish);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.target(), f.commit);
});

test("publish replaces an annotated tag using the exact ref object", (t) => {
  const f = fixture(t);
  f.git("-C", f.cwd, "tag", "-a", "old-release", f.old, "-m", "release");
  const tagObject = f.git("-C", f.cwd, "rev-parse", "refs/tags/old-release");
  f.seed(tagObject);
  assert.equal(f.run(preflight).status, 0);
  assert.equal(readFileSync(f.output, "utf8"), `previous_tag=${tagObject}\n`);
  const result = f.run(publish, { PREVIOUS_TAG: tagObject });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.target(), f.commit);
});

test("rejected publish leaves existing tag intact", (t) => {
  const f = fixture(t);
  f.seed();
  f.rejectPushes();
  assert.notEqual(f.run(publish, { PREVIOUS_TAG: f.old }).status, 0);
  assert.equal(f.target(), f.old);
});

test("publish refuses concurrent replacement of an existing tag", (t) => {
  const f = fixture(t);
  f.seed();
  f.git("-C", f.cwd, "commit", "--allow-empty", "-m", "concurrent");
  const concurrent = f.git("-C", f.cwd, "rev-parse", "HEAD");
  f.seed(concurrent);
  assert.notEqual(f.run(publish, { PREVIOUS_TAG: f.old }).status, 0);
  assert.equal(f.target(), concurrent);
});

test("publish refuses concurrent creation of a previously missing tag", (t) => {
  const f = fixture(t);
  f.seed();
  assert.notEqual(f.run(publish).status, 0);
  assert.equal(f.target(), f.old);
});
