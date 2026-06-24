import { DurableObject } from 'cloudflare:workers';
// We use a hand-rolled Qdrant client built on @qdrant/openapi-typescript-fetch
// because the official @qdrant/js-client-rest pulls in `undici` (Node-only)
// from its default ESM build and crashes workerd with an opaque
// "internal error". Types are still imported from the official package.
import { QdrantWorkerClient } from './qdrant';
import type { Schemas } from '@qdrant/js-client-rest';
import { z } from 'zod';
import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import { chunk } from '@chonkiejs/chunk';
import { initSync as initChonkieSync } from '@chonkiejs/chunk/pkg/chonkiejs_chunk.js';
import wasmModule from '../liteparse_wasm_bg.wasm';
import chonkieWasmModule from '../chonkiejs_chunk_bg.wasm';
import { randomUUID } from 'crypto';

const TEXT_BASED_MIMETYPES = [
	'application/json',
	'application/xml',
	'application/javascript',
	'application/typescript',
	'application/csv',
	'application/x-ndjson',
	'application/graphql',
	'application/x-www-form-urlencoded',
	'application/yaml',
	'application/x-yaml',
	'application/toml',
	'application/sql',
	'application/ld+json',
	'application/geo+json',
	'application/x-sh',
	'application/x-bash',
];

/** A Durable Object's behavior is defined in an exported Javascript class */
export class DurableFsObject extends DurableObject<Env> {
	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async storeContent(fileKey: string, content: string): Promise<void> {
		return await this.ctx.storage.put(fileKey, content);
	}

	async getContent(fileKey: string): Promise<string | undefined> {
		return await this.ctx.storage.get(fileKey);
	}
}

interface Match {
	match: string;
	start: number;
	end: number;
	context?: {
		text: string;
		start: number;
		end: number;
	};
}

const MetadataValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const MetadataFilter = z
	.object({
		operator: z.enum(['eq', 'ne', 'ge', 'le', 'gt', 'lt', 'true', 'false']),
		field: z.string(),
		value: MetadataValue.optional(),
	})
	.superRefine((data, ctx) => {
		if (data.operator !== 'true' && data.operator !== 'false' && !data.value) {
			ctx.addIssue({
				code: 'custom',
				path: ['value'],
				message: `Operator ${data.operator} is binary, thus requires the 'value' field to be defined`,
			});
		}
	});

const StoreRequestPayload = z.object({
	type: z.literal('store'),
	file_name: z.string(),
	file_type: z.string(),
	metadata: z.record(z.string(), MetadataValue).optional(),
});

const RetrievalRequestPayload = z.object({
	type: z.literal('retrieve'),
	query: z.string(),
	top_k: z
		.number()
		.optional()
		.refine((val) => val ?? 0 >= 0, { error: 'Top K cannot be negative' }),
	file_key: z.string().optional(),
	filters: z.array(MetadataFilter).optional(),
});

const GrepRequestPayload = z.object({
	type: z.literal('grep'),
	file_key: z.string(),
	pattern: z.string(),
	max_matches: z
		.number()
		.optional()
		.refine((val) => val ?? 0 >= 0, { error: 'Max number of matches cannot be negative' }),
	context: z
		.number()
		.optional()
		.refine((val) => val ?? 0 >= 0, { error: 'Context cannot be negative' }),
});

const ReadRequestPayload = z.object({
	type: z.literal('read'),
	file_key: z.string(),
	offset: z
		.number()
		.optional()
		.refine((val) => val ?? 0 >= 0, { error: 'Offset cannot be negative' }),
	max_chars: z
		.number()
		.optional()
		.refine((val) => val ?? 0 >= 0, { error: 'Max number of characters to read cannot be negative' }),
});

const RequestJobSchema = z.object({
	payload: z.union([RetrievalRequestPayload, GrepRequestPayload, ReadRequestPayload, StoreRequestPayload]),
});

type MetadataFilterInput = z.infer<typeof MetadataFilter>;

function buildQdrantFilter(filters: MetadataFilterInput[]): Schemas['Filter'] {
	const must: Schemas['Condition'][] = [];
	const must_not: Schemas['Condition'][] = [];

	for (const f of filters) {
		switch (f.operator) {
			case 'true':
				must.push({ key: f.field, match: { value: true } });
				break;
			case 'false':
				must.push({ key: f.field, match: { value: false } });
				break;
			case 'eq':
				must.push({ key: f.field, match: { value: f.value } });
				break;
			case 'ne':
				must_not.push({ key: f.field, match: { value: f.value } });
				break;
			case 'gt':
				must.push({ key: f.field, range: { gt: f.value as number } });
				break;
			case 'ge':
				must.push({ key: f.field, range: { gte: f.value as number } });
				break;
			case 'lt':
				must.push({ key: f.field, range: { lt: f.value as number } });
				break;
			case 'le':
				must.push({ key: f.field, range: { lte: f.value as number } });
				break;
		}
	}

	return {
		...(must.length > 0 && { must }),
		...(must_not.length > 0 && { must_not }),
	};
}

let initialized = false;

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request, env, ctx): Promise<Response> {
		try {
			return await handleFetch(request, env, ctx);
		} catch (err) {
			const e = err as { step?: string; message?: string; stack?: string; name?: string; cause?: unknown };
			console.error('[fetch] uncaught error:', e?.step ?? '(no step)', e);
			return new Response(
				JSON.stringify({
					detail: 'Internal server error',
					step: e?.step ?? null,
					name: e?.name ?? null,
					message: e?.message ?? String(err),
					stack: e?.stack ?? null,
					cause: e?.cause ? String(e.cause) : null,
				}),
				{ status: 500, headers: { 'Content-Type': 'application/json' } },
			);
		}
	},
} satisfies ExportedHandler<Env>;

/** Tags an error with a `step` label so the outer handler can report which call site failed. */
async function step<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		const e = err instanceof Error ? err : new Error(String(err));
		(e as Error & { step?: string }).step = label;
		throw e;
	}
}

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	// Create a stub to open a communication channel with the Durable Object
	// instance named "foo".
	//
	// Requests from all Workers to the Durable Object instance named "foo"
	// will go to a single remote Durable Object instance.
	const authHeader = request.headers.get('Authorization');
	if (!authHeader) {
		return new Response(JSON.stringify({ detail: 'Missing Authorization header' }), {
			status: 401,
			statusText: 'Unauthorized',
			headers: { 'Content-Type': 'application/json' },
		});
	}
	if (!authHeader.startsWith('Bearer ')) {
		return new Response(JSON.stringify({ detail: 'Missing Bearer auth token in Authorization header' }), {
			status: 401,
			statusText: 'Unauthorized',
			headers: { 'Content-Type': 'application/json' },
		});
	}
	const apiKey = authHeader.slice(7);
	if (apiKey != env.INTERNAL_API_KEY) {
		return new Response(JSON.stringify({ detail: 'Invalid auth token' }), {
			status: 401,
			statusText: 'Unauthorized',
			headers: { 'Content-Type': 'application/json' },
		});
	}
	if (!initialized) {
		await step('init-liteparse-wasm', () => initSync({ module: wasmModule }));
		await step('init-chonkie-wasm', () => initChonkieSync({ module: chonkieWasmModule }));
		initialized = true;
	}

	const formData = await step('parse-formdata', () => request.formData());
	const file = formData.get('file') as File | null;
	const job = formData.get('job') as string | null;
	if (!job) {
		return new Response(JSON.stringify({ detail: "Missing 'job' field in form data" }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	const validatedJob = await step('validate-job', () => RequestJobSchema.parse(JSON.parse(job)));

	const stub = env.DURABLE_FS_OBJECT.getByName(env.DURABLE_OBJECT_SERVICE);
	const qdrantClient = new QdrantWorkerClient({
		url: env.QDRANT_BASE_URL,
		apiKey: env.QDRANT_API_KEY,
	});
	const parser = new LiteParse({
		ocrEnabled: false,
		outputFormat: 'text',
	});

	switch (validatedJob.payload.type) {
		case 'store':
			if (!file) {
				return new Response(JSON.stringify({ detail: "Missing 'file' field in form data" }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			const file_type = validatedJob.payload.file_type;
			const fileKey = validatedJob.payload.file_name + ':' + randomUUID();
			let content: string;
			if (file_type.startsWith('text/') || TEXT_BASED_MIMETYPES.includes(file_type)) {
				content = await step('read-text-file', () => file.text());
			} else if (file_type === 'application/pdf') {
				const buf = await step('read-pdf-arraybuffer', () => file.arrayBuffer());
				const result = await step('liteparse-parse-pdf', () => parser.parse(new Uint8Array(buf)));
				content = result.text as string;
			} else {
				return new Response(JSON.stringify({ detail: `Unsupported file type: ${file_type}` }), {
					status: 422,
					statusText: 'Unprocessable entity',
					headers: { 'Content-Type': 'application/json' },
				});
			}
			const metadataPayload = validatedJob.payload.metadata
				? { file_key: fileKey, ...validatedJob.payload.metadata }
				: { file_key: fileKey };
			const points: {
				id: string;
				vector: { [key: string]: { text: string; model: string } };
				payload: Record<string, unknown> | null;
			}[] = [];
			await step('chunk-content', () => {
				for (const slice of chunk(content, { size: 1024 })) {
					points.push({
						id: randomUUID(),
						vector: {
							sparse: {
								text: slice,
								model: 'qdrant/bm25',
							},
						},
						payload: { ...metadataPayload, content: slice },
					});
				}
			});
			await step('qdrant-upsert', () => qdrantClient.upsert(env.QDRANT_COLLECTION_NAME, { points, wait: true }));
			await step('do-store-content', () => stub.storeContent(fileKey, content));
			return new Response(JSON.stringify({ file_key: fileKey }), { status: 200 });
		case 'read':
			let fileContent = await stub.getContent(validatedJob.payload.file_key);
			if (!fileContent) {
				return new Response(JSON.stringify({ detail: `File with file key ${validatedJob.payload.file_key} could not be found` }), {
					status: 404,
					statusText: 'Not Found',
					headers: {
						'Content-Type': 'application/json',
					},
				});
			}
			if (validatedJob.payload.offset) {
				fileContent = fileContent.slice(validatedJob.payload.offset);
			}
			if (validatedJob.payload.max_chars) {
				fileContent = fileContent.slice(0, validatedJob.payload.max_chars);
			}
			return new Response(JSON.stringify({ content: fileContent }), { status: 200 });
		case 'grep':
			let toGrep = await stub.getContent(validatedJob.payload.file_key);
			if (!toGrep) {
				return new Response(JSON.stringify({ detail: `File with file key ${validatedJob.payload.file_key} could not be found` }), {
					status: 404,
					statusText: 'Not Found',
					headers: {
						'Content-Type': 'application/json',
					},
				});
			}
			let re: RegExp;
			try {
				re = new RegExp(validatedJob.payload.pattern, 'gd');
			} catch {
				return new Response(JSON.stringify({ detail: `Invalid regex pattern: ${validatedJob.payload.pattern}` }), {
					status: 400,
					statusText: 'Bad Request',
					headers: {
						'Content-Type': 'application/json',
					},
				});
			}
			const contextChars = validatedJob.payload.context ?? 0;
			const matches: Match[] = [];
			for (const match of toGrep.matchAll(re)) {
				if (!match.indices) {
					continue;
				}
				const [start, end] = match.indices[0];

				const result: Match = {
					match: match[0],
					start,
					end,
				};

				if (contextChars !== undefined) {
					const ctxStart = Math.max(0, start - contextChars);
					const ctxEnd = Math.min(toGrep.length, end + contextChars);
					result.context = {
						text: toGrep.slice(ctxStart, ctxEnd),
						start: ctxStart,
						end: ctxEnd,
					};
				}

				matches.push(result);
			}
			return new Response(JSON.stringify({ matches }), { status: 200 });
		case 'retrieve': {
			const retrievePayload = validatedJob.payload;
			const metadataFilts: MetadataFilterInput[] = retrievePayload.filters ? retrievePayload.filters : [];
			if (retrievePayload.file_key) {
				metadataFilts.push({
					field: 'file_key',
					operator: 'eq',
					value: retrievePayload.file_key,
				});
			}
			let filts: Schemas['Filter'] | undefined;
			if (metadataFilts.length === 0) {
				filts = undefined;
			} else {
				filts = buildQdrantFilter(metadataFilts);
				console.log(JSON.stringify(filts, undefined, 2));
			}
			const result = await step('qdrant-query', () =>
				qdrantClient.query(env.QDRANT_COLLECTION_NAME, {
					query: {
						text: retrievePayload.query,
						model: 'qdrant/bm25',
					},
					using: 'sparse',
					filter: filts,
					with_payload: true,
					with_vector: false,
				}),
			);
			const retrievedPoints: { id: string; version: number; score: number; payload: Record<string, unknown> }[] = [];
			for (const p of result.points) {
				retrievedPoints.push({
					id: p.id.toString(),
					version: p.version,
					score: p.score,
					payload: p.payload!,
				});
			}
			return new Response(JSON.stringify({ retrieved: retrievedPoints }), { status: 200 });
		}
	}
}
