/**
 * `textDocument/hover` on a `contract_id` line — the contract's own error
 * catalogue, read from the `contractspecv0` section of its deployed WASM.
 *
 * Soroban reports a failed call as a bare integer, and the names and docs that
 * explain it live in the contract's spec, not in `stellar.toml`. Hovering the
 * line that declares the contract renders that catalogue as a Markdown table so
 * nobody has to dig through the Rust source. The WASM comes from a local cache
 * when one is present and from the declared network's Soroban RPC otherwise; a
 * contract that cannot be resolved simply has no tooltip.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchContractWasm } from '../soroban.js';
import { parseContractErrorSpecs } from '../soroban/errors.js';
import type { SorobanErrorEnum } from '../soroban/errors.js';
import { networkTargetFor } from '../soroban/multi-network.js';
import type { Hover, HoverPosition } from './hover.js';

/** A `contract_id = "C..."` assignment; the key is matched case-insensitively. */
const CONTRACT_ID_LINE = /^\s*(contract_id)\s*=\s*"(C[A-Z2-7]{55})"/i;

export interface ContractHoverOptions {
  /** Directory holding `<contract id>.wasm` files; defaults to `.stellar-toml-lint/wasm`. */
  cacheDir?: string;
  /** Overrides the RPC derived from `NETWORK_PASSPHRASE`. */
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
}

/** The contract ID declared on `line`, if it is a `contract_id` assignment. */
export function contractIdOnLine(line: string): string | undefined {
  return CONTRACT_ID_LINE.exec(line)?.[2];
}

/** Reads `<cacheDir>/<id>.wasm` when it exists. */
function cachedWasm(contractId: string, cacheDir: string | undefined): Buffer | undefined {
  const dir =
    cacheDir ?? process.env.STELLAR_TOML_LINT_WASM_CACHE ?? join('.stellar-toml-lint', 'wasm');
  const file = join(dir, `${contractId}.wasm`);
  try {
    return existsSync(file) ? readFileSync(file) : undefined;
  } catch {
    return undefined;
  }
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ').trim();
}

/** Renders the error enums as one Markdown table per enum. */
export function formatContractErrorDocs(contractId: string, enums: SorobanErrorEnum[]): string {
  const populated = enums.filter((one) => one.cases.length > 0);
  const parts = [`**Contract errors** — \`${contractId}\``];

  if (populated.length === 0) {
    parts.push('*This contract declares no custom errors.*');
    return parts.join('\n\n');
  }

  for (const one of populated) {
    const heading = one.doc.trim() === '' ? `\`${one.name}\`` : `\`${one.name}\` — ${cell(one.doc)}`;
    const rows = [...one.cases]
      .sort((a, b) => a.code - b.code || a.name.localeCompare(b.name))
      .map((c) => `| ${c.code} | \`${cell(c.name)}\` | ${cell(c.doc)} |`);
    parts.push(heading, ['| Code | Name | Description |', '| ---: | --- | --- |', ...rows].join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * The hover for a `contract_id` line, or `null` when the cursor is not on one
 * or the contract's WASM cannot be resolved.
 */
export async function getContractHover(
  doc: string,
  position: HoverPosition,
  options: ContractHoverOptions = {},
): Promise<Hover | null> {
  const line = doc.split(/\r?\n/)[position.line];
  if (line === undefined) return null;
  const contractId = contractIdOnLine(line);
  if (contractId === undefined) return null;

  let wasm = cachedWasm(contractId, options.cacheDir);
  if (wasm === undefined) {
    const passphrase = /^\s*NETWORK_PASSPHRASE\s*=\s*"([^"]*)"/m.exec(doc)?.[1];
    const rpcUrl = options.rpcUrl ?? networkTargetFor(passphrase)?.rpcUrl;
    if (rpcUrl === undefined) return null;
    try {
      wasm = await fetchContractWasm(contractId, rpcUrl, options.fetchImpl ?? fetch);
    } catch {
      return null;
    }
  }
  if (wasm === undefined) return null;

  let enums: SorobanErrorEnum[];
  try {
    enums = parseContractErrorSpecs(wasm);
  } catch {
    return null;
  }

  return {
    contents: { kind: 'markdown', value: formatContractErrorDocs(contractId, enums) },
    range: {
      start: { line: position.line, character: line.length - line.trimStart().length },
      end: { line: position.line, character: line.length },
    },
  };
}
