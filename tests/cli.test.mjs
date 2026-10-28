import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
