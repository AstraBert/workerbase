#!/usr/bin/env node
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { readFile } from 'fs/promises';
import path from 'path';
import * as z from 'zod/v4';

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
				message: `Operator ${data.operator} is binary and requires the 'value' field to be defined`,
			});
		}
	});

export const server = new McpServer({
	name: 'workerbase-server',
	version: '1.0.0',
	description: 'Local MCP server to connect to a workerbase Cloudflare worker and interact with its knowledge base',
});

server.registerTool(
	'store',
	{
		description: 'Store a file in the knowledge base by passing its absolute path. Text-based files and PDFs are supported.',
		inputSchema: z.object({
			file_path: z.string().describe('Absolute file path of the file to ingest'),
			file_type: z.string().describe('MIME type of the file to ingest'),
			metadata: z
				.string()
				.optional()
				.describe(
					'Serialized JSON object representing file metadata. Only numbers, booleans, string and null values are allowed as metadata values, and only strings as metadata keys. Arrays are not allowed as values.',
				),
		}),
	},
	async ({ file_path, file_type, metadata }) => {
		const apiKey = process.env.WORKERBASE_API_KEY;
		const url = process.env.WORKERBASE_URL;
		if (!apiKey || !url) {
			return {
				content: [{ type: 'text', text: 'API key or worker URL is not set' }],
				isError: true,
			};
		}
		const fileName = path.basename(file_path);
		const job = {
			payload: {
				type: 'store',
				file_name: fileName,
				file_type,
				metadata: metadata ? JSON.parse(metadata) : undefined,
			},
		};
		const blob = new Blob([await readFile(file_path)], { type: file_type });
		const formData = new FormData();
		formData.append('job', JSON.stringify(job));
		formData.append('file', blob, fileName);
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			body: formData,
		});
		if (!response.ok) {
			return {
				content: [{ type: 'text', text: `Response returned with status ${response.status} (${await response.text()})` }],
				isError: true,
			};
		}
		const data = await response.json();
		return {
			content: [
				{
					type: 'text',
					text: `The file key for the uploaded file is ${(data as { file_key: string }).file_key}. Use it as input for the 'read', 'grep' and 'retrieve' tools.`,
				},
			],
		};
	},
);

server.registerTool(
	'read',
	{
		description: 'Read a stored file by providing its file key and, optionally, an offset and a maximum number of characters to read',
		inputSchema: z.object({
			file_key: z.string().describe('Key associated with the file to read'),
			offset: z.number().optional().describe('Offset to read the file from. Defaults to 0.'),
			max_chars: z
				.number()
				.optional()
				.describe('Maximum number of characters to read from the offset. Defaults to reading the whole file.'),
		}),
	},
	async ({ file_key, offset, max_chars }) => {
		const apiKey = process.env.WORKERBASE_API_KEY;
		const url = process.env.WORKERBASE_URL;
		if (!apiKey || !url) {
			return {
				content: [{ type: 'text', text: 'API key or worker URL is not set' }],
				isError: true,
			};
		}
		const job = {
			payload: {
				type: 'read',
				file_key,
				offset,
				max_chars,
			},
		};
		const formData = new FormData();
		formData.append('job', JSON.stringify(job));
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			body: formData,
		});
		if (!response.ok) {
			return {
				content: [{ type: 'text', text: `Response returned with status ${response.status} (${await response.text()})` }],
				isError: true,
			};
		}
		const data = await response.json();
		return {
			content: [
				{
					type: 'text',
					text: (data as { content: string }).content,
				},
			],
		};
	},
);

server.registerTool(
	'grep',
	{
		description:
			'Grep a stored file by providing its file key and a regex pattern. You can also optionally provide a maximum number of matches to return and a number of context characters to return around each match.',
		inputSchema: z.object({
			file_key: z.string().describe('Key associated with the file to grep'),
			pattern: z.string().describe('Regex pattern to grep for'),
			context: z.number().optional().describe('Number of characters to return around each grep match'),
			max_matches: z.number().optional().describe('Maximum number of matches to return. Defaults to returning all available matches.'),
		}),
	},
	async ({ file_key, pattern, context, max_matches }) => {
		const apiKey = process.env.WORKERBASE_API_KEY;
		const url = process.env.WORKERBASE_URL;
		if (!apiKey || !url) {
			return {
				content: [{ type: 'text', text: 'API key or worker URL is not set' }],
				isError: true,
			};
		}
		const job = {
			payload: {
				type: 'grep',
				file_key,
				max_matches,
				context,
				pattern,
			},
		};
		const formData = new FormData();
		formData.append('job', JSON.stringify(job));
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			body: formData,
		});
		if (!response.ok) {
			return {
				content: [{ type: 'text', text: `Response returned with status ${response.status} (${await response.text()})` }],
				isError: true,
			};
		}
		const data = await response.json();
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify(data, undefined, 2),
				},
			],
		};
	},
);

server.registerTool(
	'retrieve',
	{
		description:
			'Perform a BM25-powered keyword search across your knowledge base by providing a query and, optionally, the top K documents to retrieve and metadata filters. For metadata filters, the filtered field must be indexed with a payload index in Qdrant: ask the user about this before using metadata filters.',
		inputSchema: z.object({
			query: z.string().describe('Query to retrieve for'),
			top_k: z.number().optional().describe('Top K matches to limit the results to. Defaults to 10.'),
			file_key: z.string().optional().describe('File key to filter by during retrieval. Defaults to considering all files.'),
			filters: z
				.array(MetadataFilter)
				.optional()
				.describe(
					'Metadata filters to apply to the search. Each field included in the filters should have an associated payload index in Qdrant.',
				),
		}),
	},
	async ({ file_key, query, top_k, filters }) => {
		const apiKey = process.env.WORKERBASE_API_KEY;
		const url = process.env.WORKERBASE_URL;
		if (!apiKey || !url) {
			return {
				content: [{ type: 'text', text: 'API key or worker URL is not set' }],
				isError: true,
			};
		}
		const job = {
			payload: {
				type: 'retrieve',
				file_key,
				query,
				top_k,
				filters,
			},
		};
		const formData = new FormData();
		formData.append('job', JSON.stringify(job));
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			body: formData,
		});
		if (!response.ok) {
			return {
				content: [{ type: 'text', text: `Response returned with status ${response.status} (${await response.text()})` }],
				isError: true,
			};
		}
		const data = await response.json();
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify(data, undefined, 2),
				},
			],
		};
	},
);

async function main() {
	const transport = new StdioServerTransport();
	console.log('Starting stdio MCP server...');
	await server.connect(transport);
	process.on('SIGINT', async () => {
		await server.close();
		process.exit(0);
	});
}

main().catch(console.error);
