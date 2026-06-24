// Ambient types for `@chonkiejs/chunk`.
//
// The published package (v0.10.1) ships a JS entry (`index.js`) without a
// matching `index.d.ts` and does not set `"types"` in its package.json, so
// TypeScript falls back to `any`. The `.d.ts` files under `pkg/` describe the
// raw WASM bindings, NOT the friendlier wrapper API exported from `index.js`,
// so we declare the wrapper surface here by hand.
//
// If the upstream package starts shipping types, delete this file.

declare module '@chonkiejs/chunk' {
    /** Options shared by `chunk`, `chunk_offsets`, and the `Chunker` class. */
    export interface ChunkOptions {
        /** Target chunk size in bytes. Default: 4096. */
        size?: number;
        /** Delimiter characters. Default: "\n.?". */
        delimiters?: string;
        /** Multi-byte pattern to split on. Mutually exclusive with `patterns`. */
        pattern?: string | Uint8Array;
        /** Multi-byte patterns, composable with `delimiters`. */
        patterns?: string[];
        /** Put delimiter/pattern at start of next chunk. Default: false. */
        prefix?: boolean;
        /** Split at START of consecutive runs. Default: false. */
        consecutive?: boolean;
        /** Search forward if no pattern in backward window. Default: false. */
        forwardFallback?: boolean;
    }

    /** Options for `split` and `split_offsets`. */
    export interface SplitOptions {
        /** Delimiter characters. Default: "\n.?". */
        delimiters?: string;
        /** Where to attach the delimiter. Default: "prev". */
        includeDelim?: 'prev' | 'next' | 'none';
        /** Minimum characters per segment. Shorter segments are merged. Default: 0. */
        minChars?: number;
    }

    /** A `[start, end)` byte offset pair. */
    export type OffsetPair = [number, number];

    export const default_target_size: number;
    export const default_delimiters: string;

    /**
     * Split text into chunks at delimiter boundaries.
     * Returns the same type as input: string in -> string out, bytes in -> bytes out.
     */
    export function chunk(text: string, options?: ChunkOptions): Generator<string, void, unknown>;
    export function chunk(text: Uint8Array, options?: ChunkOptions): Generator<Uint8Array, void, unknown>;

    /** Get chunk offsets without creating views. */
    export function chunk_offsets(text: string | Uint8Array, options?: ChunkOptions): OffsetPair[];

    /** Split text at every delimiter occurrence. */
    export function split(text: string, options?: SplitOptions): Generator<string, void, unknown>;
    export function split(text: Uint8Array, options?: SplitOptions): Generator<Uint8Array, void, unknown>;

    /** Get split offsets without creating views. */
    export function split_offsets(text: string | Uint8Array, options?: SplitOptions): OffsetPair[];

    /** Result of `merge_splits`. */
    export interface MergeSplitsResult {
        indices: number[];
        tokenCounts: number[];
    }

    /**
     * Merge segments based on token counts, respecting chunk size limits.
     */
    export function merge_splits(
        tokenCounts: number[] | Uint32Array,
        chunkSize: number,
        combineWhitespace?: boolean,
    ): MergeSplitsResult;

    /**
     * Initialize the WASM module. Must be called before using any chunk
     * function. Automatically detects Node.js vs browser environments.
     */
    export function init(): Promise<void>;

    /** Iterator-style chunker. */
    export class Chunker implements Iterable<string | Uint8Array> {
        constructor(text: string, options?: ChunkOptions);
        constructor(text: Uint8Array, options?: ChunkOptions);

        /** Get the next chunk, or undefined if exhausted. */
        next(): string | Uint8Array | undefined;

        /** Reset the chunker to iterate from the beginning. */
        reset(): void;

        /** Collect all chunk offsets in a single WASM call. */
        collectOffsets(): OffsetPair[];

        /** Free the underlying WASM memory. */
        free(): void;

        [Symbol.iterator](): Generator<string | Uint8Array, void, unknown>;
    }
}

declare module '@chonkiejs/chunk/pkg/chonkiejs_chunk.js' {
    /** Synchronously initialize the chonkie WASM module from a WebAssembly.Module. */
    export function initSync(options: { module: WebAssembly.Module | BufferSource }): unknown;
}
