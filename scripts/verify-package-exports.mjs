import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("@opendeved/doi-sync-core");
const display = require("@opendeved/doi-sync-core/display");

if (typeof core.planPublicationSync !== "function") {
	throw new Error("The package root cannot be loaded with require()");
}
if (typeof display.buildDoiDisplayLinks !== "function") {
	throw new Error("The display export cannot be loaded with require()");
}
