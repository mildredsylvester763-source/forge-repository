// AI-012 tokenizer-engine - deterministic byte-pair encoding training, encode, decode.
//
// Catalog law (ALG-16): the tokenizer is trained deterministically from a corpus. The initial
// vocabulary is the corpus alphabet, sorted. Training merges the most frequent adjacent pair;
// ties break by pair, left token first then right, lexicographically. Merges are recorded as
// the tokens they produce, in order. vocabSize must sit between the alphabet size and 1024.
// The content hash is derived from the corpus, never supplied, so the same corpus plus
// vocabSize always yields the same tokenizer. Encoding applies merges in training order;
// encode then decode round-trips the corpus exactly.
//
// Refusals:
//   tokenizer-no-input / tokenizer-no-corpus / tokenizer-bad-vocab-size
//   tokenizer-vocab-below-alphabet:<vocabSize>:<alphabetSize>
//   tokenizer-vocab-above-max:<vocabSize>:1024
//   tokenizer-no-text / tokenizer-unknown-char:<char>
//   tokenizer-no-indices / tokenizer-unknown-token:<index>
//   tokenizer-no-registry / tokenizer-unknown-tokenizer:<id>

export const TOKENIZER_VOCAB_MAX = 1024;

export interface TrainedTokenizer {
  vocab: string[];
  merges: string[];
  contentHash: string;
  fingerprint: string;
}

export interface TrainTokenizerInput {
  corpus: string;
  vocabSize: number;
}

export interface TokenizerRecord extends TrainedTokenizer {
  tokId: string;
  createdAt: number;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function fp(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33 + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(-8);
}

function pairKey(left: string, right: string): string {
  return left + ':' + right;
}

// Apply one merge (a produced token) to a token sequence, left to right, replacing every
// non-overlapping adjacent pair whose concatenation equals the merge.
function applyMerge(tokens: string[], merge: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const left = tokens[i];
    const right = tokens[i + 1];
    if (left !== undefined && right !== undefined && left + right === merge) {
      out.push(merge);
      i += 2;
    } else {
      if (left !== undefined) out.push(left);
      i += 1;
    }
  }
  return out;
}

// Train a tokenizer from a corpus. Deterministic: same corpus, same vocabSize, same result.
export function trainTokenizer(input: TrainTokenizerInput): Verdict<TrainedTokenizer> {
  if (!input) return fail('tokenizer-no-input');
  if (!isNonEmptyString(input.corpus)) return fail('tokenizer-no-corpus');
  const vocabSize = input.vocabSize;
  if (typeof vocabSize !== 'number' || !isFinite(vocabSize) || Math.floor(vocabSize) !== vocabSize) {
    return fail('tokenizer-bad-vocab-size');
  }
  const alphabet = Array.from(new Set(Array.from(input.corpus))).sort();
  if (vocabSize < alphabet.length) return fail('tokenizer-vocab-below-alphabet:' + vocabSize + ':' + alphabet.length);
  if (vocabSize > TOKENIZER_VOCAB_MAX) return fail('tokenizer-vocab-above-max:' + vocabSize + ':' + TOKENIZER_VOCAB_MAX);
  const vocab: string[] = [...alphabet];
  const merges: string[] = [];
  while (vocab.length < vocabSize) {
    // Tokenize the corpus by applying every merge so far, in order.
    let word: string[] = Array.from(input.corpus);
    for (const m of merges) word = applyMerge(word, m);
    // Count adjacent pairs.
    const counts = new Map<string, number>();
    for (let i = 0; i + 1 < word.length; i++) {
      const left = word[i];
      const right = word[i + 1];
      if (left === undefined || right === undefined) continue;
      const key = pairKey(left, right);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (counts.size === 0) break;
    // Pick the most frequent pair; ties break lexicographically, left then right.
    let bestKey: string | null = null;
    let bestCount = 0;
    for (const [key, count] of counts) {
      if (bestKey === null) {
        bestKey = key;
        bestCount = count;
        continue;
      }
      if (count > bestCount || (count === bestCount && key < bestKey)) {
        bestKey = key;
        bestCount = count;
      }
    }
    if (bestKey === null) break;
    const sep = bestKey.indexOf(':');
    const left = bestKey.slice(0, sep);
    const right = bestKey.slice(sep + 1);
    const merged = left + right;
    if (!vocab.includes(merged)) vocab.push(merged);
    merges.push(merged);
  }
  const contentHash = 'tok_' + fp(input.corpus);
  return {
    ok: true,
    value: {
      vocab,
      merges,
      contentHash,
      fingerprint: 'tfp_' + fp(contentHash + ':' + vocabSize + ':' + vocab.length),
    },
  };
}

// Encode text into vocabulary indices, applying merges in training order.
export function encodeText(text: string, tokenizer: TrainedTokenizer): Verdict<number[]> {
  if (!isNonEmptyString(text)) return fail('tokenizer-no-text');
  const vocabSet = new Set(tokenizer.vocab);
  for (const ch of Array.from(text)) {
    if (!vocabSet.has(ch)) return fail('tokenizer-unknown-char:' + ch);
  }
  let tokens: string[] = Array.from(text);
  for (const m of tokenizer.merges) tokens = applyMerge(tokens, m);
  const indices: number[] = [];
  for (const t of tokens) {
    const idx = tokenizer.vocab.indexOf(t);
    if (idx === -1) return fail('tokenizer-unknown-char:' + t);
    indices.push(idx);
  }
  return { ok: true, value: indices };
}

// Decode vocabulary indices back into text.
export function decodeIndices(indices: number[], tokenizer: TrainedTokenizer): Verdict<string> {
  if (!Array.isArray(indices)) return fail('tokenizer-no-indices');
  const parts: string[] = [];
  for (const idx of indices) {
    const token = tokenizer.vocab[idx];
    if (token === undefined) return fail('tokenizer-unknown-token:' + String(idx));
    parts.push(token);
  }
  return { ok: true, value: parts.join('') };
}

// Register a trained tokenizer in the token store. Duplicate content hash (same corpus, same
// vocabSize) returns the existing record. The registry is appended to by the caller on success.
export function registerTokenizer(
  input: TrainTokenizerInput & { now: number },
  registry: TokenizerRecord[]
): Verdict<TokenizerRecord & { duplicate: boolean }> {
  if (!input) return fail('tokenizer-no-input');
  if (!isNum(input.now)) return fail('tokenizer-no-now');
  if (!registry || !Array.isArray(registry)) return fail('tokenizer-no-registry');
  const trained = trainTokenizer({ corpus: input.corpus, vocabSize: input.vocabSize });
  if (!trained.ok) return trained;
  const dup = registry.find((r) => r.contentHash === trained.value.contentHash && r.vocab.length === trained.value.vocab.length);
  if (dup) return { ok: true, value: { ...dup, duplicate: true } };
  const record: TokenizerRecord = {
    tokId: 'tok_' + (registry.length + 1),
    vocab: trained.value.vocab,
    merges: trained.value.merges,
    contentHash: trained.value.contentHash,
    fingerprint: trained.value.fingerprint,
    createdAt: input.now,
  };
  return { ok: true, value: { ...record, duplicate: false } };
}

// Fetch a registered tokenizer by id, for encode and decode calls.
export function tokenizerById(tokId: string, registry: TokenizerRecord[]): Verdict<TokenizerRecord> {
  if (!isNonEmptyString(tokId)) return fail('tokenizer-no-input');
  const rec = registry.find((r) => r.tokId === tokId);
  if (!rec) return fail('tokenizer-unknown-tokenizer:' + String(tokId));
  return { ok: true, value: { ...rec } };
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}
