import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xdr } from '@stellar/stellar-base';

import { contractIdOnLine, getContractHover } from '../src/lsp/contract-hover.js';

const CONTRACT_ID = `C${'A'.repeat(55)}`;
const DOC = ['NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"', '', '[[CURRENCIES]]', `contract_id = "${CONTRACT_ID}"`, ''].join('\n');
const LINE = 3;

function leb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

/** A minimal WASM module whose only content is a `contractspecv0` section. */
function wasmWithErrors(): Buffer {
  const errorEnum = new xdr.ScSpecUdtErrorEnumV0({
    doc: 'Errors the vault returns',
    lib: '',
    name: 'VaultError',
    cases: [
      new xdr.ScSpecUdtErrorEnumCaseV0({ doc: 'Caller is not the admin', name: 'NotAuthorized', value: 1 }),
      new xdr.ScSpecUdtErrorEnumCaseV0({ doc: 'Balance too low | try less', name: 'Insufficient', value: 2 }),
    ],
  });
  const payload = xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(errorEnum).toXDR();
  const name = Buffer.from('contractspecv0');
  const body = Buffer.concat([Buffer.from(leb(name.length)), name, payload]);
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from(leb(body.length)),
    body,
  ]);
}

describe('getContractHover', () => {
  let cacheDir: string;

  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'contract-hover-'));
    writeFileSync(join(cacheDir, `${CONTRACT_ID}.wasm`), wasmWithErrors());
  });

  afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('renders a markdown table of error codes for a cached contract', async () => {
    const hover = await getContractHover(DOC, { line: LINE, character: 3 }, { cacheDir });
    const value = hover?.contents.value ?? '';

    expect(hover?.contents.kind).toBe('markdown');
    expect(value).toContain('| Code | Name | Description |');
    expect(value).toContain('| 1 | `NotAuthorized` | Caller is not the admin |');
    expect(value).toContain('| 2 | `Insufficient` | Balance too low \\| try less |');
    expect(value).toContain('`VaultError` — Errors the vault returns');
    expect(hover?.range.start.line).toBe(LINE);
  });

  it('falls back to the RPC when nothing is cached', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;

    const hover = await getContractHover(
      DOC,
      { line: LINE, character: 0 },
      { cacheDir: join(cacheDir, 'missing'), fetchImpl },
    );
    expect(hover).toBeNull();
    expect(calls).toBeGreaterThan(0);
  });

  it('ignores lines that are not a contract_id assignment', async () => {
    expect(await getContractHover(DOC, { line: 0, character: 0 }, { cacheDir })).toBeNull();
    expect(await getContractHover(DOC, { line: 99, character: 0 }, { cacheDir })).toBeNull();
    expect(contractIdOnLine('contract_id = "nope"')).toBeUndefined();
    expect(contractIdOnLine(`  CONTRACT_ID = "${CONTRACT_ID}"`)).toBe(CONTRACT_ID);
  });
});
