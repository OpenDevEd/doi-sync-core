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

// The DOCiD entry is the light one: a Convex app imports it into its schema, which every function loads on every
// call. It must reach no package, zod above all (about 700 KB), through any module it imports.
{
	const { readFileSync } = await import("node:fs");
	const { dirname, resolve } = await import("node:path");
	const seen = new Set();
	const walk = (file) => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const [, spec] of readFileSync(file, "utf8").matchAll(/^(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gms)) {
			if (!spec.startsWith(".")) throw new Error(`The DOCiD export reaches the package ${spec} through ${file}`);
			walk(resolve(dirname(file), spec));
		}
	};
	walk(require.resolve("@opendeved/doi-sync-core/docid"));
}
