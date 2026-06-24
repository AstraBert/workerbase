import { QdrantClient } from '@qdrant/js-client-rest';

async function main() {
	const qdrantClient = new QdrantClient({
		url: process.env.QDRANT_BASE_URL!,
		apiKey: process.env.QDRANT_API_KEY!,
	});
	const collection = process.env.QDRANT_COLLECTION_NAME!;
	for (const field of process.argv.slice(2)) {
		console.log('Creating index for', field);
		await qdrantClient.createPayloadIndex(collection, {
			field_name: field,
			field_schema: 'keyword',
			wait: true,
		});
	}
}

main().catch(console.error);
