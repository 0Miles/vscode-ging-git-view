/** How far into a file git looks for a NUL byte to call it binary
 *  (`buffer_is_binary`, xdiff-interface.c). */
const BINARY_PROBE_BYTES = 8000;

/** Whether git would call `bytes` binary: a NUL in the first 8000 bytes. */
export function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0);
}
