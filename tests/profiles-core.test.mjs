import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ProfilesError,
	appendMissing,
	entryKey,
	mergeKeep,
	applyProfile,
	parseProfileCommand,
	readProfilesFile,
	readSettings,
	removeProfile,
	resolveProfilePaths,
	sameResourceList,
	saveProfile,
	switchProfile,
	undoProfile,
	validateProfileDefinition,
	validateProfileName,
	writeJsonFile,
} from "../src/profiles-core.js";

async function setup({ settings = { packages: ["pkg-a", "pkg-b"], extensions: ["ext-a"] }, file } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-profiles-"));
	const settingsPath = join(dir, "settings.json");
	const profilesPath = join(dir, "pi-profiles.json");
	if (settings !== null) await writeFile(settingsPath, JSON.stringify(settings, null, 2));
	if (file !== undefined) await writeFile(profilesPath, typeof file === "string" ? file : JSON.stringify(file, null, 2));
	return { dir, settingsPath, profilesPath, paths: { agentDir: dir, settingsPath, profilesPath } };
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("parseProfileCommand handles the command surface", () => {
	assert.deepEqual(parseProfileCommand(""), { kind: "list" });
	assert.deepEqual(parseProfileCommand("   "), { kind: "list" });
	assert.deepEqual(parseProfileCommand("work"), { kind: "switch", name: "work", force: false });
	assert.deepEqual(parseProfileCommand("work --force"), { kind: "switch", name: "work", force: true });
	assert.deepEqual(parseProfileCommand("list"), { kind: "list" });
	assert.deepEqual(parseProfileCommand("undo"), { kind: "undo" });
	assert.deepEqual(parseProfileCommand("help"), { kind: "help" });
	assert.deepEqual(parseProfileCommand("--help"), { kind: "help" });
	assert.deepEqual(parseProfileCommand("save work"), { kind: "save", name: "work", force: false });
	assert.deepEqual(parseProfileCommand("save work --force"), { kind: "save", name: "work", force: true });
	assert.deepEqual(parseProfileCommand("rm work"), { kind: "rm", name: "work", force: false });
});

test("parseProfileCommand rejects bad usage", () => {
	assert.throws(() => parseProfileCommand("--bogus"), ProfilesError);
	assert.throws(() => parseProfileCommand("--force"), /missing profile name/);
	assert.throws(() => parseProfileCommand("save"), ProfilesError);
	assert.throws(() => parseProfileCommand("save a b"), ProfilesError);
	assert.throws(() => parseProfileCommand("list extra"), ProfilesError);
	assert.throws(() => parseProfileCommand("rm work --force"), ProfilesError);
	assert.throws(() => parseProfileCommand("work extra"), ProfilesError);
});

test("validateProfileName rejects reserved and unsafe names", () => {
	for (const name of ["list", "save", "undo", "rm", "help"]) {
		assert.throws(() => validateProfileName(name), ProfilesError);
	}
	for (const name of ["with space", "../escape", "", "-dash", "a/b"]) {
		assert.throws(() => validateProfileName(name), ProfilesError);
	}
	assert.doesNotThrow(() => validateProfileName("work"));
	assert.doesNotThrow(() => validateProfileName("ci.fast_1"));
});

test("validateProfileDefinition rejects unknown keys and bad entries", () => {
	assert.doesNotThrow(() => validateProfileDefinition("a", { packages: ["x"], extensions: ["y"], description: "d" }));
	assert.throws(() => validateProfileDefinition("a", { settings: {} }), ProfilesError);
	assert.throws(() => validateProfileDefinition("a", { packages: "x" }), ProfilesError);
	assert.throws(() => validateProfileDefinition("a", { packages: [""] }), ProfilesError);
	assert.throws(() => validateProfileDefinition("a", { packages: [{ source: "x", bogus: 1 }] }), ProfilesError);
	assert.throws(() => validateProfileDefinition("a", { packages: [{ source: 1 }] }), ProfilesError);
	assert.throws(() => validateProfileDefinition("a", { packages: [{ source: "x", autoload: "no" }] }), ProfilesError);
	assert.throws(() => validateProfileDefinition("a", { extensions: [{ source: "x", skills: [1] }] }), ProfilesError);
	assert.doesNotThrow(() =>
		validateProfileDefinition("a", {
			packages: [{ source: "npm:x", autoload: false, extensions: ["a.ts"], skills: [], prompts: [], themes: [] }],
		}),
	);
});

test("appendMissing keeps profile order and appends missing keep entries", () => {
	assert.deepEqual(appendMissing(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
	// keep wins over a profile entry for the same package
	assert.deepEqual(appendMissing([{ source: "a", extensions: ["x"] }], ["a"]), ["a"]);
	assert.deepEqual(appendMissing([], ["./pi-config"]), ["./pi-config"]);
});

test("applyProfile touches only packages and extensions", () => {
	const settings = { theme: "dark", packages: ["old"], extensions: ["old-ext"], nested: { keep: true } };
	const next = applyProfile(settings, { packages: ["new"], extensions: ["new-ext"] }, { packages: ["./pi-config"], extensions: [] });
	assert.deepEqual(next.theme, "dark");
	assert.deepEqual(next.nested, { keep: true });
	assert.deepEqual(next.packages, ["new", "./pi-config"]);
	assert.deepEqual(next.extensions, ["new-ext"]);
	assert.deepEqual(settings.packages, ["old"], "input must not be mutated");
});

test("applyProfile treats missing keys as empty lists", () => {
	const next = applyProfile({ theme: "dark" }, {});
	assert.deepEqual(next.packages, []);
	assert.deepEqual(next.extensions, []);
	assert.equal(next.theme, "dark");
});

test("sameResourceList compares order and object shape", () => {
	assert.equal(sameResourceList(["a", "b"], ["a", "b"]), true);
	assert.equal(sameResourceList(["a", "b"], ["b", "a"]), false);
	assert.equal(sameResourceList([{ source: "a", extensions: ["x"] }], [{ extensions: ["x"], source: "a" }]), true);
});

test("readSettings tolerates a missing file and refuses broken JSON", async () => {
	const { settingsPath } = await setup({ settings: null });
	assert.deepEqual(await readSettings(settingsPath), {});
	await writeFile(settingsPath, "{not json");
	await assert.rejects(readSettings(settingsPath), /not valid JSON/);
	await writeFile(settingsPath, JSON.stringify({ packages: "nope" }));
	await assert.rejects(readSettings(settingsPath), /must be an array/);
});

test("readProfilesFile returns a default and validates structure", async () => {
	const { profilesPath } = await setup();
	assert.deepEqual(await readProfilesFile(profilesPath), {
		version: 1,
		active: null,
		profiles: {},
		keep: { packages: [], extensions: [] },
		previous: null,
	});
	await writeFile(profilesPath, "[]");
	await assert.rejects(readProfilesFile(profilesPath), /expected a JSON object/);
	await writeFile(profilesPath, JSON.stringify({ profiles: [], keep: {} }));
	await assert.rejects(readProfilesFile(profilesPath), /"profiles" must be an object/);
	await writeFile(profilesPath, JSON.stringify({ keep: { packages: "x" } }));
	await assert.rejects(readProfilesFile(profilesPath), /keep.packages must be an array/);
});

test("writeJsonFile preserves a symlinked settings file", async () => {
	const { dir, settingsPath } = await setup();
	const link = join(dir, "linked.json");
	await symlink(settingsPath, link);
	await writeJsonFile(link, { packages: ["x"] });
	assert.equal((await lstat(link)).isSymbolicLink(), true, "link must stay a link");
	assert.deepEqual(await readJson(settingsPath), { packages: ["x"] });
});

test("writeJsonFile preserves mode and the absence of a trailing newline", async () => {
	const { settingsPath } = await setup();
	await chmod(settingsPath, 0o600);
	await writeFile(settingsPath, JSON.stringify({ a: 1 }, null, 2));
	await writeJsonFile(settingsPath, { a: 2 });
	assert.equal((await readFile(settingsPath, "utf8")).endsWith("}"), true);
	assert.equal((await lstat(settingsPath)).mode & 0o777, 0o600);
	await writeJsonFile(settingsPath, { a: 3 });
	assert.equal((await readFile(settingsPath, "utf8")).endsWith("}"), true);
});

test("switchProfile writes the two keys and records active/previous", async () => {
	const { paths, settingsPath, profilesPath } = await setup({
		settings: { theme: "dark", packages: ["base"], extensions: ["-builtin:mcp"] },
		file: {
			keep: { packages: ["./pi-config"], extensions: [] },
			profiles: { work: { packages: ["pkg-w"], extensions: [] } },
		},
	});
	const outcome = await switchProfile({ paths, name: "work" });
	assert.equal(outcome.changed, true);
	assert.equal(outcome.summary, "2 packages, 0 extensions");
	const settings = await readJson(settingsPath);
	assert.deepEqual(settings.packages, ["pkg-w", "./pi-config"]);
	assert.deepEqual(settings.extensions, []);
	assert.equal(settings.theme, "dark");
	const profiles = await readJson(profilesPath);
	assert.equal(profiles.active, "work");
	assert.deepEqual(profiles.previous, { active: null, packages: ["base"], extensions: ["-builtin:mcp"] });
});

test("switchProfile is a no-op when the profile is already active", async () => {
	const { paths, settingsPath, profilesPath } = await setup({
		file: { profiles: { work: { packages: ["pkg-a", "pkg-b"], extensions: ["ext-a"] } } },
	});
	assert.equal((await switchProfile({ paths, name: "work" })).changed, true);
	const before = await readFile(settingsPath, "utf8");
	const profilesBefore = await readFile(profilesPath, "utf8");
	const second = await switchProfile({ paths, name: "work" });
	assert.equal(second.changed, false);
	assert.equal(await readFile(settingsPath, "utf8"), before);
	assert.equal(await readFile(profilesPath, "utf8"), profilesBefore);
});

test("switchProfile rejects unknown profiles with the available names", async () => {
	const { paths } = await setup({ file: { profiles: { work: { packages: ["x"] } } } });
	await assert.rejects(switchProfile({ paths, name: "nope" }), /unknown profile "nope" \(available: work\)/);
});

test("switchProfile refuses to unload everything unless forced", async () => {
	const { paths, profilesPath } = await setup({ file: { profiles: { empty: {} } } });
	await assert.rejects(switchProfile({ paths, name: "empty" }), /would leave no packages or extensions/);
	const forced = await switchProfile({ paths, name: "empty", force: true });
	assert.equal(forced.changed, true);
	assert.equal((await readJson(profilesPath)).active, "empty");
});

test("switchProfile validates definitions before writing", async () => {
	const { paths, settingsPath } = await setup({ file: { profiles: { bad: { packages: "nope" } } } });
	await assert.rejects(switchProfile({ paths, name: "bad" }), /packages must be an array/);
	assert.deepEqual((await readJson(settingsPath)).packages, ["pkg-a", "pkg-b"]);
});

test("switchProfile preserves object package entries verbatim", async () => {
	const filtered = { source: "npm:pi-background-tasks@latest", extensions: ["extensions/background-tasks.ts"] };
	const { paths, settingsPath } = await setup({ file: { profiles: { work: { packages: [filtered] } } } });
	await switchProfile({ paths, name: "work" });
	assert.deepEqual((await readJson(settingsPath)).packages, [filtered]);
});

test("saveProfile snapshots the current settings", async () => {
	const { paths, profilesPath } = await setup();
	const saved = await saveProfile({ paths, name: "snapshot" });
	assert.equal(saved.summary, "2 packages, 1 extension");
	const profiles = await readJson(profilesPath);
	assert.deepEqual(profiles.profiles.snapshot, { packages: ["pkg-a", "pkg-b"], extensions: ["ext-a"] });
	await assert.rejects(saveProfile({ paths, name: "snapshot" }), /already exists/);
	await writeJsonFile(profilesPath, profiles);
});

test("saveProfile --force overwrites and keeps the description", async () => {
	const { paths, profilesPath } = await setup({
		file: { profiles: { snapshot: { description: "keep me", packages: ["old"] } } },
	});
	await saveProfile({ paths, name: "snapshot", force: true });
	const profiles = await readJson(profilesPath);
	assert.deepEqual(profiles.profiles.snapshot, {
		description: "keep me",
		packages: ["pkg-a", "pkg-b"],
		extensions: ["ext-a"],
	});
});

test("saveProfile refuses empty settings", async () => {
	const { paths } = await setup({ settings: { theme: "dark" } });
	await assert.rejects(saveProfile({ paths, name: "empty" }), /no packages or extensions/);
});

test("undoProfile restores the previous set exactly", async () => {
	const original = { theme: "dark", packages: ["pkg-a", "pkg-b"], extensions: ["ext-a"] };
	const { paths, settingsPath, profilesPath } = await setup({
		settings: original,
		file: { profiles: { work: { packages: ["other"] } } },
	});
	await switchProfile({ paths, name: "work" });
	const outcome = await undoProfile(paths);
	assert.equal(outcome.changed, true);
	assert.deepEqual(await readJson(settingsPath), original);
	assert.deepEqual((await readJson(profilesPath)).previous, { packages: ["other"], extensions: [], active: "work" });
	// undo toggles back
	await undoProfile(paths);
	assert.deepEqual((await readJson(settingsPath)).packages, ["other"]);
	assert.equal((await readJson(profilesPath)).active, "work");
});

test("removeProfile refuses the active profile", async () => {
	const { paths, profilesPath } = await setup({
		file: { profiles: { work: { packages: ["pkg-a", "pkg-b"], extensions: ["ext-a"] } } },
	});
	await switchProfile({ paths, name: "work" });
	await assert.rejects(removeProfile({ paths, name: "work" }), /is active/);
	await removeProfile({ paths, name: "missing" }).catch(() => {});
	await assert.rejects(removeProfile({ paths, name: "missing" }), /unknown profile/);
	const profiles = await readJson(profilesPath);
	profiles.profiles.play = { packages: ["x"] };
	await writeJsonFile(profilesPath, profiles);
	await removeProfile({ paths, name: "play" });
	assert.deepEqual(Object.keys((await readJson(profilesPath)).profiles), ["work"]);
});

test("resolveProfilePaths honors PI_PROFILES_FILE and tilde paths", () => {
	const paths = resolveProfilePaths("/tmp/agent", { PI_PROFILES_FILE: "~/custom.json" });
	assert.equal(paths.profilesPath.endsWith("custom.json"), true);
	assert.equal(paths.profilesPath.startsWith("/"), true);
	const plain = resolveProfilePaths("~/.pi/agent", {});
	assert.equal(plain.settingsPath.endsWith(".pi/agent/settings.json"), true);
});

test("entryKey ignores npm versions and git refs", () => {
	assert.equal(entryKey("npm:pi-profiles@0.2.0"), "npm:pi-profiles");
	assert.equal(entryKey("npm:@scope/pkg@^1"), "npm:@scope/pkg");
	assert.equal(entryKey("npm:@scope/pkg"), "npm:@scope/pkg");
	assert.equal(entryKey("git:github.com/me/pi-profiles@v1"), "git:github.com/me/pi-profiles");
	assert.equal(entryKey("https://github.com/me/pi-profiles.git#main"), "https://github.com/me/pi-profiles");
	assert.equal(entryKey({ source: "./pi-config", extensions: [] }), "./pi-config");
});

test("mergeKeep replaces a shadowing profile entry and warns", () => {
	const { list, warnings } = mergeKeep(
		["npm:x", { source: "npm:pi-profiles@0.1.0", extensions: [] }, "npm:pi-profiles"],
		["npm:pi-profiles"],
		"packages",
	);
	assert.deepEqual(list, ["npm:x", "npm:pi-profiles"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /overridden by keep/);
	assert.deepEqual(mergeKeep(["npm:pi-profiles"], ["npm:pi-profiles"]).warnings, []);
});

test("switchProfile reports keep warnings", async () => {
	const { paths, settingsPath } = await setup({
		file: {
			keep: { packages: ["./pi-config"] },
			profiles: { work: { packages: [{ source: "./pi-config", extensions: [] }] } },
		},
	});
	const outcome = await switchProfile({ paths, name: "work" });
	assert.equal(outcome.warnings.length, 1);
	assert.deepEqual((await readJson(settingsPath)).packages, ["./pi-config"]);
});

test("readProfilesFile rejects invalid profile names and definitions", async () => {
	const { profilesPath } = await setup({ file: { profiles: { list: { packages: ["x"] } } } });
	await assert.rejects(readProfilesFile(profilesPath), /reserved/);
	await writeFile(profilesPath, JSON.stringify({ profiles: { "my profile": {} } }));
	await assert.rejects(readProfilesFile(profilesPath), /invalid profile name/);
	await writeFile(profilesPath, JSON.stringify({ profiles: { ok: { packages: "x" } } }));
	await assert.rejects(readProfilesFile(profilesPath), /must be an array/);
});

test("writeJsonFile preserves tab indentation", async () => {
	const { settingsPath } = await setup({ settings: null });
	await writeFile(settingsPath, '{\n\t"a": 1\n}\n');
	await writeJsonFile(settingsPath, { a: 2 });
	assert.equal(await readFile(settingsPath, "utf8"), '{\n\t"a": 2\n}\n');
});

test("switch waits for Pi's settings lock and leaves no lock behind", async () => {
	const { paths, settingsPath, dir } = await setup({ file: { profiles: { work: { packages: ["w"] } } } });
	const lock = settingsPath + ".lock";
	await mkdir(lock);
	const pending = switchProfile({ paths, name: "work" });
	await new Promise((r) => setTimeout(r, 100));
	assert.deepEqual((await readJson(settingsPath)).packages, ["pkg-a", "pkg-b"], "must not write while locked");
	await rmdir(lock);
	await pending;
	assert.deepEqual((await readJson(settingsPath)).packages, ["w"]);
	assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".lock")), []);
});

test("concurrent save and switch do not lose the save", async () => {
	const { paths, profilesPath } = await setup({ file: { profiles: { work: { packages: ["w"] } } } });
	await Promise.all([switchProfile({ paths, name: "work" }), saveProfile({ paths, name: "snap" })]);
	const profiles = await readJson(profilesPath);
	assert.deepEqual(Object.keys(profiles.profiles).sort(), ["snap", "work"]);
	assert.equal(profiles.active, "work");
});

test("a failed switch leaves settings untouched", async () => {
	const { paths, settingsPath, dir } = await setup({ file: { profiles: { work: { packages: ["w"] } } } });
	const before = await readFile(settingsPath, "utf8");
	await chmod(dir, 0o555);
	try {
		await assert.rejects(switchProfile({ paths, name: "work" }));
	} finally {
		await chmod(dir, 0o755);
	}
	assert.equal(await readFile(settingsPath, "utf8"), before);
});

test("appendSystemPrompt fields are validated and survive save --force", async () => {
	assert.throws(() => validateProfileDefinition("a", { appendSystemPrompt: 1 }), /must be a string/);
	assert.throws(() => validateProfileDefinition("a", { appendSystemPrompt: "x", appendSystemPromptFile: "y" }), /pick one/);
	const { paths, profilesPath } = await setup({ file: { profiles: { snap: { appendSystemPromptFile: "p.md", packages: ["old"] } } } });
	await saveProfile({ paths, name: "snap", force: true });
	const profile = (await readJson(profilesPath)).profiles.snap;
	assert.equal(profile.appendSystemPromptFile, "p.md");
	assert.deepEqual(profile.packages, ["pkg-a", "pkg-b"]);
});

test("isolated profiles: validation, no settings switch, prompt ignored", async () => {
	assert.throws(() => validateProfileDefinition("c", { agentDir: "x", packages: [] }), /does not apply/);
	assert.throws(() => validateProfileDefinition("c", { agentDir: "x", share: ["../auth.json"] }), /relative paths/);
	assert.throws(() => validateProfileDefinition("c", { agentDir: "" }), /non-empty/);
	assert.doesNotThrow(() => validateProfileDefinition("c", { agentDir: "~/x", share: ["auth.json", "skills"], description: "d" }));
	const { paths, settingsPath } = await setup({ file: { profiles: { clean: { agentDir: "c" } } } });
	const before = await readFile(settingsPath, "utf8");
	await assert.rejects(switchProfile({ paths, name: "clean" }), /exit and run: pi-profile clean/);
	assert.equal(await readFile(settingsPath, "utf8"), before);
});
