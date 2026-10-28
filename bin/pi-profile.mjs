#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	ProfilesError,
	parseProfileCommand,
	resolveProfilePaths,
	runProfileCommand,
} from "../src/profiles-core.ts";

const USAGE = `pi-profile — switch Pi extension profiles before launch

Usage:
  pi-profile                     list profiles
  pi-profile <name> [-- pi args] switch, then start pi (pass args after --)
  pi-profile <name> --no-exec    switch only
  pi-profile list                list profiles
  pi-profile save <name> [--force]
  pi-profile undo                restore the previous extension set
  pi-profile rm <name>           remove a profile

Env:
  PI_PROFILES_FILE     profile definitions file (default ~/.pi/agent/pi-profiles.json)
  PI_CODING_AGENT_DIR  Pi config directory (default ~/.pi/agent)
  PI_BIN               Pi executable to launch (default "pi")
`;

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const own = separator === -1 ? argv : argv.slice(0, separator);
const passthrough = separator === -1 ? [] : argv.slice(separator + 1);
const noExec = own.includes("--no-exec");
const input = own.filter((token) => token !== "--no-exec").join(" ");

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

const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const paths = resolveProfilePaths(agentDir, process.env);

let result;
try {
	result = await runProfileCommand({
		input,
		paths,
		io: { notify: (message) => console.log(message) },
	});
} catch (error) {
	fail(error instanceof ProfilesError ? error.message : String(error));
}

// Launch for an explicit switch/undo even when nothing changed: the user asked
// for pi to start with this profile.
const launches = command.kind === "switch" || command.kind === "undo";
if (!launches || noExec) process.exit(0);

const piBin = process.env.PI_BIN?.trim() || "pi";
const child = spawn(piBin, passthrough, { stdio: "inherit" });
child.on("error", (error) => fail(`could not start ${piBin}: ${error.message}`));
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	process.exit(code ?? 0);
});
