import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  new URL("../.github/workflows/native-headers-release.yml", import.meta.url),
  "utf8",
);
function stepScript(name) {
  const block = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n      - /)[0];
  assert.ok(block, `Missing workflow step: ${name}`);
  const run = block.split("        run: |\n")[1];
  assert.ok(run, `Missing shell script: ${name}`);
  return run
    .split("\n")
    .filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n");
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
  const env = {
    ...process.env,
    GH_TOKEN: "test-token",
    FORK_TAG: ref.slice(10),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_OUTPUT: output,
    COMMIT: commit,
    PREVIOUS_TAG: "",
  };
  const run = (script, extra = {}) =>
    spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      cwd,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  const target = () => git("ls-remote", "--refs", remote, ref).split("\t")[0];
  const seed = (sha = old) => git("-C", cwd, "push", "--force", "origin", `${sha}:${ref}`);
  const rejectPushes = () =>
    writeFileSync(
      join(remote, "hooks", "pre-receive"),
      "#!/bin/sh\necho 'simulated permission rejection' >&2\nexit 1\n",
      { mode: 0o755 },
    );
  return { git, cwd, remote, ref, old, commit, output, run, target, seed, rejectPushes };
}

test("preflight runs before signing, dependencies and APK build", () => {
  const at = workflow.indexOf("      - name: Check tag publishing before building");
  for (const step of [
    "Configure APK signing",
    "Install JS dependencies",
    "Prebuild and assemble the release APK",
  ]) {
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
  writeFileSync(
    join(f.remote, "hooks", "pre-receive"),
    '#!/bin/sh\nwhile read old new ref; do\n case "$new" in 0000000000000000000000000000000000000000) exit 1;; esac\ndone\n',
    { mode: 0o755 },
  );
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

const applyTestBranch = fileURLToPath(
  new URL("./native-headers-apply-test-branch.sh", import.meta.url),
);

// Work tree detached at tag v1 plus the feature commit, as the source step leaves it.
// Test branches are built from v1 in the same repo and pushed to a bare origin.
function replayFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "paseo-test-branch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git");
  const cwd = join(dir, "work");
  function git(...args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  for (const args of [
    ["init", "-q", "--bare", remote],
    ["init", "-q", cwd],
  ]) {
    assert.equal(spawnSync("git", args, { cwd: dir }).status, 0);
  }
  const config = [
    ["user.name", "Release test"],
    ["user.email", "release@example.invalid"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ];
  for (const [key, value] of config) git("config", key, value);
  git("remote", "add", "origin", remote);
  function commit(file, content, message) {
    writeFileSync(join(cwd, file), content);
    git("add", file);
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  }
  const root = commit("a.txt", "root\n", "root");
  commit("a.txt", "base\n", "base");
  git("tag", "-a", "v1", "-m", "v1");
  git("checkout", "-q", "-b", "feat", "v1");
  const feature = commit("feature.txt", "feature\n", "feature");
  const releaseTree = () => {
    git("checkout", "-q", "--detach", "v1");
    git("cherry-pick", "-x", feature);
  };
  // Pushes the branch that `build` creates from `from`, then restores the release tree.
  function branch(name, from, build) {
    git("checkout", "-q", "-B", name, from);
    build();
    git("push", "-q", "origin", `${name}:refs/heads/${name}`);
    releaseTree();
  }
  releaseTree();
  const run = (name) => spawnSync("bash", [applyTestBranch, "v1", name], { cwd, encoding: "utf8" });
  const head = () => git("rev-parse", "HEAD");
  const clean = () =>
    git("status", "--porcelain") === "" &&
    spawnSync("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], { cwd }).status !== 0;
  return { git, commit, branch, run, head, clean, root, feature };
}

test("source step replays the test branch through the tested script", () => {
  assert.match(
    stepScript("Prepare and test release workflow tools"),
    /cp scripts\/native-headers-apply-test-branch\.sh "\$RUNNER_TEMP\/release-tools\/apply-test-branch\.sh"/,
  );
  assert.match(
    stepScript("Build the source tree for the release"),
    /test_commits="\$\(bash "\$RUNNER_TEMP\/release-tools\/apply-test-branch\.sh" "\$TAG" "\$TEST_BRANCH"\)"/,
  );
});

test("test branch replay applies each commit in order and prints their short shas", (t) => {
  const f = replayFixture(t);
  let one;
  let two;
  f.branch("wip", "v1", () => {
    one = f.commit("one.txt", "one\n", "one");
    two = f.commit("two.txt", "two\n", "two");
  });
  const before = f.head();
  const result = f.run("wip");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${one.slice(0, 9)}, ${two.slice(0, 9)}\n`);
  assert.equal(f.git("log", "--format=%s", `${before}..HEAD`), "two\none");
});

test("test branch replay skips a commit that is already applied", (t) => {
  const f = replayFixture(t);
  let one;
  f.branch("wip", "v1", () => {
    f.git("cherry-pick", f.feature);
    one = f.commit("one.txt", "one\n", "one");
  });
  const result = f.run("wip");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${one.slice(0, 9)}\n`);
  assert.match(result.stderr, /is already applied; skipped/);
});

test("test branch replay rejects merge commits and changes nothing", (t) => {
  const f = replayFixture(t);
  let merge;
  f.branch("side", "v1", () => f.commit("side.txt", "side\n", "side"));
  f.branch("wip", "v1", () => {
    f.commit("one.txt", "one\n", "one");
    f.git("merge", "-q", "--no-ff", "--no-edit", "side");
    merge = f.head();
  });
  const before = f.head();
  const result = f.run("wip");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(
      `::error::Test branch wip has merge commits on top of v1: ${merge.slice(0, 9)}\\. Rebase it onto v1`,
    ),
  );
  assert.equal(result.stdout, "");
  assert.equal(f.head(), before);
  assert.ok(f.clean());
});

test("test branch replay rejects a branch not based on the tag", (t) => {
  const f = replayFixture(t);
  f.branch("stale", f.root, () => f.commit("one.txt", "one\n", "one"));
  const before = f.head();
  const result = f.run("stale");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::Test branch stale is not based on upstream v1\./);
  assert.equal(result.stdout, "");
  assert.equal(f.head(), before);
});

test("test branch replay aborts a conflict and names the commit and file", (t) => {
  const f = replayFixture(t);
  let clash;
  f.branch("clash", "v1", () => {
    clash = f.commit("feature.txt", "different\n", "clash");
  });
  const before = f.head();
  const result = f.run("clash");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(
      `::error::Cherry-picking test commit ${clash} from clash conflicted in: feature\\.txt\\.`,
    ),
  );
  assert.equal(result.stdout, "");
  assert.equal(f.head(), before);
  assert.ok(f.clean());
});

test("test branch replay fails when no commits are left to apply", (t) => {
  const f = replayFixture(t);
  f.branch("same", "v1", () => f.git("cherry-pick", f.feature));
  const result = f.run("same");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::Test branch same has no commits left to apply/);
  assert.equal(result.stdout, "");
});

// Runs the resolve step with a fake gh that records its calls and reports
// whether the fork release exists.
function resolveRun(t, { releaseExists, ...inputs }) {
  const dir = mkdtempSync(join(tmpdir(), "paseo-resolve-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, "gh-calls");
  writeFileSync(calls, "");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh\necho "$*" >> "${calls}"\n[ "$1 $2" = "release view" ] && exit ${releaseExists ? 0 : 1}\nexit 0\n`,
    { mode: 0o755 },
  );
  const output = join(dir, "output");
  writeFileSync(output, "");
  const result = spawnSync(
    "bash",
    ["-e", "-o", "pipefail", "-c", stepScript("Resolve the upstream tag and the fork release tag")],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        UPSTREAM_REPO: "getpaseo/paseo",
        GITHUB_REPOSITORY: "ThePharmer/paseo",
        GITHUB_OUTPUT: output,
        INPUT_TAG: "v1.2.3",
        FORCE: "",
        TEST_BRANCH: "",
        PUBLISH: "",
        ...inputs,
      },
      encoding: "utf8",
    },
  );
  const written = readFileSync(output, "utf8").trim();
  const outputs = Object.fromEntries(
    (written ? written.split("\n") : []).map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  return {
    status: result.status,
    log: result.stdout + result.stderr,
    outputs,
    ghCalls: readFileSync(calls, "utf8"),
  };
}
function resolveOk(t, inputs) {
  const run = resolveRun(t, inputs);
  assert.equal(run.status, 0, run.log);
  return run;
}

test("resolve rejects an invalid test branch before anything runs", (t) => {
  const run = resolveRun(t, { releaseExists: false, TEST_BRANCH: "feat/bad..name" });
  assert.notEqual(run.status, 0);
  assert.match(run.log, /::error::test_branch 'feat\/bad\.\.name' is not a valid branch name\./);
  assert.deepEqual(run.outputs, {});
});

test("scheduled runs publish arm64-only APKs and skip existing releases", (t) => {
  const { outputs } = resolveOk(t, { releaseExists: true });
  assert.equal(outputs.publish, "true");
  assert.equal(outputs.abis, "arm64-v8a");
  assert.equal(outputs.fork_tag, "v1.2.3-native-headers");
  assert.equal(outputs.needed, "false");
});

test("daily dispatches build a missing release for arm64 only", (t) => {
  const { outputs } = resolveOk(t, { releaseExists: false, PUBLISH: "true" });
  assert.equal(outputs.publish, "true");
  assert.equal(outputs.abis, "arm64-v8a");
  assert.equal(outputs.needed, "true");
});

test("test builds are universal and never consult the daily release", (t) => {
  const { outputs, ghCalls } = resolveOk(t, {
    releaseExists: true,
    PUBLISH: "true",
    TEST_BRANCH: "feat/editor",
  });
  assert.equal(outputs.fork_tag, "v1.2.3-native-headers-test");
  assert.equal(outputs.abis, "arm64-v8a,x86_64");
  assert.equal(outputs.test_branch, "feat/editor");
  assert.equal(outputs.publish, "true");
  assert.equal(outputs.needed, "true");
  assert.equal(ghCalls, "");
});

test("artifact-only runs always build, even when the release exists", (t) => {
  const daily = resolveOk(t, { releaseExists: true, PUBLISH: "false" });
  assert.equal(daily.outputs.publish, "false");
  assert.equal(daily.outputs.needed, "true");
  assert.equal(daily.outputs.abis, "arm64-v8a");
  assert.equal(daily.ghCalls, "");
  const testBuild = resolveOk(t, {
    releaseExists: true,
    PUBLISH: "false",
    TEST_BRANCH: "feat/editor",
  });
  assert.equal(testBuild.outputs.publish, "false");
  assert.equal(testBuild.outputs.abis, "arm64-v8a,x86_64");
});

function stepBlock(name) {
  const block = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n      - /)[0];
  assert.ok(block, `Missing workflow step: ${name}`);
  return block;
}
function jobBlock(name) {
  const block = workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z0-9_-]+:\n/)[0];
  assert.ok(block, `Missing workflow job: ${name}`);
  return block;
}
const publishGate = "if: needs.resolve.outputs.publish == 'true'";

test("artifact-only runs create no App token, probe tag, fork tag, or release", () => {
  for (const step of [
    "Create App token for publishing preflight",
    "Check tag publishing before building",
    "Create App token for release tag publishing",
    "Push the fork release tag",
  ]) {
    assert.ok(stepBlock(step).includes(`        ${publishGate}\n`), `${step} is not gated`);
  }
  assert.ok(jobBlock("release").includes(`    ${publishGate}\n`), "release job is not gated");
  const tokenUses = workflow.split("create-github-app-token@").length - 1;
  assert.equal(tokenUses, 2, "gate any new App token step on publish, then count it here");
});

test("the APK is built for the ABIs that resolve chose", () => {
  assert.match(
    stepScript("Prebuild and assemble the release APK"),
    /-PreactNativeArchitectures="\$ABIS"/,
  );
  assert.match(
    stepBlock("Prebuild and assemble the release APK"),
    /ABIS: \$\{\{ needs\.resolve\.outputs\.abis \}\}/,
  );
});

test("finished test builds start the Android E2E workflow on their own ref", () => {
  const job = jobBlock("e2e");
  // It needs the release job, which artifact-only runs skip; without a status
  // function in its condition the hand-off would be skipped with it.
  assert.match(job, /\n    if: \$\{\{ !cancelled\(\) && /);
  assert.match(job, /needs\.resolve\.outputs\.test_branch != ''/);
  assert.match(job, /needs\.build\.result == 'success'/);
  assert.match(job, /gh workflow run android-e2e\.yml/);
  assert.match(job, /--ref "\$GITHUB_REF_NAME"/);
  assert.match(job, /-f build_run_id="\$GITHUB_RUN_ID"/);
});

// Runs the record step in the fixture's work tree and returns what it wrote.
function recordSource(t, f, env) {
  const dir = mkdtempSync(join(tmpdir(), "paseo-source-bundle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(
    "bash",
    ["-e", "-o", "pipefail", "-c", stepScript("Record the built source for Android E2E")],
    {
      cwd: f.git("rev-parse", "--show-toplevel"),
      env: {
        ...process.env,
        RUNNER_TEMP: dir,
        UPSTREAM_REPO: "getpaseo/paseo",
        TAG: "v1",
        FORK_TAG: "v1-native-headers-test",
        TEST_BRANCH: "",
        TEST_COMMITS: "",
        PUBLISH: "false",
        ABIS: "arm64-v8a,x86_64",
        ...env,
      },
      encoding: "utf8",
    },
  );
  const out = join(dir, "build-source");
  const info = () => JSON.parse(readFileSync(join(out, "build-info.json"), "utf8"));
  return { result, out, dir, info };
}

test("the recorded source bundle rebuilds the exact commit from the upstream tag", (t) => {
  const f = replayFixture(t);
  let one;
  f.branch("wip", "v1", () => {
    one = f.commit("one.txt", "one\n", "one");
  });
  f.git("cherry-pick", "-x", one);
  const commit = f.head();
  const env = { TEST_BRANCH: "wip", TEST_COMMITS: one.slice(0, 9), COMMIT: commit };

  const stale = recordSource(t, f, { ...env, COMMIT: f.feature }).result;
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout, /HEAD is not the built commit/);

  const { result, out, info } = recordSource(t, f, env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(info(), {
    commit,
    source_bundle: true,
    upstream_repo: "getpaseo/paseo",
    tag: "v1",
    fork_tag: "v1-native-headers-test",
    test_branch: "wip",
    test_commits: one.slice(0, 9),
    published: false,
    abis: ["arm64-v8a", "x86_64"],
  });

  // The E2E side: a repository holding only the tag, then the bundle.
  const clone = join(out, "..", "clone");
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: clone, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(spawnSync("git", ["init", "-q", clone]).status, 0);
  git(
    "fetch",
    "-q",
    "--depth=1",
    f.git("rev-parse", "--show-toplevel"),
    "refs/tags/v1:refs/tags/v1",
  );
  git("fetch", "-q", join(out, "source.bundle"), "HEAD");
  assert.equal(git("rev-parse", "FETCH_HEAD"), commit);
});

test("a build of the bare upstream tag records no bundle instead of failing", (t) => {
  const f = replayFixture(t);
  f.git("checkout", "-q", "--detach", "v1");
  const tagCommit = f.head();
  const { result, out, info } = recordSource(t, f, { COMMIT: tagCommit });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(info().commit, tagCommit);
  assert.equal(info().source_bundle, false);
  assert.equal(spawnSync("test", ["-e", join(out, "source.bundle")]).status, 1);
});

test("Android E2E checks out the tag itself when the build recorded no bundle", () => {
  const e2e = readFileSync(
    new URL("../.github/workflows/android-e2e.yml", import.meta.url),
    "utf8",
  );
  assert.match(e2e, /\.source_bundle == false/);
  assert.match(e2e, /git -C src fetch -q "\$RUNNER_TEMP\/build-source\/source\.bundle" HEAD/);
});
