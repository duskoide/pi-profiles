import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import profilesExtension from "../extensions/profiles.ts";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

async function setupAgent({ settings, profiles } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-profiles-ext-"));
	const initial = settings ?? { theme: "dark", packages: ["base"], extensions: [] };
	await writeFile(join(dir, "settings.json"), JSON.stringify(initial, null, 2));
	if (profiles) await writeFile(join(dir, "pi-profiles.json"), JSON.stringify({ version: 1, profiles }, null, 2));
	return dir;
}

function load(agentDir) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousFile = process.env.PI_PROFILES_FILE;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_PROFILES_FILE;
	const commands = new Map();
	profilesExtension({ registerCommand: (name, options) => commands.set(name, options) });
	return {
		command: commands.get("profile"),
		restore() {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousFile === undefined) delete process.env.PI_PROFILES_FILE;
			else process.env.PI_PROFILES_FILE = previousFile;
		},
	};
}

function makeCtx({ hasUI = true, selection } = {}) {
	const notifications = [];
	let reloads = 0;
	return {
		hasUI,
		ui: {
			notify: (message, level = "info") => notifications.push({ message, level }),
			select: async () => selection,
		},
		reload: async () => {
			reloads += 1;
		},
		notifications,
		reloadCount: () => reloads,
	};
}

test("registers the /profile command", async (t) => {
	const dir = await setupAgent();
	const loaded = load(dir);
	t.after(() => loaded.restore());
	assert.ok(loaded.command, "missing /profile command");
	assert.match(loaded.command.description, /profile/i);
});

test("switches profile by argument and reloads", async (t) => {
	const dir = await setupAgent({
		profiles: { work: { packages: ["pkg-w"], extensions: ["-builtin:mcp"] } },
	});
	const loaded = load(dir);
	t.after(() => loaded.restore());
	const ctx = makeCtx();
	await loaded.command.handler("work", ctx);

	assert.equal(ctx.reloadCount(), 1);
	assert.deepEqual((await readJson(join(dir, "settings.json"))).packages, ["pkg-w"]);
	assert.deepEqual((await readJson(join(dir, "settings.json"))).extensions, ["-builtin:mcp"]);
	assert.equal((await readJson(join(dir, "pi-profiles.json"))).active, "work");
	assert.deepEqual(ctx.notifications.map((n) => n.level), ["info"]);
	assert.match(ctx.notifications[0].message, /reloading/);
});

test("bare /profile picks from the list when UI is available", async (t) => {
	const dir = await setupAgent({ profiles: { play: { packages: ["pkg-p"] } } });
	const loaded = load(dir);
	t.after(() => loaded.restore());
	const ctx = makeCtx({ selection: "play" });
	await loaded.command.handler("", ctx);
	assert.equal(ctx.reloadCount(), 1);
	assert.deepEqual((await readJson(join(dir, "settings.json"))).packages, ["pkg-p"]);
});

test("bare /profile lists profiles without UI", async (t) => {
	const dir = await setupAgent({
		profiles: { play: { packages: ["pkg-p"] }, work: { packages: ["pkg-w"] } },
	});
	const loaded = load(dir);
	t.after(() => loaded.restore());
	const ctx = makeCtx({ hasUI: false });
	await loaded.command.handler("", ctx);
	assert.equal(ctx.reloadCount(), 0);
	assert.match(ctx.notifications[0].message, /profiles: play, work/);
});

test("reports an active profile without reloading", async (t) => {
	const dir = await setupAgent({
		profiles: { work: { packages: ["base"], extensions: [] } },
	});
	const loaded = load(dir);
	t.after(() => loaded.restore());
	const ctx = makeCtx();
	await loaded.command.handler("work", ctx);
	assert.equal(ctx.reloadCount(), 1);
	const again = makeCtx();
	await loaded.command.handler("work", again);
	assert.equal(again.reloadCount(), 0);
	assert.match(again.notifications[0].message, /already active/);
});

test("unknown profile is an error notification, not a reload", async (t) => {
	const dir = await setupAgent({ profiles: { work: { packages: ["base"] } } });
	const loaded = load(dir);
	t.after(() => loaded.restore());
	const ctx = makeCtx();
	await loaded.command.handler("nope", ctx);
	assert.equal(ctx.reloadCount(), 0);
	assert.equal(ctx.notifications[0].level, "error");
	assert.match(ctx.notifications[0].message, /unknown profile "nope"/);
	assert.deepEqual((await readJson(join(dir, "settings.json"))).packages, ["base"]);
});

test("invalid profile definitions fail closed", async (t) => {
	const dir = await setupAgent({ profiles: { bad: { packages: "nope" } } });
	const loaded = load(dir);
	t.after(() => loaded.restore());
	const ctx = makeCtx();
	await loaded.command.handler("bad", ctx);
	assert.equal(ctx.reloadCount(), 0);
	assert.equal(ctx.notifications[0].level, "error");
	assert.deepEqual((await readJson(join(dir, "settings.json"))).packages, ["base"]);
});

test("save snapshots the current set", async (t) => {
	const dir = await setupAgent({ settings: { packages: ["a", "b"], extensions: ["x.ts"] } });
	const loaded = load(dir);
	t.after(() => loaded.restore());
	const ctx = makeCtx();
	await loaded.command.handler("save mine", ctx);
	assert.equal(ctx.reloadCount(), 0);
	assert.deepEqual((await readJson(join(dir, "pi-profiles.json"))).profiles.mine, {
		packages: ["a", "b"],
		extensions: ["x.ts"],
	});
	assert.match(ctx.notifications[0].message, /saved profile "mine"/);
});

test("help and undo work through the command", async (t) => {
	const dir = await setupAgent({ profiles: { work: { packages: ["pkg-w"] } } });
	const loaded = load(dir);
	t.after(() => loaded.restore());
	const help = makeCtx();
	await loaded.command.handler("help", help);
	assert.match(help.notifications[0].message, /\/profile list/);

	await loaded.command.handler("work", makeCtx());
	const undo = makeCtx();
	await loaded.command.handler("undo", undo);
	assert.equal(undo.reloadCount(), 1);
	assert.deepEqual((await readJson(join(dir, "settings.json"))).packages, ["base"]);
});

test("rm refuses the active profile", async (t) => {
	const dir = await setupAgent({ profiles: { work: { packages: ["base"] } } });
	const loaded = load(dir);
	t.after(() => loaded.restore());
	await loaded.command.handler("work", makeCtx());
	const ctx = makeCtx();
	await loaded.command.handler("rm work", ctx);
	assert.equal(ctx.notifications[0].level, "error");
	assert.match(ctx.notifications[0].message, /is active/);
});
