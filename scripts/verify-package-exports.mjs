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

const metadata = require("@opendeved/doi-sync-core/metadata");
if (typeof metadata.validateZenodoPublicationRecord !== "function" || typeof metadata.validateCrossrefPublicationRecord !== "function") {
    throw new Error("The shared metadata validators cannot be loaded with require()");
}

const docid = require("@opendeved/doi-sync-core/docid");
if (typeof docid.docidResourceType !== "function" || !Array.isArray(docid.FUNDER_TYPES)) {
	throw new Error("The DOCiD export cannot be loaded with require()");
}
