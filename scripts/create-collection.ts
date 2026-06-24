import { QdrantClient } from '@qdrant/js-client-rest';

async function main() {
	const qdrantClient = new QdrantClient({
		url: process.env.QDRANT_BASE_URL!,
		apiKey: process.env.QDRANT_API_KEY!,
	});
	await qdrantClient.createCollection(process.env.QDRANT_COLLECTION_NAME!, {
		sparse_vectors: {
			sparse: {},
		},
	});
}

main().catch(console.error);
