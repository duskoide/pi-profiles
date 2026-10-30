/**
 * pi-profiles — hot-swappable Pi extension profiles.
 *
 * A profile is the pair of resource lists that decide which extensions Pi loads:
 * `packages` and `extensions` from settings.json. Switching writes those two
 * keys and then reloads the extension runtime.
 *
 * Plain JavaScript (node builtins only) on purpose: Node refuses to strip types
 * from files under node_modules, so the `pi-profile` CLI must not import .ts
 * when installed from npm. Types live in profiles-core.d.ts.
 */

import { lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

export const PROFILES_FILE_ENV = "PI_PROFILES_FILE";
export const PROFILES_VERSION = 1;
export const RESERVED_NAMES = new Set(["list", "save", "undo", "rm", "help", "shell-init"]);
export const ACTIVE_SUFFIX = " (active)";
export const ISOLATED_SUFFIX = " (separate pi)";

function stripLabel(label) {
	for (const suffix of [ACTIVE_SUFFIX, ISOLATED_SUFFIX]) {
		if (label.endsWith(suffix)) return label.slice(0, -suffix.length);
	}
	return label;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROFILE_KEYS = new Set(["description", "packages", "extensions", "appendSystemPrompt", "appendSystemPromptFile"]);
const ISOLATED_KEYS = new Set(["description", "agentDir", "share"]);
export const DEFAULT_SHARE = ["auth.json"];
const ENTRY_KEYS = new Set(["source", "autoload", "extensions", "skills", "prompts", "themes"]);
const RESOURCE_LIST_KEYS = new Set(["extensions", "skills", "prompts", "themes"]);

/** Lock timing compatible with proper-lockfile, which Pi uses on settings.json. */
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

export class ProfilesError extends Error {}

export function expandTilde(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function resolveProfilePaths(agentDir, env = process.env) {
	const resolvedAgentDir = resolve(expandTilde(agentDir));
	const override = env[PROFILES_FILE_ENV]?.trim();
	return {
		agentDir: resolvedAgentDir,
		settingsPath: join(resolvedAgentDir, "settings.json"),
		profilesPath: override ? resolve(expandTilde(override)) : join(resolvedAgentDir, "pi-profiles.json"),
	};
}

export function defaultProfilesFile() {
	return {
		version: PROFILES_VERSION,
		active: null,
		profiles: {},
		keep: { packages: [], extensions: [] },
		previous: null,
	};
}

export function parseProfileCommand(input) {
	const tokens = (input ?? "").trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "list" };

	const force = tokens.includes("--force");
	const rest = tokens.filter((token) => token !== "--force");
	const unknownFlag = rest.find((token) => token.startsWith("-") && token !== "--help");
	if (unknownFlag) throw new ProfilesError(`unknown option "${unknownFlag}"`);

	const [head, ...tail] = rest;
	if (head === undefined) throw new ProfilesError("missing profile name");
	if (head === "--help" || head === "help") return { kind: "help" };

	if (head === "list" || head === "undo") {
		if (tail.length > 0) throw new ProfilesError(`"/profile ${head}" takes no arguments`);
		return { kind: head };
	}

	if (head === "save" || head === "rm") {
		if (tail.length !== 1) throw new ProfilesError(`usage: /profile ${head} <name>${head === "save" ? " [--force]" : ""}`);
		if (head === "rm" && force) throw new ProfilesError(`"/profile rm" does not accept --force`);
		return { kind: head, name: tail[0], force };
	}

	if (tail.length > 0) throw new ProfilesError(`unexpected argument "${tail[0]}"`);
	return { kind: "switch", name: head, force };
}

export function validateProfileName(name) {
	if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
		throw new ProfilesError(`invalid profile name "${name}" (letters, digits, ".", "_" and "-" only)`);
	}
	if (RESERVED_NAMES.has(name)) {
		throw new ProfilesError(`"${name}" is a reserved command word and cannot be a profile name`);
	}
}

export function validateProfileDefinition(name, definition) {
	if (!isPlainObject(definition)) {
		throw new ProfilesError(`profile "${name}" must be an object`);
	}
	if (definition.agentDir !== undefined) return validateIsolatedDefinition(name, definition);
	for (const key of Object.keys(definition)) {
		if (!PROFILE_KEYS.has(key)) {
			throw new ProfilesError(`profile "${name}" has unknown key "${key}"`);
		}
	}
	if (definition.description !== undefined && typeof definition.description !== "string") {
		throw new ProfilesError(`profile "${name}" description must be a string`);
	}
	for (const key of ["appendSystemPrompt", "appendSystemPromptFile"]) {
		if (definition[key] !== undefined && typeof definition[key] !== "string") {
			throw new ProfilesError(`profile "${name}" ${key} must be a string`);
		}
	}
	if (definition.appendSystemPrompt !== undefined && definition.appendSystemPromptFile !== undefined) {
		throw new ProfilesError(`profile "${name}" sets both appendSystemPrompt and appendSystemPromptFile; pick one`);
	}
	validateResourceList(definition.packages, `profile "${name}" packages`);
	validateResourceList(definition.extensions, `profile "${name}" extensions`);
	return definition;
}

function validateIsolatedDefinition(name, definition) {
	for (const key of Object.keys(definition)) {
		if (!ISOLATED_KEYS.has(key)) {
			throw new ProfilesError(
				`profile "${name}" has its own agentDir, so "${key}" does not apply (configure that Pi directly; allowed: description, agentDir, share)`,
			);
		}
	}
	if (typeof definition.agentDir !== "string" || definition.agentDir.trim().length === 0) {
		throw new ProfilesError(`profile "${name}" agentDir must be a non-empty string`);
	}
	if (definition.description !== undefined && typeof definition.description !== "string") {
		throw new ProfilesError(`profile "${name}" description must be a string`);
	}
	if (definition.share !== undefined) {
		if (!Array.isArray(definition.share)) throw new ProfilesError(`profile "${name}" share must be an array`);
		for (const item of definition.share) {
			if (typeof item !== "string" || !isSafeRelative(item)) {
				throw new ProfilesError(`profile "${name}" share entries must be relative paths inside the agent dir (got "${item}")`);
			}
		}
	}
	return definition;
}

function isSafeRelative(path) {
	if (path.trim().length === 0 || isAbsolute(path)) return false;
	const normalized = normalize(path);
	return normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

/** True when the profile runs Pi from its own agent directory instead of editing settings.json. */
export function isIsolated(definition) {
	return isPlainObject(definition) && definition.agentDir !== undefined;
}

export function resolveIsolatedAgentDir(paths, definition) {
	return resolve(dirname(paths.profilesPath), expandTilde(definition.agentDir));
}

/**
 * Create an isolated profile's agent directory and link shared files (default:
 * auth.json) from the main agent directory. Existing files are never replaced:
 * a target that already exists and is not our link is reported as skipped.
 */
export async function prepareIsolatedProfile({ paths, name }) {
	validateProfileName(name);
	const profiles = await readProfilesFile(paths.profilesPath);
	const definition = profiles.profiles[name];
	if (!definition) throw new ProfilesError(`unknown profile "${name}"`);
	if (!isIsolated(definition)) throw new ProfilesError(`profile "${name}" has no agentDir`);
	const agentDir = resolveIsolatedAgentDir(paths, definition);
	const mainDir = await realpath(paths.agentDir).catch(() => paths.agentDir);
	const ownDir = await realpath(agentDir).catch(() => agentDir);
	if (ownDir === mainDir) {
		throw new ProfilesError(`profile "${name}" agentDir is the main agent directory; pick a separate folder`);
	}
	await mkdir(agentDir, { recursive: true });
	const linked = [];
	const skipped = [];
	for (const item of definition.share ?? DEFAULT_SHARE) {
		const source = join(paths.agentDir, item);
		const target = join(agentDir, item);
		if (!(await exists(source))) {
			skipped.push(`${item} (not in ${paths.agentDir})`);
			continue;
		}
		const current = await lstat(target).catch(() => undefined);
		if (current) {
			const pointsAtSource = current.isSymbolicLink() && resolve(dirname(target), await readlink(target)) === source;
			if (!pointsAtSource) skipped.push(`${item} (already exists in ${agentDir}; left alone)`);
			continue;
		}
		await mkdir(dirname(target), { recursive: true });
		await symlink(source, target);
		linked.push(item);
	}
	return { name, agentDir, linked, skipped };
}

async function exists(path) {
	return (await stat(path).catch(() => undefined)) !== undefined;
}

function validateResourceList(list, label) {
	if (list === undefined) return;
	if (!Array.isArray(list)) throw new ProfilesError(`${label} must be an array`);
	list.forEach((entry, index) => validateResourceEntry(entry, `${label}[${index}]`));
}

function validateResourceEntry(entry, label) {
	if (typeof entry === "string") {
		if (entry.trim().length === 0) throw new ProfilesError(`${label} must not be empty`);
		return;
	}
	if (!isPlainObject(entry)) {
		throw new ProfilesError(`${label} must be a string or an object with a "source" field`);
	}
	if (typeof entry.source !== "string" || entry.source.trim().length === 0) {
		throw new ProfilesError(`${label} needs a non-empty "source" string`);
	}
	for (const [key, value] of Object.entries(entry)) {
		if (!ENTRY_KEYS.has(key)) throw new ProfilesError(`${label} has unknown key "${key}"`);
		if (key === "source") continue;
		if (key === "autoload") {
			if (typeof value !== "boolean") throw new ProfilesError(`${label}.autoload must be a boolean`);
			continue;
		}
		if (!RESOURCE_LIST_KEYS.has(key)) throw new ProfilesError(`${label} has unknown key "${key}"`);
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
			throw new ProfilesError(`${label}.${key} must be an array of strings`);
		}
	}
}

/** The raw source string of an entry. */
export function entrySource(entry) {
	return typeof entry === "string" ? entry : String(entry?.source ?? "");
}

/**
 * Identity of an entry for keep-matching: the source with any version or git
 * ref removed, so "npm:x", "npm:x@1.2" and "npm:@s/x@^2" match their unversioned
 * forms. Local paths are compared verbatim.
 */
export function entryKey(entry) {
	const source = entrySource(entry).trim();
	if (source.startsWith("npm:")) {
		const spec = source.slice(4);
		const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
		return `npm:${at === -1 ? spec : spec.slice(0, at)}`;
	}
	if (/^(git:|git\+|https?:\/\/|ssh:\/\/|github:)/.test(source)) {
		const hash = source.indexOf("#");
		let base = hash === -1 ? source : source.slice(0, hash);
		const slash = base.lastIndexOf("/");
		const at = base.indexOf("@", slash + 1);
		if (at !== -1) base = base.slice(0, at);
		return base.replace(/\.git$/, "").replace(/\/$/, "");
	}
	return source;
}

function entrySignature(entry) {
	if (typeof entry === "string") return JSON.stringify(entry);
	const sorted = {};
	for (const key of Object.keys(entry).sort()) sorted[key] = entry[key];
	return JSON.stringify(sorted);
}

export function sameResourceList(left, right) {
	return left.length === right.length && left.every((entry, index) => entrySignature(entry) === entrySignature(right[index]));
}

/**
 * Merge keep entries into a profile list. A keep entry always wins: if the
 * profile already names the same package (any version/filter), the profile's
 * entry is replaced in place by the keep entry, and a warning is reported when
 * they differed. Otherwise the keep entry is appended.
 */
export function mergeKeep(list, keep, label = "entries") {
	const result = [...list];
	const warnings = [];
	for (const keepEntry of keep) {
		const key = entryKey(keepEntry);
		if (key.length === 0) continue;
		const index = result.findIndex((entry) => entryKey(entry) === key);
		if (index === -1) {
			result.push(keepEntry);
			continue;
		}
		if (entrySignature(result[index]) !== entrySignature(keepEntry)) {
			warnings.push(`${label}: "${entrySource(result[index])}" overridden by keep entry "${entrySource(keepEntry)}"`);
		}
		result[index] = keepEntry;
		// Drop later duplicates of the same package so it is not loaded twice.
		for (let i = result.length - 1; i > index; i--) {
			if (entryKey(result[i]) === key) result.splice(i, 1);
		}
	}
	return { list: result, warnings };
}

/** Back-compat helper: merge without reporting warnings. */
export function appendMissing(list, keep) {
	return mergeKeep(list, keep).list;
}

/** Return settings with only packages/extensions replaced, plus keep warnings. The input is not mutated. */
export function resolveProfile(settings, definition, keep = { packages: [], extensions: [] }) {
	const packages = mergeKeep(definition.packages ?? [], keep.packages ?? [], "packages");
	const extensions = mergeKeep(definition.extensions ?? [], keep.extensions ?? [], "extensions");
	return {
		settings: { ...settings, packages: packages.list, extensions: extensions.list },
		warnings: [...packages.warnings, ...extensions.warnings],
	};
}

export function applyProfile(settings, definition, keep) {
	return resolveProfile(settings, definition, keep).settings;
}

export function currentSnapshot(settings) {
	return { packages: settings.packages ?? [], extensions: settings.extensions ?? [] };
}

export async function readProfilesFile(path) {
	const raw = await readOptional(path);
	if (raw === undefined) return defaultProfilesFile();
	let parsed;
	try {
		parsed = JSON.parse(stripBom(raw));
	} catch {
		throw new ProfilesError(`${path} is not valid JSON`);
	}
	return normalizeProfilesFile(parsed, path);
}

function normalizeProfilesFile(raw, path) {
	if (!isPlainObject(raw)) throw new ProfilesError(`${path}: expected a JSON object`);
	const profiles = raw.profiles ?? {};
	if (!isPlainObject(profiles)) throw new ProfilesError(`${path}: "profiles" must be an object`);
	// Validate every profile up front so the picker never offers one that cannot be applied.
	for (const [name, definition] of Object.entries(profiles)) {
		try {
			validateProfileName(name);
			validateProfileDefinition(name, definition);
		} catch (error) {
			throw new ProfilesError(`${path}: ${error.message}`);
		}
	}
	const active = raw.active ?? null;
	if (active !== null && (typeof active !== "string" || active.trim().length === 0)) {
		throw new ProfilesError(`${path}: "active" must be a profile name or null`);
	}
	const version = raw.version ?? PROFILES_VERSION;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
		throw new ProfilesError(`${path}: "version" must be a positive integer`);
	}
	return {
		version,
		active,
		profiles,
		keep: normalizeKeep(raw.keep, path),
		previous: normalizePrevious(raw.previous, path),
	};
}

function normalizeKeep(raw, path) {
	if (raw === undefined) return { packages: [], extensions: [] };
	if (!isPlainObject(raw)) throw new ProfilesError(`${path}: "keep" must be an object`);
	validateResourceList(raw.packages, `${path}: keep.packages`);
	validateResourceList(raw.extensions, `${path}: keep.extensions`);
	return { packages: raw.packages ?? [], extensions: raw.extensions ?? [] };
}

function normalizePrevious(raw, path) {
	if (raw === undefined || raw === null) return null;
	if (!isPlainObject(raw)) throw new ProfilesError(`${path}: "previous" must be an object or null`);
	validateResourceList(raw.packages, `${path}: previous.packages`);
	validateResourceList(raw.extensions, `${path}: previous.extensions`);
	const active = raw.active ?? null;
	if (active !== null && typeof active !== "string") {
		throw new ProfilesError(`${path}: previous.active must be a profile name or null`);
	}
	return { active, packages: raw.packages ?? [], extensions: raw.extensions ?? [] };
}

export async function readSettings(path) {
	return (await readSettingsWithRaw(path)).settings;
}

async function readSettingsWithRaw(path) {
	const raw = await readOptional(path);
	if (raw === undefined) return { settings: {}, raw };
	let parsed;
	try {
		parsed = JSON.parse(stripBom(raw));
	} catch {
		throw new ProfilesError(`${path} is not valid JSON; refusing to overwrite it`);
	}
	if (!isPlainObject(parsed)) throw new ProfilesError(`${path}: expected a JSON object`);
	validateResourceList(parsed.packages, `${path}: packages`);
	validateResourceList(parsed.extensions, `${path}: extensions`);
	return { settings: parsed, raw };
}

async function readOptional(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

function stripBom(text) {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const fileQueues = new Map();

/** Serialize async work keyed by path inside this process. */
export function withFileQueue(path, run) {
	const key = resolve(path);
	const previous = fileQueues.get(key) ?? Promise.resolve();
	const pending = previous.then(run, run);
	fileQueues.set(key, pending.then(() => undefined, () => undefined));
	return pending;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Cross-process lock using the proper-lockfile convention (`<path>.lock`
 * directory, stale after 10s). Pi's SettingsManager locks settings.json the
 * same way, so a switch and a Pi settings write never interleave.
 */
async function acquireLock(path) {
	const lockPath = `${path}.lock`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	await mkdir(dirname(path), { recursive: true });
	for (;;) {
		try {
			await mkdir(lockPath);
			return async () => {
				await rm(lockPath, { recursive: true, force: true });
			};
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			const info = await stat(lockPath).catch(() => undefined);
			if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
				await rm(lockPath, { recursive: true, force: true }).catch(() => {});
				continue;
			}
			if (Date.now() > deadline) {
				throw new ProfilesError(`${path} is locked by another process (${lockPath}); try again`);
			}
			await sleep(LOCK_RETRY_MS);
		}
	}
}

/**
 * Run a read-modify-write over settings.json and the profiles file as one unit:
 * one in-process queue plus cross-process locks on both files.
 */
export function withProfilesLock(paths, run) {
	return withFileQueue("pi-profiles:global", async () => {
		const releaseSettings = await acquireLock(paths.settingsPath);
		try {
			const releaseProfiles = await acquireLock(paths.profilesPath);
			try {
				return await run();
			} finally {
				await releaseProfiles();
			}
		} finally {
			await releaseSettings();
		}
	});
}

/** Detect the indent and trailing newline of an existing JSON text. */
function detectFormat(raw) {
	if (raw === undefined) return { indent: 2, trailing: "\n" };
	const match = /^[{[]\r?\n([ \t]+)\S/.exec(stripBom(raw));
	return { indent: match ? match[1] : 2, trailing: raw.endsWith("\n") ? "\n" : "" };
}

/**
 * Write JSON atomically (temp file + rename). Follows symlinks first so a
 * linked file stays a link; preserves mode, indentation and trailing newline.
 */
export async function writeJsonFile(path, value) {
	const target = await realpath(path).catch(() => path);
	let raw;
	let mode = 0o644;
	try {
		const [text, info] = await Promise.all([readFile(target, "utf8"), stat(target)]);
		raw = text;
		mode = info.mode & 0o777;
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const { indent, trailing } = detectFormat(raw);
	await writeTextAtomic(target, `${JSON.stringify(value, null, indent)}${trailing}`, mode);
}

async function writeTextAtomic(target, text, mode) {
	const dir = dirname(target);
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`);
	try {
		await writeFile(tmp, text, { mode });
		await rename(tmp, target);
	} catch (error) {
		await unlink(tmp).catch(() => {});
		throw error;
	}
}

/**
 * Write settings, then the profiles file. If the second write fails, restore
 * the original settings text so the two files never disagree.
 */
async function commitPair(paths, originalSettingsRaw, nextSettings, nextProfiles) {
	await writeJsonFile(paths.settingsPath, nextSettings);
	try {
		await writeJsonFile(paths.profilesPath, nextProfiles);
	} catch (error) {
		try {
			if (originalSettingsRaw === undefined) await unlink(paths.settingsPath);
			else {
				const target = await realpath(paths.settingsPath).catch(() => paths.settingsPath);
				const mode = (await stat(target)).mode & 0o777;
				await writeTextAtomic(target, originalSettingsRaw, mode);
			}
		} catch {
			// Best effort; surface the original error below.
		}
		throw error;
	}
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(snapshot) {
	const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
	return `${count(snapshot.packages.length, "package")}, ${count(snapshot.extensions.length, "extension")}`;
}

export function listProfileNames(profiles) {
	return Object.keys(profiles.profiles);
}

export async function switchProfile({ paths, name, force = false }) {
	validateProfileName(name);
	return withProfilesLock(paths, async () => {
		const profiles = await readProfilesFile(paths.profilesPath);
		const definition = profiles.profiles[name];
		if (!definition) {
			const available = listProfileNames(profiles);
			const suffix = available.length > 0 ? `available: ${available.join(", ")}` : "no profiles defined yet";
			throw new ProfilesError(`unknown profile "${name}" (${suffix})`);
		}
		if (isIsolated(definition)) throw isolatedSwitchError(name);
		const { settings, raw } = await readSettingsWithRaw(paths.settingsPath);
		const { settings: next, warnings } = resolveProfile(settings, definition, profiles.keep);
		const nextSnapshot = currentSnapshot(next);
		if (!force && nextSnapshot.packages.length === 0 && nextSnapshot.extensions.length === 0) {
			throw new ProfilesError(`profile "${name}" would leave no packages or extensions; add entries or pass --force`);
		}
		const changed =
			profiles.active !== name ||
			!sameResourceList(settings.packages ?? [], nextSnapshot.packages) ||
			!sameResourceList(settings.extensions ?? [], nextSnapshot.extensions);

		if (changed) {
			await commitPair(paths, raw, next, {
				...profiles,
				version: PROFILES_VERSION,
				active: name,
				previous: { ...currentSnapshot(settings), active: profiles.active },
			});
		}
		return { changed, name, summary: describe(nextSnapshot), settings: next, warnings };
	});
}

export class IsolatedProfileError extends ProfilesError {
	constructor(name) {
		super(`profile "${name}" uses its own agent directory and needs a fresh Pi; exit and run: pi-profile ${name}`);
		this.profile = name;
	}
}

function isolatedSwitchError(name) {
	return new IsolatedProfileError(name);
}

/** Restore the previous set. The replaced set becomes the new `previous`, so undo toggles. */
export async function undoProfile(paths) {
	return withProfilesLock(paths, async () => {
		const profiles = await readProfilesFile(paths.profilesPath);
		if (!profiles.previous) throw new ProfilesError("nothing to undo");
		const previous = profiles.previous;
		const { settings, raw } = await readSettingsWithRaw(paths.settingsPath);
		const next = { ...settings, packages: previous.packages, extensions: previous.extensions };
		await commitPair(paths, raw, next, {
			...profiles,
			version: PROFILES_VERSION,
			active: previous.active,
			previous: { ...currentSnapshot(settings), active: profiles.active },
		});
		return {
			changed: true,
			name: previous.active ?? "(previous)",
			summary: describe(currentSnapshot(next)),
			settings: next,
			warnings: [],
		};
	});
}

export async function saveProfile({ paths, name, force = false }) {
	validateProfileName(name);
	return withProfilesLock(paths, async () => {
		const settings = await readSettings(paths.settingsPath);
		const snapshot = currentSnapshot(settings);
		if (snapshot.packages.length === 0 && snapshot.extensions.length === 0) {
			throw new ProfilesError("current settings have no packages or extensions to save");
		}
		const profiles = await readProfilesFile(paths.profilesPath);
		const existing = profiles.profiles[name];
		if (existing && !force) {
			throw new ProfilesError(`profile "${name}" already exists; pass --force to overwrite`);
		}
		const definition = {
			packages: structuredClone(snapshot.packages),
			extensions: structuredClone(snapshot.extensions),
		};
		const keys = isIsolated(existing) ? ["description"] : ["description", "appendSystemPrompt", "appendSystemPromptFile"];
		for (const key of keys) {
			if (existing?.[key] !== undefined) definition[key] = existing[key];
		}
		await writeJsonFile(paths.profilesPath, {
			...profiles,
			version: PROFILES_VERSION,
			profiles: { ...profiles.profiles, [name]: definition },
		});
		return { name, summary: describe(snapshot) };
	});
}

export async function removeProfile({ paths, name }) {
	return withProfilesLock(paths, async () => {
		const profiles = await readProfilesFile(paths.profilesPath);
		if (!profiles.profiles[name]) throw new ProfilesError(`unknown profile "${name}"`);
		if (profiles.active === name) {
			throw new ProfilesError(`profile "${name}" is active; switch to another profile before removing it`);
		}
		const nextProfiles = { ...profiles.profiles };
		delete nextProfiles[name];
		await writeJsonFile(paths.profilesPath, { ...profiles, version: PROFILES_VERSION, profiles: nextProfiles });
	});
}

const HELP =
	"/profile <name> · /profile list · /profile save <name> [--force] · /profile undo · /profile rm <name>";

export async function runProfileCommand({ input, paths, io = {} }) {
	const notify = io.notify ?? (() => {});
	const command = parseProfileCommand(input);

	if (command.kind === "help") {
		notify(HELP, "info");
		return { reload: false };
	}

	if (command.kind === "list") {
		const profiles = await readProfilesFile(paths.profilesPath);
		const names = listProfileNames(profiles);
		if (names.length === 0) {
			notify(
				`no profiles yet; create one with /profile save <name> or pi-profile save <name> (file: ${paths.profilesPath})`,
				"info",
			);
			return { reload: false };
		}
		const labels = names.map((name) => {
			if (isIsolated(profiles.profiles[name])) return `${name}${ISOLATED_SUFFIX}`;
			return name === profiles.active ? `${name}${ACTIVE_SUFFIX}` : name;
		});
		if (io.select) {
			const picked = await io.select("Switch profile", labels);
			if (!picked) return { reload: false };
			const name = stripLabel(picked);
			return applySwitch(paths, name, false, notify);
		}
		notify(`profiles: ${labels.join(", ")}`, "info");
		return { reload: false };
	}

	if (command.kind === "switch") {
		return applySwitch(paths, command.name, command.force, notify);
	}

	if (command.kind === "undo") {
		const outcome = await undoProfile(paths);
		notify(`restored previous extension set (${outcome.summary}) — reloading`, "info");
		return { reload: true };
	}

	if (command.kind === "save") {
		const saved = await saveProfile({ paths, name: command.name, force: command.force });
		notify(`saved profile "${saved.name}" (${saved.summary})`, "info");
		return { reload: false };
	}

	await removeProfile({ paths, name: command.name });
	notify(`removed profile "${command.name}"`, "info");
	return { reload: false };
}

async function applySwitch(paths, name, force, notify) {
	let outcome;
	try {
		outcome = await switchProfile({ paths, name, force });
	} catch (error) {
		if (!(error instanceof IsolatedProfileError)) throw error;
		notify(error.message, "warning");
		return { reload: false, isolated: name };
	}
	for (const warning of outcome.warnings) notify(`keep: ${warning}`, "warning");
	if (!outcome.changed) {
		notify(`profile "${name}" is already active`, "info");
		return { reload: false };
	}
	notify(`profile "${outcome.name}" active (${outcome.summary}) — reloading`, "info");
	return { reload: true };
}

/**
 * Text a profile appends to Pi's system prompt, or undefined. `appendSystemPrompt`
 * is inline text; `appendSystemPromptFile` is a path (tilde ok) resolved
 * against the profiles file's directory and read on every call, so edits apply
 * on the next turn. A missing file is an error, not a silent no-op.
 */
export async function readAppendSystemPrompt(paths, name) {
	if (!name) return undefined;
	const profiles = await readProfilesFile(paths.profilesPath);
	const definition = profiles.profiles[name];
	if (!definition || isIsolated(definition)) return undefined;
	if (definition.appendSystemPrompt !== undefined) return nonEmpty(definition.appendSystemPrompt);
	if (definition.appendSystemPromptFile === undefined) return undefined;
	const file = resolveAppendFile(paths, definition.appendSystemPromptFile);
	const text = await readOptional(file);
	if (text === undefined) {
		throw new ProfilesError(`profile "${name}" appendSystemPromptFile not found: ${file}`);
	}
	return nonEmpty(stripBom(text));
}

export function resolveAppendFile(paths, file) {
	return resolve(dirname(paths.profilesPath), expandTilde(file));
}

function nonEmpty(text) {
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Name of the active profile, or null. Never throws on a missing file. */
export async function readActiveProfile(paths) {
	return (await readProfilesFile(paths.profilesPath)).active;
}
