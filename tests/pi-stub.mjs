import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR_NAME = ".pi";

export function getAgentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), CONFIG_DIR_NAME, "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}
