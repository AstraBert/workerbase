// Minimal Workers-compatible Qdrant client.
//
// The official `@qdrant/js-client-rest` package's default ESM entry depends on
// `undici` (Node-only), which crashes workerd with an opaque "internal error".
// Per Qdrant's README the openapi-typescript-fetch transport is the only
// Workers-compatible path. We only need two endpoints (upsert, query), so we
// hand-roll a tiny wrapper rather than vendoring the full client.

import { Fetcher } from '@qdrant/openapi-typescript-fetch';
import type { Schemas } from '@qdrant/js-client-rest';

export type QdrantFilter = Schemas['Filter'];

export interface QdrantPoint {
	id: string | number;
	vector: Record<string, { text: string; model: string }> | number[] | Record<string, number[]>;
	payload?: Record<string, unknown> | null;
}

export interface QueryResultPoint {
	id: string | number;
	version: number;
	score: number;
	payload?: Record<string, unknown> | null;
	vector?: unknown;
}

export interface QueryArgs {
	query: { text: string; model: string } | number[] | Record<string, unknown>;
	using?: string;
	filter?: QdrantFilter;
	limit?: number;
	offset?: number;
	with_payload?: boolean;
	with_vector?: boolean;
}

// The Fetcher API is strongly typed against a generated `paths` map. We only
// hit two endpoints, so we erase the generic and treat the builder as a loose
// callable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseFetcher = any;

export class QdrantWorkerClient {
	private readonly fetcher: LooseFetcher;

	constructor(opts: { url: string; apiKey: string }) {
		const fetcher: LooseFetcher = Fetcher.for();
		fetcher.configure({
			baseUrl: opts.url.replace(/\/$/, ''),
			init: {
				headers: {
					'api-key': opts.apiKey,
					'Content-Type': 'application/json',
				},
			},
		});
		this.fetcher = fetcher;
	}

	async upsert(
		collection: string,
		body: { points: QdrantPoint[]; wait?: boolean },
	): Promise<{ status: string; operation_id?: number }> {
		const call = this.fetcher
			.path('/collections/{collection_name}/points')
			.method('put')
			.create({ wait: true });
		const res = await call({
			collection_name: collection,
			wait: body.wait ?? true,
			points: body.points,
		});
		const data = res?.data?.result;
		if (!data) throw new Error('Qdrant upsert returned no result');
		return data;
	}

	async query(collection: string, args: QueryArgs): Promise<{ points: QueryResultPoint[] }> {
		const call = this.fetcher
			.path('/collections/{collection_name}/points/query')
			.method('post')
			.create();
		let res;
		try {
			res = await call({
				collection_name: collection,
				...args,
			});
		} catch (err) {
			// openapi-typescript-fetch throws ApiError with the parsed body in `.data`.
			// Surface Qdrant's actual error so we don't lose it behind a generic 400.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const anyErr = err as any;
			const status = anyErr?.status ?? anyErr?.response?.status;
			const body = anyErr?.data ?? anyErr?.response?.data;
			console.error('Qdrant query failed', {
				status,
				body,
				sentArgs: args,
			});
			throw new Error(
				`Qdrant query failed (status ${status}): ${
					typeof body === 'string' ? body : JSON.stringify(body)
				}`,
			);
		}
		const data = res?.data?.result;
		if (!data) throw new Error('Qdrant query returned no result');
		return data;
	}
}
