import { register } from "node:module";

register(new URL("./pi-loader.mjs", import.meta.url).href);
