# @cle-does-things/workerbase-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects an MCP-compatible client (Claude Desktop, Cursor, etc.) to a [workerbase](https://github.com/AstraBert/workerbase) Cloudflare Worker, letting your LLM ingest, read, grep, and retrieve from a Qdrant-backed knowledge base.

The server runs locally over stdio and forwards requests to your deployed worker using an API key.

## Features

Exposes four tools to the MCP client:

| Tool       | Description                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `store`    | Upload a local file (text or PDF) to the knowledge base. Returns a `file_key` used by the other tools.  |
| `read`     | Read a stored file by `file_key`, with optional `offset` and `max_chars`.                               |
| `grep`     | Run a regex search inside a stored file, with optional match limit and surrounding context.             |
| `retrieve` | BM25 keyword search across the knowledge base, with optional `top_k`, `file_key`, and metadata filters. |

## Installation

Run it directly with `npx` (recommended for MCP client configs):

```bash
npx -y @cle-does-things/workerbase-mcp
```

Or install it globally:

```bash
npm install -g @cle-does-things/workerbase-mcp
workerbase-mcp
```

## Configuration

The server reads two environment variables:

| Variable             | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `WORKERBASE_URL`     | URL of your deployed workerbase Cloudflare Worker.    |
| `WORKERBASE_API_KEY` | Bearer token used to authenticate against the worker. |

If either variable is missing, every tool call will return an error.

## Usage with Claude

Add the server to your Claude Desktop / Claude Code:

```json
{
	"mcpServers": {
		"workerbase": {
			"command": "npx",
			"args": ["-y", "@cle-does-things/workerbase-mcp"],
			"env": {
				"WORKERBASE_URL": "https://your-worker.workers.dev",
				"WORKERBASE_API_KEY": "your-api-key"
			}
		}
	}
}
```

The same `command` / `args` / `env` shape works for Cursor, Windsurf, and any other MCP client.

## Tool reference

### `store`

Uploads a local file to the knowledge base.

| Parameter   | Type            | Required | Description                                                                                         |
| ----------- | --------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `file_path` | `string`        | yes      | Absolute path to the file on disk.                                                                  |
| `file_type` | `string`        | yes      | MIME type (e.g. `application/pdf`, `text/markdown`).                                                |
| `metadata`  | `string` (JSON) | no       | Serialized JSON object. Values may be `string`, `number`, `boolean`, or `null`. Arrays not allowed. |

Returns the `file_key` to use with the other tools.

### `read`

| Parameter   | Type     | Required | Description                                                      |
| ----------- | -------- | -------- | ---------------------------------------------------------------- |
| `file_key`  | `string` | yes      | Key returned by `store`.                                         |
| `offset`    | `number` | no       | Character offset to start reading at. Defaults to `0`.           |
| `max_chars` | `number` | no       | Max characters to read. Defaults to the full file from `offset`. |

### `grep`

| Parameter     | Type     | Required | Description                                            |
| ------------- | -------- | -------- | ------------------------------------------------------ |
| `file_key`    | `string` | yes      | Key returned by `store`.                               |
| `pattern`     | `string` | yes      | Regex pattern to match.                                |
| `context`     | `number` | no       | Number of characters of surrounding context per match. |
| `max_matches` | `number` | no       | Maximum number of matches to return. Defaults to all.  |

### `retrieve`

BM25 keyword search across the knowledge base.

| Parameter  | Type               | Required | Description                                                         |
| ---------- | ------------------ | -------- | ------------------------------------------------------------------- |
| `query`    | `string`           | yes      | Search query.                                                       |
| `top_k`    | `number`           | no       | Number of results to return. Defaults to `10`.                      |
| `file_key` | `string`           | no       | Restrict the search to a single file. Defaults to all files.        |
| `filters`  | `MetadataFilter[]` | no       | Metadata filters. Filtered fields must have a Qdrant payload index. |

Each `MetadataFilter` has the shape:

```ts
{
  operator: 'eq' | 'ne' | 'ge' | 'le' | 'gt' | 'lt' | 'true' | 'false';
  field: string;
  value?: string | number | boolean | null; // required unless operator is 'true' or 'false'
}
```

## Development

```bash
yarn install
yarn build      # compiles to dist/ and marks dist/index.js executable
yarn lint
yarn test
```

The entry point is `src/index.ts`; the built CLI is exposed as the `fuseproxy` bin.

## License

MIT © [Clelia Astra Bertelli](https://github.com/AstraBert)
