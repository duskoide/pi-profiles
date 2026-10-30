import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const BIN = resolve("bin/pi-profile.mjs");

async function agentDir({ settings, profiles } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-profiles-cli-"));
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify(settings ?? { theme: "dark", packages: ["base"], extensions: [] }, null, 2),
	);
	if (profiles) {
		await writeFile(join(dir, "pi-profiles.json"), JSON.stringify({ version: 1, profiles }, null, 2));
	}
	return dir;
}

async function cli(dir, args, env = {}) {
	return run(process.execPath, [BIN, ...args], {
		env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_PROFILES_FILE: "", ...env },
	});
}

const settings = async (dir) => JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));

test("lists, saves, switches, and undoes through the launcher", async () => {
	const dir = await agentDir();
	const saved = await cli(dir, ["save", "snap"]);
	assert.match(saved.stdout, /saved profile "snap"/);
	assert.match((await cli(dir, ["list"])).stdout, /profiles: snap/);

	const profiles = JSON.parse(await readFile(join(dir, "pi-profiles.json"), "utf8"));
	profiles.profiles.min = { packages: [], extensions: ["-builtin:mcp"] };
	await writeFile(join(dir, "pi-profiles.json"), JSON.stringify(profiles, null, 2));

	const switched = await cli(dir, ["min", "--no-exec"]);
	assert.match(switched.stdout, /profile "min" active/);
	assert.deepEqual((await settings(dir)).packages, []);

	await cli(dir, ["undo", "--no-exec"]);
	assert.deepEqual((await settings(dir)).packages, ["base"]);
});

test("launches pi with the selected profile and passes through args", async () => {
	const dir = await agentDir({ profiles: { work: { packages: ["pkg-w"] } } });
	const launched = await cli(dir, ["work", "--", "--model", "opus"], { PI_BIN: "echo" });
	assert.match(launched.stdout, /--model opus/);
	assert.deepEqual((await settings(dir)).packages, ["pkg-w"]);
});

test("launches pi even when the profile is already active", async () => {
	const dir = await agentDir({ profiles: { work: { packages: ["pkg-w"] } } });
	await cli(dir, ["work", "--no-exec"]);
	const launched = await cli(dir, ["work", "--", "prompt.txt"], { PI_BIN: "echo" });
	assert.match(launched.stdout, /prompt\.txt/);
});

test("does not launch pi for list/save/help", async () => {
	const dir = await agentDir({ profiles: { work: { packages: ["pkg-w"] } } });
	for (const args of [["list"], ["save", "other"], ["help"]]) {
		const result = await cli(dir, [...args, "--no-exec"], { PI_BIN: "echo" });
		assert.equal(result.stdout.includes("THREW"), false);
	}
});

test("fails with a readable message on a bad profile", async () => {
	const dir = await agentDir({ profiles: { work: { packages: ["pkg-w"] } } });
	await assert.rejects(cli(dir, ["nope", "--no-exec"]), (error) => {
		assert.equal(error.code, 2);
		assert.match(error.stderr, /unknown profile "nope" \(available: work\)/);
		return true;
	});
});

test("pi args after the profile name pass through without --", async () => {
	const dir = await agentDir({ profiles: { work: { packages: ["pkg-w"] } } });
	const launched = await cli(dir, ["work", "--model", "opus", "--", "-p", "hi"], { PI_BIN: "echo" });
	assert.match(launched.stdout, /--model opus -p hi/);
	assert.deepEqual((await settings(dir)).packages, ["pkg-w"]);
});


test("isolated profile launches pi with PI_CODING_AGENT_DIR set", async () => {
	const dir = await agentDir({ profiles: { clean: { agentDir: "profiles/clean", share: ["auth.json", "models.json"] } } });
	await writeFile(join(dir, "auth.json"), "{}");
	const before = await readFile(join(dir, "settings.json"), "utf8");
	const own = join(dir, "profiles/clean");
	const result = await cli(dir, ["clean", "--", "PI_CODING_AGENT_DIR"], { PI_BIN: "printenv" });
	assert.equal(result.stdout.trim(), own);
	assert.match(result.stderr, /linked from main setup: auth.json/);
	assert.match(result.stderr, /not shared: models.json/);
	assert.equal(await readFile(join(dir, "settings.json"), "utf8"), before, "main settings untouched");
	assert.equal(await readlink(join(own, "auth.json")), join(dir, "auth.json"));
	// second run: link already there, nothing re-linked
	const again = await cli(dir, ["clean", "--no-exec"]);
	assert.doesNotMatch(again.stderr, /linked/);
	assert.match(again.stdout, /PI_CODING_AGENT_DIR=/);
});

test("pi-profile run inside an isolated pi still manages the main setup", async () => {
	const dir = await agentDir({ profiles: { clean: { agentDir: "iso" }, work: { packages: ["pkg-w"] } } });
	const result = await cli(dir, ["work", "--", "PI_CODING_AGENT_DIR"], {
		PI_BIN: "printenv",
		PI_CODING_AGENT_DIR: join(dir, "iso"),
		PI_PROFILES_ROOT_AGENT_DIR: dir,
		PI_PROFILES_ROOT_FILE: join(dir, "pi-profiles.json"),
	});
	assert.equal(result.stdout.trim().split("\n").at(-1), dir);
	assert.deepEqual((await settings(dir)).packages, ["pkg-w"]);
});

test("isolated profile cannot point at the main agent dir", async () => {
	const dir = await agentDir({ profiles: { bad: { agentDir: "." } } });
	await assert.rejects(cli(dir, ["bad", "--no-exec"]), /main agent directory/);
});

test("shell-init: pi --profile routes through the launcher, plain pi does not", async () => {
	const dir = await agentDir({ profiles: { work: { packages: ["pkg-w"] } } });
	const fakeBin = join(dir, "bin");
	const { mkdir, chmod } = await import("node:fs/promises");
	await mkdir(fakeBin);
	await writeFile(join(fakeBin, "pi"), '#!/bin/sh\necho "REAL $*"\n');
	await chmod(join(fakeBin, "pi"), 0o755);
	const script = `eval "$(node ${JSON.stringify(BIN)} shell-init bash)"; pi --profile work --model x "a b"; pi --profile=work -p q; pi plain`;
	const { stdout } = await run("bash", ["-c", script], {
		env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: dir, PI_PROFILES_FILE: "" },
	});
	const real = stdout.split("\n").filter((line) => line.startsWith("REAL"));
	assert.deepEqual(real, ["REAL --model x a b", "REAL -p q", "REAL plain"]);
	assert.deepEqual((await settings(dir)).packages, ["pkg-w"]);
});

test("shell-init rejects unknown shells", async () => {
	await assert.rejects(run(process.execPath, [BIN, "shell-init", "tcsh"]), /unsupported shell/);
});
