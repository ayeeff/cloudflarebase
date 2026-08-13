/**
 * Just enough tar+gzip to unpack a GitHub source tarball (Phase B, direct
 * deploys). No dependency: the format is 512-byte headers and the runtime
 * already gunzips, so pulling in a tar library would be more surface than
 * code.
 *
 * Everything here is bounded. A tarball is attacker-controlled input - a
 * decompression bomb is a handful of bytes on the wire - so the reader stops
 * at a byte ceiling while still decompressing, never after.
 */

const BLOCK = 512;

export interface TarEntry {
	/** Path as recorded in the archive, including the leading directory. */
	name: string;
	/** A view into the decompressed buffer, not a copy. */
	bytes: Uint8Array;
}

export class ArchiveTooLarge extends Error {
	constructor(limit: number) {
		super(`the repository archive exceeds ${Math.round(limit / (1024 * 1024))} MB`);
	}
}

/** Decompresses a gzip stream, refusing to buffer more than `maxBytes`. */
export async function gunzip(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<Uint8Array> {
	const reader = stream.pipeThrough(new DecompressionStream('gzip')).getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			// Checked as it arrives: waiting until the end is what a bomb wants.
			if (total > maxBytes) throw new ArchiveTooLarge(maxBytes);
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}

	const buffer = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.length;
	}
	return buffer;
}

function readString(bytes: Uint8Array): string {
	let end = bytes.indexOf(0);
	if (end === -1) end = bytes.length;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

function readOctal(bytes: Uint8Array): number {
	let text = '';
	for (const byte of bytes) {
		// Fields are octal digits padded with NULs or spaces.
		if (byte === 0 || byte === 0x20) break;
		text += String.fromCharCode(byte);
	}
	const value = text ? Number.parseInt(text, 8) : 0;
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** `path=` from a PAX extended header, which is how long names travel. */
function paxPath(data: Uint8Array): string | null {
	const text = new TextDecoder().decode(data);
	const match = text.match(/\d+ path=([^\n]+)\n/);
	return match ? match[1] : null;
}

/**
 * Parses a tar buffer into its regular files.
 *
 * Directories, symlinks, and every other entry type are dropped: a static
 * deploy is a set of files, and honouring a symlink out of the archive would
 * be a path-traversal primitive.
 */
export function parseTar(buffer: Uint8Array, maxFiles: number): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;
	let pendingName: string | null = null;

	while (offset + BLOCK <= buffer.length) {
		const header = buffer.subarray(offset, offset + BLOCK);
		// Two zero blocks end the archive; one is enough to stop reading.
		if (header.every((byte) => byte === 0)) break;

		const size = readOctal(header.subarray(124, 136));
		const type = String.fromCharCode(header[156]);
		const prefix = readString(header.subarray(345, 500));
		const base = readString(header.subarray(0, 100));

		offset += BLOCK;
		const data = buffer.subarray(offset, offset + size);
		offset += Math.ceil(size / BLOCK) * BLOCK;

		// GNU long name and PAX extended headers both describe the NEXT entry.
		if (type === 'L') {
			pendingName = readString(data);
			continue;
		}
		if (type === 'x' || type === 'g') {
			pendingName = paxPath(data) ?? pendingName;
			continue;
		}

		const name = pendingName ?? (prefix ? `${prefix}/${base}` : base);
		pendingName = null;

		// '0' and NUL are both "regular file"; anything else is not ours.
		if (type !== '0' && type !== '\0') continue;
		entries.push({ name, bytes: data });
		if (entries.length > maxFiles) {
			throw new Error(`the repository holds more than ${maxFiles} files`);
		}
	}

	return entries;
}

/**
 * Turns archive entries into deployable asset paths.
 *
 * GitHub wraps every tarball in one `<owner>-<repo>-<sha>/` directory, so the
 * first segment is always stripped. `assetsDir` then selects a subtree, and
 * the result is rooted at `/` - `dist/index.html` under `assetsDir: 'dist'`
 * serves as `/index.html`.
 *
 * Dotfiles and `node_modules` are skipped, mirroring the CLI's collector:
 * `.github`, `.gitignore`, and friends are repository furniture, not content,
 * and publishing them is at best noise and at worst a leak.
 */
export function toAssetPaths(
	entries: TarEntry[],
	assetsDir: string,
): { path: string; bytes: Uint8Array }[] {
	const prefix = assetsDir.replace(/^\/+|\/+$/g, '');
	const assets: { path: string; bytes: Uint8Array }[] = [];

	for (const entry of entries) {
		const segments = entry.name.split('/');
		segments.shift(); // GitHub's wrapper directory
		if (!segments.length) continue;

		let relative = segments.join('/');
		if (prefix) {
			if (relative !== prefix && !relative.startsWith(`${prefix}/`)) continue;
			relative = relative.slice(prefix.length).replace(/^\/+/, '');
		}
		if (!relative) continue;

		const parts = relative.split('/');
		if (parts.some((part) => part.startsWith('.') || part === 'node_modules')) continue;
		// Belt and braces: a crafted name must never escape the asset root.
		if (parts.includes('..')) continue;

		assets.push({ path: `/${relative}`, bytes: entry.bytes });
	}

	return assets;
}
