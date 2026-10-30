import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	ProfilesError,
	readActiveProfile,
	readAppendSystemPrompt,
	resolveProfilePaths,
	runProfileCommand,
} from "../src/profiles-core.js";

/**
 * /profile — swap the active Pi extension set without restarting.
 *
 * A switch rewrites the `packages` and `extensions` arrays in
 * <agentDir>/settings.json, then reloads the extension runtime. Pi's reload
 * re-reads settings and re-resolves packages, so the new set loads and the old
 * one is discarded; the session and transcript are preserved.
 *
 * The active profile may also append text to the system prompt
 * (`appendSystemPrompt` / `appendSystemPromptFile`). The profile is pinned when
 * this extension loads, so a switch made by another session does not change
 * this session's prompt until it reloads — matching its extension set.
 */
export default function profilesExtension(pi: ExtensionAPI): void {
	const paths = resolveProfilePaths(getAgentDir(), process.env);
	// Pinned at load: reload re-runs this factory, picking up the new profile.
	const activeAtLoad = readActiveProfile(paths).catch(() => null);
	let lastPromptError: string | undefined;

	pi.on("before_agent_start", async (event, ctx) => {
		let text: string | undefined;
		try {
			text = await readAppendSystemPrompt(paths, await activeAtLoad);
			lastPromptError = undefined;
		} catch (error) {
			// Never block a turn over a prompt addendum; report each distinct error once.
			const message = error instanceof Error ? error.message : String(error);
			if (message !== lastPromptError) ctx.ui.notify(`profile: ${message}`, "warning");
			lastPromptError = message;
			return;
		}
		if (!text) return;
		const options = event.systemPromptOptions;
		options.appendSystemPrompt = options.appendSystemPrompt ? `${options.appendSystemPrompt}\n\n${text}` : text;
	});

	pi.registerCommand("profile", {
		description: "Switch extension profiles: /profile [name|list|save <name>|undo|rm <name>]",
		handler: async (argument: string | undefined, ctx: ExtensionCommandContext) => {
			let reload = false;
			try {
				const result = await runProfileCommand({
					input: argument ?? "",
					paths,
					io: {
						notify: (message, level) => ctx.ui.notify(message, level),
						select: ctx.hasUI ? (title, options) => ctx.ui.select(title, options) : undefined,
					},
				});
				reload = result.reload;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// Fail closed: never write or reload on a bad profile definition.
				ctx.ui.notify(error instanceof ProfilesError ? message : `profile: ${message}`, "error");
				return;
			}
			// Reload invalidates this ctx, so it is the last thing the handler does.
			if (reload) await ctx.reload();
		},
	});
}
