import { describe, expect, it } from 'vitest';
import {
  EXCESSIVE_STATIC_MEMORY_PAGES_RULE,
  HIGH_CYCLOMATIC_COMPLEXITY_RULE,
  auditWasmBudget,
  budgetEstimatorRules,
  estimateWasmBudget,
} from '../src/soroban/budget-estimator.js';

const CONTRACT = 'CACTZSQPCQSSZ5YG3PI3N7WO6JEERKEUHTPILKB4MBANF2K4D2UHKDDU';

function leb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

function section(id: number, payload: number[]): number[] {
  return [id, ...leb(payload.length), ...payload];
}

function str(s: string): number[] {
  return [...leb(s.length), ...Buffer.from(s)];
}

interface FnSpec {
  name: string;
  /** Number of `if` instructions in the body. */
  branches: number;
}

function buildWasm(options: { minPages: number; maxPages?: number; fns: FnSpec[]; data?: number }) {
  const { minPages, maxPages, fns, data = 0 } = options;
  const type = section(1, [1, 0x60, 0, 0]);
  const funcs = section(3, [...leb(fns.length), ...fns.map(() => 0)]);
  const mem = section(
    5,
    maxPages === undefined ? [1, 0, ...leb(minPages)] : [1, 1, ...leb(minPages), ...leb(maxPages)],
  );
  const exports = section(7, [
    ...leb(fns.length),
    ...fns.flatMap((f, i) => [...str(f.name), 0, i]),
  ]);
  const code = section(10, [
    ...leb(fns.length),
    ...fns.flatMap((f) => {
      // no locals, `if` blocks (empty blocktype 0x40) each closed by `end`, then final `end`
      const body = [0, ...Array.from({ length: f.branches }, () => [0x41, 1, 0x04, 0x40, 0x0b]).flat(), 0x0b];
      return [...leb(body.length), ...body];
    }),
  ]);
  const dataSection =
    data > 0 ? [...section(11, [1, 0, 0x41, 0, 0x0b, ...leb(data), ...new Array(data).fill(7)])] : [];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...type, ...funcs, ...mem, ...exports, ...code, ...dataSection,
  ]);
}

describe('soroban WASM budget estimator (#287)', () => {
  it('passes a standard token contract', () => {
    const wasm = buildWasm({
      minPages: 1,
      maxPages: 16,
      fns: [
        { name: 'balance', branches: 2 },
        { name: 'transfer', branches: 4 },
        { name: 'decimals', branches: 0 },
      ],
      data: 64,
    });
    expect(auditWasmBudget(wasm, CONTRACT)).toEqual([]);

    const estimate = estimateWasmBudget(wasm);
    expect(estimate.minMemoryPages).toBe(1);
    expect(estimate.memories).toEqual([{ minPages: 1, maxPages: 16 }]);
    expect(estimate.staticDataBytes).toBe(64);
    expect(estimate.complexity).toEqual({ balance: 3, transfer: 5, decimals: 1 });
  });

  it('asserts soroban/excessive-static-memory-pages for oversized minimum memory', () => {
    const wasm = buildWasm({ minPages: 11, fns: [{ name: 'balance', branches: 0 }] });
    const diagnostics = auditWasmBudget(wasm, CONTRACT, { path: 'CURRENCIES[0]' });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        rule: EXCESSIVE_STATIC_MEMORY_PAGES_RULE,
        severity: 'warning',
        path: 'CURRENCIES[0]',
      }),
    );
  });

  it('does not flag exactly 10 pages', () => {
    const wasm = buildWasm({ minPages: 10, fns: [{ name: 'balance', branches: 0 }] });
    expect(auditWasmBudget(wasm, CONTRACT)).toEqual([]);
  });

  it('asserts soroban/high-cyclomatic-complexity above the limit', () => {
    const wasm = buildWasm({ minPages: 1, fns: [{ name: 'transfer', branches: 60 }] });
    const diagnostics = auditWasmBudget(wasm, CONTRACT);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: HIGH_CYCLOMATIC_COMPLEXITY_RULE, severity: 'warning' }),
    );
    expect(auditWasmBudget(wasm, CONTRACT, { maxCyclomaticComplexity: 100 })).toEqual([]);
  });

  it('honours rule overrides and ignores non-WASM input', () => {
    const wasm = buildWasm({ minPages: 20, fns: [{ name: 'balance', branches: 0 }] });
    expect(
      auditWasmBudget(wasm, CONTRACT, { rules: { [EXCESSIVE_STATIC_MEMORY_PAGES_RULE]: 'off' } }),
    ).toEqual([]);
    expect(auditWasmBudget(new Uint8Array([1, 2, 3]), CONTRACT)).toEqual([]);
  });

  it('registers both rule definitions', () => {
    expect(budgetEstimatorRules.map((r) => ({ id: r.id, severity: r.severity }))).toEqual([
      { id: EXCESSIVE_STATIC_MEMORY_PAGES_RULE, severity: 'warning' },
      { id: HIGH_CYCLOMATIC_COMPLEXITY_RULE, severity: 'warning' },
    ]);
  });
});
