import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const stub = pathToFileURL(resolvePath("tests/pi-stub.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@earendil-works/pi-coding-agent") return { url: stub, shortCircuit: true };
	return nextResolve(specifier, context);
}
