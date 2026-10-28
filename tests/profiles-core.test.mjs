import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ProfilesError,
	appendMissing,
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
} from "../src/profiles-core.ts";

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
	assert.deepEqual(appendMissing([{ source: "a", extensions: ["x"] }], ["a"]), [{ source: "a", extensions: ["x"] }]);
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
	assert.equal((await readJson(profilesPath)).previous, null);
	await assert.rejects(undoProfile(paths), /nothing to undo/);
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
