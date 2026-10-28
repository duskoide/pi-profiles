import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ProfilesError, resolveProfilePaths, runProfileCommand } from "../src/profiles-core.ts";

/**
 * /profile — swap the active Pi extension set without restarting.
 *
 * A switch rewrites the `packages` and `extensions` arrays in
 * <agentDir>/settings.json, then reloads the extension runtime. Pi's reload
 * re-reads settings and re-resolves packages, so the new set loads and the old
 * one is discarded; the session and transcript are preserved.
 *
 * Profile definitions live in <agentDir>/pi-profiles.json (override with
 * PI_PROFILES_FILE). `keep` entries are re-appended to every switch so this
 * extension (and any base package) survives profiles that omit it.
 */
export default function profilesExtension(pi: ExtensionAPI): void {
	pi.registerCommand("profile", {
		description: "Switch extension profiles: /profile [name|list|save <name>|undo|rm <name>]",
		handler: async (argument: string | undefined, ctx: ExtensionCommandContext) => {
			const paths = resolveProfilePaths(getAgentDir(), process.env);
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
