/*
 * Read-only contract helpers.
 *
 * Houses the raw contract read paths (single claim and range queries) that
 * wrap the generated bindings client. No state-changing logic lives here.
 */

import { getContractClient } from './client';

export interface RawClaim {
  id: bigint;
  creator: string;
  amount: bigint;
  status: number;
  createdAt: bigint;
  expiresAt: bigint;
  metadataURI?: string;
}

export interface RawClaimRange {
  claims: RawClaim[];
  nextCursor?: bigint;
  total: number;
}

const BATCH_SIZE = 50;

let batchViewUnsupported = false;

/**
 * Fetch a single claim by id directly from the contract.
 * Returns null when the claim does not exist.
 */
export async function readClaimRaw(id: bigint | number | string): Promise<RawClaim | null> {
  const client = getContractClient();
  const claimId = typeof id === 'bigint' ? id : BigInt(id);
  try {
    const result = await client.readClaim({ id: claimId });
    if (!result) {
      return null;
    }
    return normalizeRawClaim(result);
  } catch (err) {
    if (isNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * Fetch a page of claims within a cursor range.
 *
 * Uses the contract's `get_claims_batch` view in chunks of 50 to avoid one
 * simulation per claim. Order is preserved and missing ids are returned as `Null`.
 * Falls back to the per-id path if the deployed contract lacks the
 * batch method.
 */
export async function readClaimsRange(
  startCursor: bigint | number | string = 0,
  limit: number = 20,
): Promise<RawClaimRange> {
  const cursor = typeof startCursor === 'bigint' ? startCursor : BigInt(startCursor);
  const count = Math.max(0, Math.floor(limit));
  if (count === 0) {
    return { claims: [], nextCursor: undefined, total: 0 };
  }

  const claims = await readClaimsByIds(rangeIds(cursor, count));
  return {
    claims,
    nextCursor: cursor + BigInt(count),
    total: claims.length,
  };
}

/**
 * Read a contiguous range of claim ids, resolving each id to a claim or
 * `null`. Uses `get_claims_batch` in chunks of 50, falling back to the
 * per-id path when the contract does not expose the batch view.
 */
async function readClaimsByIds(ids: bigint[]): Promise<RawClaim[]> {
  if (ids.length === 0) return [];

  if (!batchViewUnsupported) {
    try {
      return await readClaimsBatch(ids);
    } catch (err) {
      if (!isMethodMissingError(err)) {
        throw err;
      }
      batchViewUnsupported = true;
      console.warn(
        '[contract] get_claims_batch unavailable on deployed contract; falling back to per-id claim reads',
      );
    }
  }

  return readClaimsByIdPerId(ids);
}

async function readClaimsBatch(ids: bigint[]): Promise<RawClaim[]> {
  const client = getContractClient();
  const out: RawClaim[] = [];
  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + BATCH_SIZE);
    const result = await client.getClaimsBatch({ ids: chunk });
    const rows = (result ?? []) as Array<unknown>;
    for (let i = 0; i < chunk.length; i++) {
      const row = rows[i];
      if (row == null) {
        continue;
      }
      out.push(normalizeRawClaim(row));
    }
  }
  return out;
}

async function readClaimsByIdPerId(ids: bigint[]): Promise<RawClaim[]> {
  const results = await mapWithConcurrency(ids, 10, (id) => readClaimRaw(id));
  const claims: RawClaim[] = [];
  for (const claim of results) {
    if (claim) {
      claims.push(claim);
    }
  }
  return claims;
}

function rangeIds(cursor: bigint, count: number): bigint[] {
  const ids = new Array<bigint>(count);
  for (let i = 0; i < count; i++) {
    ids[i] = cursor + BigInt(i);
  }
  return ids;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  factory: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = new Array<Promise<void>>(Math.min(concurrency, items.length));
  for (let w = 0; w < workers.length; w++) {
    workers[w] = (async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await factory(items[index], index);
      }
    })();
  }
  await Promise.all(workers);
  return results;
}

function normalizeRawClaim(input: any): RawClaim {
  return {
    id: toBigInt(input.id),
    creator: String(input.creator),
    amount: toBigInt(input.amount),
    status: Number(input.status),
    createdAt: toBigInt(input.createdAt),
    expiresAt: toBigInt(input.expiresAt),
    metadataUri: input.metadataUri ?? undefined,
  };
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = String((err as { message?: unknown }).message ?? '').toLowerCase();
  return message.includes('not found') || message.includes('notfound');
}

function isMethodMissingError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'object') {
    const candidate = err as { code?: unknown; message?: unknown };
    if (candidate.code === 'METHOD_NOT_FOUND') return true;
    const message = String(candidate.message ?? '').toLowerCase();
    return (
      message.includes('method not found') ||
      message.includes('not implemented') ||
      message.includes('unknown method') ||
      message.includes('get_claims_batch')
    );
  }
  return false;
}
