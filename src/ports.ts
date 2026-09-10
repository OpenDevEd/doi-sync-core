import type { PublicationFile } from './publication/files.js';

/** Host-owned byte access. The core never assumes where published files are stored. */
export interface PublicationFileReader {
	readonly readFile: (file: PublicationFile) => Promise<Uint8Array>;
}
