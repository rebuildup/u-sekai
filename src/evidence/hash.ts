import { createHash } from 'node:crypto';

/**
 * Stable one-way hash for prompt digests and event ordering.
 *
 * Uses a deliberately tiny FNV-1a variant. Cryptographic security is
 * not required: this is only used to identify identical input shapes
 * across steps in a single run's artifact. Do not reuse for
 * authentication.
 */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function digestRequest(systemPrompt: string, body: string): string {
  return `fnv1a:${fnv1aHex(systemPrompt)}:${fnv1aHex(body)}`;
}

/**
 * Real SHA-256 (hex) of raw bytes.
 *
 * `VisualObservation.screenshotHash` is specified as SHA-256 of the
 * screenshot bytes, so the browser adapter hashes with this function
 * and the artifact writer uses the same helper for the PNG file it
 * writes. One implementation, one contract.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
