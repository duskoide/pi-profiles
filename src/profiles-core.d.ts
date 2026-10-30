export declare const PROFILES_FILE_ENV: string;
export declare const PROFILES_VERSION: number;
export declare const RESERVED_NAMES: Set<string>;
export declare const ACTIVE_SUFFIX: string;
export declare const ISOLATED_SUFFIX: string;
export declare const DEFAULT_SHARE: string[];
export declare class IsolatedProfileError extends Error { profile: string }
export declare class ProfilesError extends Error {}

export type ResourceEntry = string | Record<string, unknown>;
export type ResourceList = ResourceEntry[];
export interface ProfileDefinition {
	description?: string;
	packages?: ResourceList;
	extensions?: ResourceList;
	/** Inline text appended to Pi's system prompt while this profile is active. */
	appendSystemPrompt?: string;
	/** File whose contents are appended; relative to the profiles file's directory. */
	appendSystemPromptFile?: string;
	/** Run Pi from this agent directory instead (isolated profile). Excludes packages/extensions/appendSystemPrompt*. */
	agentDir?: string;
	/** Files/dirs symlinked from the main agent dir into agentDir. Default ["auth.json"]. */
	share?: string[];
}
export interface ResourceSnapshot { packages: ResourceList; extensions: ResourceList }
export interface PreviousSnapshot extends ResourceSnapshot { active: string | null }
export interface ProfilesFile {
	version: number;
	active: string | null;
	profiles: Record<string, ProfileDefinition>;
	keep: ResourceSnapshot;
	previous: PreviousSnapshot | null;
}
export interface SettingsLike { packages?: ResourceList; extensions?: ResourceList; [key: string]: unknown }
export interface ProfilePaths { agentDir: string; settingsPath: string; profilesPath: string }
export type ProfileCommand =
	| { kind: "list" }
	| { kind: "switch"; name: string; force: boolean }
	| { kind: "save"; name: string; force: boolean }
	| { kind: "undo" }
	| { kind: "rm"; name: string }
	| { kind: "help" };
export type NotifyLevel = "info" | "warning" | "error";
export interface ProfileIO {
	notify?: (message: string, level?: NotifyLevel) => void;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
}
export interface CommandResult { reload: boolean; isolated?: string }
export interface SwitchOutcome { changed: boolean; name: string; summary: string; settings: SettingsLike; warnings: string[] }

export declare function expandTilde(path: string): string;
export declare function resolveProfilePaths(agentDir: string, env?: Record<string, string | undefined>): ProfilePaths;
export declare function defaultProfilesFile(): ProfilesFile;
export declare function parseProfileCommand(input: string): ProfileCommand;
export declare function validateProfileName(name: string): void;
export declare function validateProfileDefinition(name: string, definition: unknown): ProfileDefinition;
export declare function entrySource(entry: ResourceEntry): string;
export declare function entryKey(entry: ResourceEntry): string;
export declare function sameResourceList(left: ResourceList, right: ResourceList): boolean;
export declare function mergeKeep(list: ResourceList, keep: ResourceList, label?: string): { list: ResourceList; warnings: string[] };
export declare function appendMissing(list: ResourceList, keep: ResourceList): ResourceList;
export declare function resolveProfile(settings: SettingsLike, definition: ProfileDefinition, keep?: ResourceSnapshot): { settings: SettingsLike; warnings: string[] };
export declare function applyProfile(settings: SettingsLike, definition: ProfileDefinition, keep?: ResourceSnapshot): SettingsLike;
export declare function currentSnapshot(settings: SettingsLike): ResourceSnapshot;
export declare function readProfilesFile(path: string): Promise<ProfilesFile>;
export declare function readSettings(path: string): Promise<SettingsLike>;
export declare function withFileQueue<T>(path: string, run: () => Promise<T>): Promise<T>;
export declare function withProfilesLock<T>(paths: ProfilePaths, run: () => Promise<T>): Promise<T>;
export declare function writeJsonFile(path: string, value: unknown): Promise<void>;
export declare function listProfileNames(profiles: ProfilesFile): string[];
export declare function switchProfile(options: { paths: ProfilePaths; name: string; force?: boolean }): Promise<SwitchOutcome>;
export declare function undoProfile(paths: ProfilePaths): Promise<SwitchOutcome>;
export declare function saveProfile(options: { paths: ProfilePaths; name: string; force?: boolean }): Promise<{ name: string; summary: string }>;
export declare function removeProfile(options: { paths: ProfilePaths; name: string }): Promise<void>;
export declare function runProfileCommand(options: { input: string; paths: ProfilePaths; io?: ProfileIO }): Promise<CommandResult>;
export declare function readAppendSystemPrompt(paths: ProfilePaths, name: string | null | undefined): Promise<string | undefined>;
export declare function resolveAppendFile(paths: ProfilePaths, file: string): string;
export declare function readActiveProfile(paths: ProfilePaths): Promise<string | null>;
export declare function isIsolated(definition: unknown): boolean;
export declare function resolveIsolatedAgentDir(paths: ProfilePaths, definition: ProfileDefinition): string;
export declare function prepareIsolatedProfile(options: { paths: ProfilePaths; name: string }): Promise<{ name: string; agentDir: string; linked: string[]; skipped: string[] }>;
