#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import {
	ProfilesError,
	isIsolated,
	parseProfileCommand,
	prepareIsolatedProfile,
	readProfilesFile,
	resolveProfilePaths,
	runProfileCommand,
} from "../src/profiles-core.js";

const USAGE = `pi-profile — switch Pi extension profiles before launch

Usage:
  pi-profile                     list profiles
  pi-profile <name> [pi args]    switch, then start pi (use -- to pass args that clash)
  pi-profile <name> --no-exec    switch only (isolated: create the dir, print the command)
  pi-profile list                list profiles
  pi-profile save <name> [--force]
  pi-profile undo                restore the previous extension set
  pi-profile rm <name>           remove a profile (an isolated profile's dir is kept)
  pi-profile shell-init [shell]  print a "pi" shell function so "pi --profile <name> ..." works
                                 (zsh/bash: eval "$(pi-profile shell-init)"; fish: pi-profile shell-init fish | source)

Profiles with "agentDir" run Pi from their own agent directory (a separate,
from-scratch Pi); everything else rewrites packages/extensions in settings.json.

Env:
  PI_PROFILES_FILE     profile definitions file (default ~/.pi/agent/pi-profiles.json)
  PI_CODING_AGENT_DIR  Pi config directory (default ~/.pi/agent)
  PI_BIN               Pi executable to launch (default "pi")
`;

// Set on Pi processes started for an isolated profile, so running pi-profile
// from inside one still manages the main setup rather than the isolated dir.
const ROOT_ENV = "PI_PROFILES_ROOT_AGENT_DIR";
const ROOT_FILE_ENV = "PI_PROFILES_ROOT_FILE";

const argv = process.argv.slice(2);

if (argv[0] === "shell-init") {
	const shell = argv[1] ?? basename(process.env.SHELL ?? "bash");
	const script = shellInit(shell);
	if (!script) {
		console.error(`pi-profile: unsupported shell "${shell}" (bash, zsh, fish)`);
		process.exit(2);
	}
	process.stdout.write(script);
	process.exit(0);
}

/**
 * A "pi" shell function: "pi --profile <name> [pi args]" (or --profile=<name>)
 * goes through this launcher; anything else runs the real pi untouched. The
 * launcher spawns pi via PATH, never the shell function, so there is no loop.
 */
function shellInit(shell) {
	const self = JSON.stringify(realpathSync(process.argv[1]));
	// "command node" via PATH: a pinned execPath goes stale when Node is upgraded.
	const node = "command node";
	if (shell === "bash" || shell === "zsh" || shell === "sh") {
		return `pi() {
  case "\$1" in
    --profile) shift; if [ \$# -eq 0 ]; then ${node} ${self}; else local n="\$1"; shift; ${node} ${self} "\$n" -- "\$@"; fi ;;
    --profile=*) local n="\${1#--profile=}"; shift; ${node} ${self} "\$n" -- "\$@" ;;
    *) command pi "\$@" ;;
  esac
}
`;
	}
	if (shell === "fish") {
		return `function pi --wraps pi
  if test (count $argv) -ge 1; and test "$argv[1]" = --profile
    if test (count $argv) -eq 1
      ${node} ${self}
    else
      ${node} ${self} $argv[2] -- $argv[3..-1]
    end
  else if string match -q -- '--profile=*' "$argv[1]"
    ${node} ${self} (string replace -- '--profile=' '' $argv[1]) -- $argv[2..-1]
  else
    command pi $argv
  end
end
`;
	}
	return undefined;
}

const separator = argv.indexOf("--");
const own = separator === -1 ? argv : argv.slice(0, separator);
let passthrough = separator === -1 ? [] : argv.slice(separator + 1);
const noExec = own.includes("--no-exec");
const ownTokens = own.filter((token) => token !== "--no-exec");

// For "pi-profile <name> ...", any further token that is not ours is a pi
// argument, so "pi-profile work --model opus" works without "--".
const SUBCOMMANDS = new Set(["list", "save", "undo", "rm", "help", "--help", "-h"]);
const firstWord = ownTokens.find((token) => token !== "--force");
let input;
if (firstWord !== undefined && !SUBCOMMANDS.has(firstWord) && !firstWord.startsWith("-")) {
	const index = ownTokens.indexOf(firstWord);
	const extras = ownTokens.filter((token, i) => i !== index && token !== "--force");
	passthrough.unshift(...extras);
	input = [firstWord, ...(ownTokens.includes("--force") ? ["--force"] : [])].join(" ");
} else {
	input = ownTokens.map((token) => (token === "-h" ? "--help" : token)).join(" ");
}

function fail(message) {
	console.error(`pi-profile: ${message}`);
	process.exit(2);
}

let command;
try {
	command = parseProfileCommand(input);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

if (command.kind === "help") {
	console.log(USAGE);
	process.exit(0);
}

const agentDir =
	process.env[ROOT_ENV]?.trim() || process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const env = { ...process.env };
if (process.env[ROOT_FILE_ENV]?.trim() && !env.PI_PROFILES_FILE?.trim()) env.PI_PROFILES_FILE = process.env[ROOT_FILE_ENV];
const paths = resolveProfilePaths(agentDir, env);
const piBin = process.env.PI_BIN?.trim() || "pi";

function launch(childEnv) {
	const child = spawn(piBin, passthrough, { stdio: "inherit", env: childEnv });
	child.on("error", (error) => fail(`could not start ${piBin}: ${error.message}`));
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		process.exit(code ?? 0);
	});
}

try {
	if (command.kind === "switch") {
		const profiles = await readProfilesFile(paths.profilesPath);
		if (isIsolated(profiles.profiles[command.name])) {
			const prepared = await prepareIsolatedProfile({ paths, name: command.name });
			if (prepared.linked.length > 0) console.error(`linked from main setup: ${prepared.linked.join(", ")}`);
			for (const item of prepared.skipped) console.error(`not shared: ${item}`);
			const childEnv = { ...process.env, PI_CODING_AGENT_DIR: prepared.agentDir, PI_PROFILE: command.name };
			// Isolation: the child must not read the main profiles file or settings.
			delete childEnv.PI_PROFILES_FILE;
			childEnv[ROOT_ENV] = paths.agentDir;
			childEnv[ROOT_FILE_ENV] = paths.profilesPath;
			if (noExec) {
				console.log(`PI_CODING_AGENT_DIR=${JSON.stringify(prepared.agentDir)} ${piBin}`);
				process.exit(0);
			}
			launch(childEnv);
			// Keep the process alive for the child; the exit handler ends it.
			await new Promise(() => {});
		}
	}
} catch (error) {
	fail(error instanceof ProfilesError ? error.message : String(error));
}

try {
	await runProfileCommand({
		input,
		paths,
		io: {
			notify: (message, level) =>
				(level === "warning" ? console.error : console.log)(message.replace(/ — reloading$/, "")),
		},
	});
} catch (error) {
	fail(error instanceof ProfilesError ? error.message : String(error));
}

// Launch for an explicit switch/undo even when nothing changed: the user asked
// for pi to start with this profile.
const launches = command.kind === "switch" || command.kind === "undo";
if (!launches || noExec) process.exit(0);

// Start the main setup even when invoked from inside an isolated profile's Pi.
const childEnv = { ...process.env, PI_CODING_AGENT_DIR: paths.agentDir };
delete childEnv[ROOT_ENV];
delete childEnv[ROOT_FILE_ENV];
delete childEnv.PI_PROFILE;
launch(childEnv);
