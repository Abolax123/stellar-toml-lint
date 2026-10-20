/**
 * Static WASM memory limit and instruction budget estimator for Soroban contracts.
 *
 * Soroban enforces strict per-transaction CPU instruction and memory limits.
 * Contracts that declare large linear memories or have branch-heavy exported
 * functions can blow through the transaction budget under load. This module
 * parses the compiled WASM binary (no runtime, no network) and reports:
 *
 * - the Memory Section's minimum / maximum page allocation,
 * - table sizes from the Table Section,
 * - the static heap footprint (total bytes of Data Section segments),
 * - the cyclomatic complexity of each exported SEP-41 function.
 *
 * Diagnostics:
 * - `soroban/excessive-static-memory-pages` (warning)
 * - `soroban/high-cyclomatic-complexity` (warning)
 */

import type { Diagnostic, Rule, RuleOverrides } from '../types.js';
import { severityFor } from './rpc.js';
import { SEP41_MANDATORY_FUNCTIONS, decompressWasm } from './wasm-auditor.js';

export const EXCESSIVE_STATIC_MEMORY_PAGES_RULE = 'soroban/excessive-static-memory-pages';
export const HIGH_CYCLOMATIC_COMPLEXITY_RULE = 'soroban/high-cyclomatic-complexity';

/** Size of one WebAssembly linear-memory page. */
export const WASM_PAGE_SIZE = 65_536;

/** Minimum memory pages above which a warning fires (10 pages = 640 KB). */
export const DEFAULT_MAX_MEMORY_PAGES = 10;

/** Cyclomatic complexity above which an exported function is flagged. */
export const DEFAULT_MAX_CYCLOMATIC_COMPLEXITY = 50;

export interface BudgetEstimatorOptions {
  rules?: RuleOverrides;
  /** The file path that named the contract, attached to every diagnostic. */
  path?: string;
  /** Minimum memory pages allowed before the memory warning fires. */
  maxMemoryPages?: number;
  /** Cyclomatic complexity allowed per exported SEP-41 function. */
  maxCyclomaticComplexity?: number;
}

export interface WasmMemoryLimits {
  minPages: number;
  maxPages?: number;
}

export interface WasmBudgetEstimate {
  /** Declared (and imported) memories, in index order. */
  memories: WasmMemoryLimits[];
  /** Sum of every memory's minimum pages. */
  minMemoryPages: number;
  /** Sum of minimum pages * 64 KiB. */
  minMemoryBytes: number;
  /** Sum of declared table minimum element counts. */
  tableElements: number;
  /** Total bytes carried by Data Section segments (the static heap image). */
  staticDataBytes: number;
  /** Cyclomatic complexity of every exported SEP-41 function that has a body. */
  complexity: Record<string, number>;
}

class Reader {
  pos: number;
  constructor(
    readonly bytes: Uint8Array,
    start: number,
    readonly end: number = bytes.length,
  ) {
    this.pos = start;
  }

  byte(): number {
    if (this.pos >= this.end) throw new Error('unexpected end of section');
    return this.bytes[this.pos++] as number;
  }

  /** Unsigned LEB128 (also used to skip signed ones). */
  u(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return value;
      shift += 7;
      if (shift > 63) throw new Error('LEB128 too long');
    }
  }

  skip(n: number): void {
    if (this.pos + n > this.end) throw new Error('unexpected end of section');
    this.pos += n;
  }

  name(): string {
    const len = this.u();
    const start = this.pos;
    this.skip(len);
    return Buffer.from(this.bytes.subarray(start, this.pos)).toString('utf8');
  }
}

function readLimits(r: Reader): { min: number; max?: number } {
  const flags = r.u();
  const min = r.u();
  return (flags & 1) !== 0 ? { min, max: r.u() } : { min };
}

/** Skips a constant expression up to and including its `end` opcode. */
function skipConstExpr(r: Reader): void {
  for (;;) {
    const op = r.byte();
    if (op === 0x0b) return;
    if (op === 0x41 || op === 0x42 || op === 0x23 || op === 0xd2) r.u();
    else if (op === 0x43) r.skip(4);
    else if (op === 0x44) r.skip(8);
    else if (op === 0xd0) r.skip(1);
    else if (op === 0x6a || op === 0x6b || op === 0x6c || op === 0x7c || op === 0x7d) continue;
    else if (op === 0x7e) continue;
    else throw new Error(`unsupported constant expression opcode 0x${op.toString(16)}`);
  }
}

/**
 * Cyclomatic complexity of one function body: 1 plus one per `if`, `br_if`,
 * and `br_table` target. Stops quietly at an opcode it cannot decode, so an
 * exotic instruction never turns the estimate into a crash.
 */
function bodyComplexity(r: Reader): number {
  let complexity = 1;
  try {
    const groups = r.u();
    for (let i = 0; i < groups; i++) {
      r.u();
      r.skip(1);
    }
    while (r.pos < r.end) {
      const op = r.byte();
      if (op === 0x04) {
        complexity += 1;
        r.u();
      } else if (op === 0x02 || op === 0x03) {
        r.u();
      } else if (op === 0x0d) {
        complexity += 1;
        r.u();
      } else if (op === 0x0e) {
        const targets = r.u();
        complexity += targets;
        for (let t = 0; t <= targets; t++) r.u();
      } else if (op === 0x0c || op === 0x10 || (op >= 0x20 && op <= 0x26)) {
        r.u();
      } else if (op === 0x11) {
        r.u();
        r.u();
      } else if (op === 0x1c) {
        const n = r.u();
        r.skip(n);
      } else if (op >= 0x28 && op <= 0x3e) {
        r.u();
        r.u();
      } else if (op === 0x3f || op === 0x40 || op === 0x41 || op === 0x42 || op === 0xd2) {
        r.u();
      } else if (op === 0x43) {
        r.skip(4);
      } else if (op === 0x44) {
        r.skip(8);
      } else if (op === 0xd0) {
        r.skip(1);
      } else if (op === 0xfc) {
        const sub = r.u();
        if (sub === 8 || sub === 10 || sub === 12 || sub === 14) {
          r.u();
          r.u();
        } else if (sub === 9 || sub === 11 || sub === 13 || (sub >= 15 && sub <= 17)) {
          r.u();
        }
      } else if (
        op <= 0x01 ||
        op === 0x05 ||
        op === 0x0b ||
        op === 0x0f ||
        op === 0x1a ||
        op === 0x1b ||
        (op >= 0x45 && op <= 0xc4) ||
        op === 0xd1
      ) {
        // no immediates
      } else {
        break; // SIMD / atomics / unknown: keep what we have
      }
    }
  } catch {
    // truncated body: return the partial count
  }
  return complexity;
}

/**
 * Statically estimates a contract's memory and instruction-budget footprint.
 * Throws when the bytes are not a WebAssembly module.
 */
export function estimateWasmBudget(wasmBytes: Uint8Array): WasmBudgetEstimate {
  const wasm = decompressWasm(wasmBytes);
  if (
    wasm.length < 8 ||
    wasm[0] !== 0x00 ||
    wasm[1] !== 0x61 ||
    wasm[2] !== 0x73 ||
    wasm[3] !== 0x6d
  ) {
    throw new Error('not a WebAssembly binary');
  }

  const memories: WasmMemoryLimits[] = [];
  let tableElements = 0;
  let staticDataBytes = 0;
  let importedFuncs = 0;
  const exportedFuncs = new Map<string, number>();
  const bodies: { start: number; end: number }[] = [];

  let pos = 8;
  while (pos < wasm.length) {
    const head = new Reader(wasm, pos + 1);
    const id = wasm[pos] as number;
    const size = head.u();
    const start = head.pos;
    const end = start + size;
    if (end > wasm.length) throw new Error('section extends past the end of the file');
    const r = new Reader(wasm, start, end);

    if (id === 2) {
      for (let n = r.u(); n > 0; n--) {
        r.name();
        r.name();
        const kind = r.byte();
        if (kind === 0) {
          r.u();
          importedFuncs += 1;
        } else if (kind === 1) {
          r.skip(1);
          tableElements += readLimits(r).min;
        } else if (kind === 2) {
          const l = readLimits(r);
          memories.push({ minPages: l.min, ...(l.max !== undefined ? { maxPages: l.max } : {}) });
        } else if (kind === 3) {
          r.skip(2);
        } else {
          r.u();
          r.u();
        }
      }
    } else if (id === 4) {
      for (let n = r.u(); n > 0; n--) {
        r.skip(1);
        tableElements += readLimits(r).min;
      }
    } else if (id === 5) {
      for (let n = r.u(); n > 0; n--) {
        const l = readLimits(r);
        memories.push({ minPages: l.min, ...(l.max !== undefined ? { maxPages: l.max } : {}) });
      }
    } else if (id === 7) {
      for (let n = r.u(); n > 0; n--) {
        const name = r.name();
        const kind = r.byte();
        const index = r.u();
        if (kind === 0) exportedFuncs.set(name, index);
      }
    } else if (id === 10) {
      for (let n = r.u(); n > 0; n--) {
        const bodySize = r.u();
        bodies.push({ start: r.pos, end: r.pos + bodySize });
        r.skip(bodySize);
      }
    } else if (id === 11) {
      for (let n = r.u(); n > 0; n--) {
        const flag = r.u();
        if (flag === 2) r.u();
        if (flag === 0 || flag === 2) skipConstExpr(r);
        const len = r.u();
        r.skip(len);
        staticDataBytes += len;
      }
    }

    pos = end;
  }

  const complexity: Record<string, number> = {};
  for (const fnName of Object.keys(SEP41_MANDATORY_FUNCTIONS)) {
    const index = exportedFuncs.get(fnName);
    if (index === undefined) continue;
    const body = bodies[index - importedFuncs];
    if (body === undefined) continue;
    complexity[fnName] = bodyComplexity(new Reader(wasm, body.start, body.end));
  }

  const minMemoryPages = memories.reduce((sum, m) => sum + m.minPages, 0);
  return {
    memories,
    minMemoryPages,
    minMemoryBytes: minMemoryPages * WASM_PAGE_SIZE,
    tableElements,
    staticDataBytes,
    complexity,
  };
}

/** Audits a compiled contract's WASM bytes against the static budget limits. */
export function auditWasmBudget(
  wasmBytes: Uint8Array,
  contractId: string,
  options: BudgetEstimatorOptions = {},
): Diagnostic[] {
  let estimate: WasmBudgetEstimate;
  try {
    estimate = estimateWasmBudget(wasmBytes);
  } catch {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const pathField = options.path !== undefined ? { path: options.path } : {};
  const maxPages = options.maxMemoryPages ?? DEFAULT_MAX_MEMORY_PAGES;
  const maxComplexity = options.maxCyclomaticComplexity ?? DEFAULT_MAX_CYCLOMATIC_COMPLEXITY;

  if (estimate.minMemoryPages > maxPages) {
    const severity = severityFor(EXCESSIVE_STATIC_MEMORY_PAGES_RULE, 'warning', options.rules);
    if (severity !== undefined) {
      diagnostics.push({
        rule: EXCESSIVE_STATIC_MEMORY_PAGES_RULE,
        severity,
        category: 'network',
        message: `Contract ${contractId} WASM requests a minimum of ${estimate.minMemoryPages} memory pages (${estimate.minMemoryBytes / 1024} KB), exceeding the ${maxPages}-page (${(maxPages * WASM_PAGE_SIZE) / 1024} KB) budget; static data image is ${estimate.staticDataBytes} bytes`,
        ...pathField,
        suggestion:
          'Reduce static allocations and initial linear memory so the contract stays within the Soroban per-transaction memory budget.',
      });
    }
  }

  for (const [fnName, value] of Object.entries(estimate.complexity)) {
    if (value <= maxComplexity) continue;
    const severity = severityFor(HIGH_CYCLOMATIC_COMPLEXITY_RULE, 'warning', options.rules);
    if (severity === undefined) continue;
    diagnostics.push({
      rule: HIGH_CYCLOMATIC_COMPLEXITY_RULE,
      severity,
      category: 'network',
      message: `Contract ${contractId} exported function "${fnName}" has cyclomatic complexity ${value}, exceeding the limit of ${maxComplexity}`,
      ...pathField,
      suggestion:
        'Split branch-heavy logic into smaller functions or simplify control flow to reduce CPU instruction cost.',
    });
  }

  return diagnostics;
}

/** Registered so `--list-rules` and `--off`/`--warn`/`--error` know these ids. */
export const budgetEstimatorRules: Rule[] = [
  {
    id: EXCESSIVE_STATIC_MEMORY_PAGES_RULE,
    category: 'network',
    severity: 'warning',
    description: 'A Soroban contract WASM requests more than 10 minimum memory pages (640 KB)',
    run() {},
  },
  {
    id: HIGH_CYCLOMATIC_COMPLEXITY_RULE,
    category: 'network',
    severity: 'warning',
    description: 'An exported SEP-41 function of a Soroban contract has high cyclomatic complexity',
    run() {},
  },
];

export const budgetEstimatorRuleIds: readonly string[] = budgetEstimatorRules.map(
  (rule) => rule.id,
);
