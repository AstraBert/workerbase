// Mirrors the 'store' branch's Qdrant upsert flow from src/index.ts,
// running directly under Node (not workerd) to surface the real error.
//
// Run with:
//   yarn tsx --env-file=.dev.vars scripts/test-upsert.ts
// (or however you load .dev.vars; falls back to process.env)

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { QdrantWorkerClient } from '../src/qdrant';

async function main() {
	const url = process.env.QDRANT_BASE_URL;
	const apiKey = process.env.QDRANT_API_KEY;
	const collection = process.env.QDRANT_COLLECTION_NAME;
	console.log('[env] QDRANT_BASE_URL =', url);
	console.log('[env] QDRANT_API_KEY  =', apiKey ? `${apiKey.slice(0, 8)}…(${apiKey.length} chars)` : '(missing)');
	console.log('[env] QDRANT_COLLECTION_NAME =', collection);
	if (!url || !apiKey || !collection) {
		throw new Error('Missing required QDRANT_* env vars');
	}

	// Use the same content the worker would have produced. To keep this script
	// independent of LiteParse, just read the PDF bytes and use a short stub
	// string — the upsert call is what we care about.
	const pdfBytes = await readFile('scripts/data/invoice.pdf');
	console.log(`[file] read ${pdfBytes.length} bytes from scripts/data/invoice.pdf`);
	const content = `stub-content for upsert smoke test (${pdfBytes.length} bytes pdf)`;

	const fileKey = 'invoice.pdf:' + randomUUID();
	const metadataPayload = {
		file_key: fileKey,
		type: 'invoice',
		department: 'finance',
	};

	const qdrantClient = new QdrantWorkerClient({
		url,
		apiKey,
	});

	const points: {
		id: string;
		vector: { [key: string]: { text: string; model: string } };
		payload: Record<string, unknown> | null;
	}[] = [];
	points.push({
		id: randomUUID(),
		vector: {
			sparse: {
				text: content,
				model: 'Qdrant/bm25',
			},
		},
		payload: metadataPayload,
	});
	console.log(`[chunk] built ${points.length} point(s)`);

	console.log('[qdrant] upsert →', collection);
	try {
		const res = await qdrantClient.upsert(collection, { points });
		console.log('[qdrant] upsert OK:', res);
	} catch (err) {
		console.error('[qdrant] upsert FAILED');
		console.error(err);
		// Surface as much detail as the Qdrant client exposes
		const e = err as { status?: number; statusText?: string; data?: unknown; cause?: unknown };
		if (e?.status !== undefined) console.error('  status:', e.status, e.statusText);
		if (e?.data !== undefined) console.error('  data:', JSON.stringify(e.data, null, 2));
		if (e?.cause !== undefined) console.error('  cause:', e.cause);
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
