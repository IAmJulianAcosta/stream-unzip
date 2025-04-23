/* eslint-disable */
/* tslint:disable */
import wasmUrl from 'wasm-flate/wasm_flate_bg.wasm';

export class WasmFlate {
    private wasm: any;
    private isInitialized = false;
    private WASM_VECTOR_LEN = 0;
    private cachegetUint8Memory0: Uint8Array | null = null;
    private cachegetInt32Memory0: Int32Array | null = null;
    // @ts-ignore
    private cachedTextEncoder = new TextEncoder('utf-8');
    private cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

    private getUint8Memory0(): Uint8Array {
        if (
            this.cachegetUint8Memory0 === null ||
            this.cachegetUint8Memory0.buffer !== this.wasm.memory.buffer
        ) {
            this.cachegetUint8Memory0 = new Uint8Array(this.wasm.memory.buffer);
        }
        return this.cachegetUint8Memory0;
    }

    private getInt32Memory0(): Int32Array {
        if (
            this.cachegetInt32Memory0 === null ||
            this.cachegetInt32Memory0.buffer !== this.wasm.memory.buffer
        ) {
            this.cachegetInt32Memory0 = new Int32Array(this.wasm.memory.buffer);
        }
        return this.cachegetInt32Memory0;
    }

    private encodeString(arg: string, view: Uint8Array) {
        if (typeof this.cachedTextEncoder.encodeInto === 'function') {
            return this.cachedTextEncoder.encodeInto(arg, view);
        } else {
            const buf = this.cachedTextEncoder.encode(arg);
            view.set(buf);
            return { read: arg.length, written: buf.length };
        }
    }

    private passStringToWasm0(arg: string): number {
        let len = arg.length;
        let ptr = this.wasm.__wbindgen_malloc(len);

        let offset = 0;
        const mem = this.getUint8Memory0();
        for (; offset < len; offset++) {
            const code = arg.charCodeAt(offset);
            if (code > 0x7F) break;
            mem[ptr + offset] = code;
        }
        if (offset !== len) {
            ptr = this.wasm.__wbindgen_realloc(ptr, len, (len = offset + arg.length * 3));
            const view = this.getUint8Memory0().subarray(ptr + offset, ptr + len);
            const ret = this.encodeString(arg.slice(offset), view);
            offset += ret.written;
        }
        this.WASM_VECTOR_LEN = offset;
        return ptr;
    }

    private getStringFromWasm0(ptr: number, len: number): string {
        return this.cachedTextDecoder.decode(this.getUint8Memory0().subarray(ptr, ptr + len));
    }

    private passArray8ToWasm0(arg: Uint8Array): number {
        const ptr = this.wasm.__wbindgen_malloc(arg.length);
        this.getUint8Memory0().set(arg, ptr);
        this.WASM_VECTOR_LEN = arg.length;
        return ptr;
    }

    private getArrayU8FromWasm0(ptr: number, len: number): Uint8Array {
        return this.getUint8Memory0().subarray(ptr, ptr + len);
    }

    private async init(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        let instResult: WebAssembly.WebAssemblyInstantiatedSource;

        if ('instantiateStreaming' in WebAssembly) {
            instResult = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
        } else {
            const bytes = await (await fetch(wasmUrl)).arrayBuffer();
            instResult = await WebAssembly.instantiate(bytes, {});
        }

        this.wasm = instResult.instance.exports;
        this.isInitialized = true;
    }


    private async ensureInit(): Promise<void> {
        if (!this.isInitialized) await this.init();
    }

    // ----------------------------------
    // Text-based methods
    // ----------------------------------

    private async wrapTextOp(fnName: string, input: string): Promise<string> {
        await this.ensureInit();
        const ptr = this.passStringToWasm0(input);
        const len = this.WASM_VECTOR_LEN;
        this.wasm[fnName](8, ptr, len);
        const mem = this.getInt32Memory0();
        const r0 = mem[8 / 4 + 0];
        const r1 = mem[8 / 4 + 1];
        const result = this.getStringFromWasm0(r0, r1);
        this.wasm.__wbindgen_free(r0, r1);
        return result;
    }

    async deflate_encode(text: string): Promise<string> {
        return this.wrapTextOp("deflate_encode", text);
    }

    async deflate_decode(text: string): Promise<string> {
        return this.wrapTextOp("deflate_decode", text);
    }

    async gzip_encode(text: string): Promise<string> {
        return this.wrapTextOp("gzip_encode", text);
    }

    async gzip_decode(text: string): Promise<string> {
        return this.wrapTextOp("gzip_decode", text);
    }

    async zlib_encode(text: string): Promise<string> {
        return this.wrapTextOp("zlib_encode", text);
    }

    async zlib_decode(text: string): Promise<string> {
        return this.wrapTextOp("zlib_decode", text);
    }

    // ----------------------------------
    // Raw Uint8Array-based methods
    // ----------------------------------

    private async wrapBinaryOp(fnName: string, data: Uint8Array): Promise<Uint8Array> {
        await this.ensureInit();
        const ptr = this.passArray8ToWasm0(data);
        const len = this.WASM_VECTOR_LEN;
        this.wasm[fnName](8, ptr, len);
        const mem = this.getInt32Memory0();
        const r0 = mem[8 / 4 + 0];
        const r1 = mem[8 / 4 + 1];
        const result = this.getArrayU8FromWasm0(r0, r1).slice();
        this.wasm.__wbindgen_free(r0, r1);
        return result;
    }

    async deflate_encode_raw(data: Uint8Array): Promise<Uint8Array> {
        return this.wrapBinaryOp("deflate_encode_raw", data);
    }

    async deflate_decode_raw(data: Uint8Array): Promise<Uint8Array> {
        return this.wrapBinaryOp("deflate_decode_raw", data);
    }

    async gzip_encode_raw(data: Uint8Array): Promise<Uint8Array> {
        return this.wrapBinaryOp("gzip_encode_raw", data);
    }

    async gzip_decode_raw(data: Uint8Array): Promise<Uint8Array> {
        return this.wrapBinaryOp("gzip_decode_raw", data);
    }

    async zlib_encode_raw(data: Uint8Array): Promise<Uint8Array> {
        return this.wrapBinaryOp("zlib_encode_raw", data);
    }

    async zlib_decode_raw(data: Uint8Array): Promise<Uint8Array> {
        return this.wrapBinaryOp("zlib_decode_raw", data);
    }
}

// Default singleton
export default new WasmFlate();
