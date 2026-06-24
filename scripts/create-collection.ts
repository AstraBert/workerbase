import { QdrantClient } from '@qdrant/js-client-rest';

async function main() {
	const qdrantClient = new QdrantClient({
		url: process.env.QDRANT_BASE_URL!,
		apiKey: process.env.QDRANT_API_KEY!,
	});
	const collection = process.env.QDRANT_COLLECTION_NAME!;
	await qdrantClient.createCollection(collection, {
		sparse_vectors: {
			sparse: {},
		},
	});
	await qdrantClient.createPayloadIndex(collection, {
		field_name: 'file_key',
		field_schema: 'keyword',
		wait: true,
	});
}

main().catch(console.error);
