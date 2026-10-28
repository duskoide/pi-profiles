/**
 * pi-profiles — hot-swappable Pi extension profiles.
 *
 * A profile is the pair of resource lists that decide which extensions Pi loads:
 * `packages` and `extensions` from settings.json. Switching writes those two
 * keys and then reloads the extension runtime (the reload re-reads settings and
 * re-resolves packages, see pi's ResourceLoader.reload()).
 *
 * This module is dependency-free (node builtins only) so the `pi-profile` CLI
 * can use it without a Pi install.
 */

import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const PROFILES_FILE_ENV = "PI_PROFILES_FILE";
export const PROFILES_VERSION = 1;
export const RESERVED_NAMES = new Set(["list", "save", "undo", "rm", "help"]);

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENTRY_KEYS = new Set(["source", "autoload", "extensions", "skills", "prompts", "themes"]);
const RESOURCE_LIST_KEYS = new Set(["extensions", "skills", "prompts", "themes"]);
const SETTINGS_PATHS = ["packages", "extensions"];

export class ProfilesError extends Error {}

export type ResourceEntry = string | Record<string, unknown>;
export type ResourceList = ResourceEntry[];

export interface ProfileDefinition {
	description?: string;
	packages?: ResourceList;
	extensions?: ResourceList;
}

export interface ResourceSnapshot {
	packages: ResourceList;
	extensions: ResourceList;
}

export interface PreviousSnapshot extends ResourceSnapshot {
	active: string | null;
}

export interface ProfilesFile {
	version: number;
	active: string | null;
	profiles: Record<string, ProfileDefinition>;
	keep: ResourceSnapshot;
	previous: PreviousSnapshot | null;
}

export interface SettingsLike {
	packages?: ResourceList;
	extensions?: ResourceList;
	[key: string]: unknown;
}

export interface ProfilePaths {
	agentDir: string;
	settingsPath: string;
	profilesPath: string;
}

export type ProfileCommand =
	| { kind: "list" }
	| { kind: "switch"; name: string; force: boolean }
	| { kind: "save"; name: string; force: boolean }
	| { kind: "undo" }
	| { kind: "rm"; name: string }
	| { kind: "help" };

export interface ProfileIO {
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
}

export interface CommandResult {
	reload: boolean;
}

export function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function resolveProfilePaths(
	agentDir: string,
	env: Record<string, string | undefined> = process.env,
): ProfilePaths {
	const resolvedAgentDir = resolve(expandTilde(agentDir));
	const override = env[PROFILES_FILE_ENV]?.trim();
	return {
		agentDir: resolvedAgentDir,
		settingsPath: join(resolvedAgentDir, "settings.json"),
		profilesPath: override ? resolve(expandTilde(override)) : join(resolvedAgentDir, "pi-profiles.json"),
	};
}

export function defaultProfilesFile(): ProfilesFile {
	return {
		version: PROFILES_VERSION,
		active: null,
		profiles: {},
		keep: { packages: [], extensions: [] },
		previous: null,
	};
}

export function parseProfileCommand(input: string): ProfileCommand {
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
		return { kind: head, name: tail[0], force } as ProfileCommand;
	}

	if (tail.length > 0) throw new ProfilesError(`unexpected argument "${tail[0]}"`);
	return { kind: "switch", name: head, force };
}

export function validateProfileName(name: string): void {
	if (!NAME_PATTERN.test(name)) {
		throw new ProfilesError(`invalid profile name "${name}" (letters, digits, ".", "_" and "-" only)`);
	}
	if (RESERVED_NAMES.has(name)) {
		throw new ProfilesError(`"${name}" is a reserved command word and cannot be a profile name`);
	}
}

export function validateProfileDefinition(name: string, definition: unknown): ProfileDefinition {
	if (!isPlainObject(definition)) {
		throw new ProfilesError(`profile "${name}" must be an object`);
	}
	for (const key of Object.keys(definition)) {
		if (key !== "description" && key !== "packages" && key !== "extensions") {
			throw new ProfilesError(`profile "${name}" has unknown key "${key}"`);
		}
	}
	if (definition.description !== undefined && typeof definition.description !== "string") {
		throw new ProfilesError(`profile "${name}" description must be a string`);
	}
	validateResourceList(definition.packages, `profile "${name}" packages`);
	validateResourceList(definition.extensions, `profile "${name}" extensions`);
	return definition as ProfileDefinition;
}

function validateResourceList(list: unknown, label: string): void {
	if (list === undefined) return;
	if (!Array.isArray(list)) throw new ProfilesError(`${label} must be an array`);
	list.forEach((entry, index) => validateResourceEntry(entry, `${label}[${index}]`));
}

function validateResourceEntry(entry: unknown, label: string): void {
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

export function entryKey(entry: ResourceEntry): string {
	return typeof entry === "string" ? entry : String((entry as { source?: unknown }).source ?? "");
}

function entrySignature(entry: ResourceEntry): string {
	if (typeof entry === "string") return JSON.stringify(entry);
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(entry).sort()) sorted[key] = entry[key];
	return JSON.stringify(sorted);
}

export function sameResourceList(left: ResourceList, right: ResourceList): boolean {
	return left.length === right.length && left.every((entry, index) => entrySignature(entry) === entrySignature(right[index]));
}

/** Append keep entries that the profile does not already provide, preserving order. */
export function appendMissing(list: ResourceList, keep: ResourceList): ResourceList {
	const result = [...list];
	const seen = new Set(result.map(entryKey));
	for (const entry of keep) {
		const key = entryKey(entry);
		if (key.length === 0 || seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

/** Return a settings object with only packages/extensions replaced. The input is not mutated. */
export function applyProfile(
	settings: SettingsLike,
	definition: ProfileDefinition,
	keep: ResourceSnapshot = { packages: [], extensions: [] },
): SettingsLike {
	return {
		...settings,
		packages: appendMissing(definition.packages ?? [], keep.packages ?? []),
		extensions: appendMissing(definition.extensions ?? [], keep.extensions ?? []),
	};
}

export function currentSnapshot(settings: SettingsLike): ResourceSnapshot {
	return { packages: settings.packages ?? [], extensions: settings.extensions ?? [] };
}

export async function readProfilesFile(path: string): Promise<ProfilesFile> {
	const raw = await readOptional(path);
	if (raw === undefined) return defaultProfilesFile();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ProfilesError(`${path} is not valid JSON`);
	}
	return normalizeProfilesFile(parsed, path);
}

function normalizeProfilesFile(raw: unknown, path: string): ProfilesFile {
	if (!isPlainObject(raw)) throw new ProfilesError(`${path}: expected a JSON object`);
	const profiles = raw.profiles ?? {};
	if (!isPlainObject(profiles)) throw new ProfilesError(`${path}: "profiles" must be an object`);
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
		profiles: profiles as Record<string, ProfileDefinition>,
		keep: normalizeKeep(raw.keep, path),
		previous: normalizePrevious(raw.previous, path),
	};
}

function normalizeKeep(raw: unknown, path: string): ResourceSnapshot {
	if (raw === undefined) return { packages: [], extensions: [] };
	if (!isPlainObject(raw)) throw new ProfilesError(`${path}: "keep" must be an object`);
	validateResourceList(raw.packages, `${path}: keep.packages`);
	validateResourceList(raw.extensions, `${path}: keep.extensions`);
	return { packages: (raw.packages as ResourceList) ?? [], extensions: (raw.extensions as ResourceList) ?? [] };
}

function normalizePrevious(raw: unknown, path: string): PreviousSnapshot | null {
	if (raw === undefined || raw === null) return null;
	if (!isPlainObject(raw)) throw new ProfilesError(`${path}: "previous" must be an object or null`);
	validateResourceList(raw.packages, `${path}: previous.packages`);
	validateResourceList(raw.extensions, `${path}: previous.extensions`);
	const active = raw.active ?? null;
	if (active !== null && typeof active !== "string") {
		throw new ProfilesError(`${path}: previous.active must be a profile name or null`);
	}
	return {
		active,
		packages: (raw.packages as ResourceList) ?? [],
		extensions: (raw.extensions as ResourceList) ?? [],
	};
}

export async function readSettings(path: string): Promise<SettingsLike> {
	const raw = await readOptional(path);
	if (raw === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ProfilesError(`${path} is not valid JSON; refusing to overwrite it`);
	}
	if (!isPlainObject(parsed)) throw new ProfilesError(`${path}: expected a JSON object`);
	validateResourceList(parsed.packages, `${path}: packages`);
	validateResourceList(parsed.extensions, `${path}: extensions`);
	return parsed as SettingsLike;
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

const fileQueues = new Map<string, Promise<void>>();

/** Serialize read-modify-write sequences that target the same path in this process. */
export function withFileQueue<T>(path: string, run: () => Promise<T>): Promise<T> {
	const key = resolve(path);
	const previous = fileQueues.get(key) ?? Promise.resolve();
	const pending = previous.then(run, run);
	fileQueues.set(key, pending.then(() => undefined, () => undefined));
	return pending;
}

/**
 * Write JSON atomically. Follows symlinks first so a linked settings file stays a
 * link: the temp file and rename target the resolved path, not the link.
 */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await withFileQueue(path, () => writeJsonFileUnqueued(path, value));
}

async function writeJsonFileUnqueued(path: string, value: unknown): Promise<void> {
	const target = await realpath(path).catch(() => path);
	let trailing = "\n";
	let mode = 0o644;
	try {
		const [raw, info] = await Promise.all([readFile(target, "utf8"), stat(target)]);
		trailing = raw.endsWith("\n") ? "\n" : "";
		mode = info.mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const text = `${JSON.stringify(value, null, 2)}${trailing}`;
	const dir = dirname(target);
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`);
	await writeFile(tmp, text, { mode });
	await rename(tmp, target);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(snapshot: ResourceSnapshot): string {
	const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
	return `${count(snapshot.packages.length, "package")}, ${count(snapshot.extensions.length, "extension")}`;
}

export function listProfileNames(profiles: ProfilesFile): string[] {
	return Object.keys(profiles.profiles);
}

export interface SwitchOutcome {
	changed: boolean;
	name: string;
	summary: string;
	settings: SettingsLike;
}

export async function switchProfile(options: {
	paths: ProfilePaths;
	name: string;
	force?: boolean;
}): Promise<SwitchOutcome> {
	const { paths, name, force = false } = options;
	validateProfileName(name);
	const profiles = await readProfilesFile(paths.profilesPath);
	const definition = profiles.profiles[name];
	if (!definition) {
		const available = listProfileNames(profiles);
		const suffix = available.length > 0 ? `available: ${available.join(", ")}` : "no profiles defined yet";
		throw new ProfilesError(`unknown profile "${name}" (${suffix})`);
	}
	validateProfileDefinition(name, definition);

	return withFileQueue(paths.settingsPath, async () => {
		const settings = await readSettings(paths.settingsPath);
		const next = applyProfile(settings, definition, profiles.keep);
		const nextSnapshot = currentSnapshot(next);
		if (!force && nextSnapshot.packages.length === 0 && nextSnapshot.extensions.length === 0) {
			throw new ProfilesError(
				`profile "${name}" would leave no packages or extensions; add entries or pass --force`,
			);
		}
		const changed =
			profiles.active !== name ||
			!sameResourceList(settings.packages ?? [], nextSnapshot.packages) ||
			!sameResourceList(settings.extensions ?? [], nextSnapshot.extensions);

		if (changed) {
			await writeJsonFileUnqueued(paths.settingsPath, next);
			const updated: ProfilesFile = {
				...profiles,
				version: PROFILES_VERSION,
				active: name,
				previous: { ...currentSnapshot(settings), active: profiles.active },
			};
			await writeJsonFile(paths.profilesPath, updated);
		}
		return { changed, name, summary: describe(nextSnapshot), settings: next };
	});
}

export async function undoProfile(paths: ProfilePaths): Promise<SwitchOutcome> {
	const profiles = await readProfilesFile(paths.profilesPath);
	if (!profiles.previous) throw new ProfilesError("nothing to undo");
	const previous = profiles.previous;

	return withFileQueue(paths.settingsPath, async () => {
		const settings = await readSettings(paths.settingsPath);
		const next: SettingsLike = {
			...settings,
			packages: previous.packages,
			extensions: previous.extensions,
		};
		await writeJsonFileUnqueued(paths.settingsPath, next);
		const updated: ProfilesFile = { ...profiles, version: PROFILES_VERSION, active: previous.active, previous: null };
		await writeJsonFile(paths.profilesPath, updated);
		return {
			changed: true,
			name: previous.active ?? "(previous)",
			summary: describe(currentSnapshot(next)),
			settings: next,
		};
	});
}

export async function saveProfile(options: {
	paths: ProfilePaths;
	name: string;
	force?: boolean;
}): Promise<{ name: string; summary: string }> {
	const { paths, name, force = false } = options;
	validateProfileName(name);
	const settings = await readSettings(paths.settingsPath);
	const snapshot = currentSnapshot(settings);
	if (snapshot.packages.length === 0 && snapshot.extensions.length === 0) {
		throw new ProfilesError("current settings have no packages or extensions to save");
	}
	return withFileQueue(paths.profilesPath, async () => {
		const profiles = await readProfilesFile(paths.profilesPath);
		const existing = profiles.profiles[name];
		if (existing && !force) {
			throw new ProfilesError(`profile "${name}" already exists; pass --force to overwrite`);
		}
		const definition: ProfileDefinition = {
			packages: structuredClone(snapshot.packages),
			extensions: structuredClone(snapshot.extensions),
		};
		if (existing?.description) definition.description = existing.description;
		const updated: ProfilesFile = {
			...profiles,
			version: PROFILES_VERSION,
			profiles: { ...profiles.profiles, [name]: definition },
		};
		await writeJsonFileUnqueued(paths.profilesPath, updated);
		return { name, summary: describe(snapshot) };
	});
}

export async function removeProfile(options: { paths: ProfilePaths; name: string }): Promise<void> {
	const { paths, name } = options;
	const profiles = await readProfilesFile(paths.profilesPath);
	if (!profiles.profiles[name]) throw new ProfilesError(`unknown profile "${name}"`);
	if (profiles.active === name) {
		throw new ProfilesError(`profile "${name}" is active; switch to another profile before removing it`);
	}
	const nextProfiles = { ...profiles.profiles };
	delete nextProfiles[name];
	await writeJsonFile(paths.profilesPath, { ...profiles, version: PROFILES_VERSION, profiles: nextProfiles });
}

const HELP =
	"/profile <name> · /profile list · /profile save <name> [--force] · /profile undo · /profile rm <name>";

export async function runProfileCommand(options: {
	input: string;
	paths: ProfilePaths;
	io?: ProfileIO;
}): Promise<CommandResult> {
	const { paths, io = {} } = options;
	const notify = io.notify ?? (() => {});
	const command = parseProfileCommand(options.input);

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
		if (io.select) {
			const picked = await io.select("Switch profile", names);
			if (!picked) return { reload: false };
			return applySwitch(paths, picked, false, notify);
		}
		const listed = names
			.map((name) => (name === profiles.active ? `${name} (active)` : name))
			.join(", ");
		notify(`profiles: ${listed}`, "info");
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

async function applySwitch(
	paths: ProfilePaths,
	name: string,
	force: boolean,
	notify: (message: string, level?: "info" | "warning" | "error") => void,
): Promise<CommandResult> {
	const outcome = await switchProfile({ paths, name, force });
	if (!outcome.changed) {
		notify(`profile "${name}" is already active`, "info");
		return { reload: false };
	}
	notify(`profile "${outcome.name}" active (${outcome.summary}) — reloading`, "info");
	return { reload: true };
}
