/**
 * The playground page: paste a `stellar.toml`, watch the corridor DAG redraw.
 *
 * The linter runs in the browser via `stellar-toml-lint/browser`, so the page
 * needs no server and no network — which is the whole point of an offline
 * linter. Its diagnostics feed the visualizer, so a stage the linter complains
 * about is the same stage that turns red.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { lintBrowser } from 'stellar-toml-lint/browser';
import { CorridorVisualizer } from './components/CorridorVisualizer';
import type { CorridorDiagnostic } from './corridor-graph';

/** A SEP-24 anchor that forgot its KYC server — one red bridge, on purpose. */
const SAMPLE = `VERSION = "1.0.0"
NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"
SIGNING_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
ANCHOR_QUOTE_SERVER = "https://anchor.example.com/sep38"
TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/sep24"

[DOCUMENTATION]
ORG_NAME = "Example Anchor"
ORG_URL = "https://anchor.example.com"
ORG_DESCRIPTION = "A test anchor for the corridor visualizer."

[[CURRENCIES]]
code = "USDC"
issuer = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
is_asset_anchored = true
anchor_asset_type = "crypto"
`;

function App(): JSX.Element {
  const [source, setSource] = useState(SAMPLE);
  const [diagnostics, setDiagnostics] = useState<CorridorDiagnostic[]>([]);
  const [activeLine, setActiveLine] = useState<number | undefined>(undefined);
  const codeRef = useRef<HTMLPreElement | null>(null);

  // Debounced so typing does not re-lint on every keystroke.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      lintBrowser(source)
        .then((result) => {
          if (cancelled) return;
          setDiagnostics(
            result.diagnostics.map((diagnostic) => ({
              rule: diagnostic.rule,
              severity: diagnostic.severity,
              message: diagnostic.message,
              path: diagnostic.path,
            })),
          );
        })
        .catch(() => {
          // A parse failure is reported by the linter's own diagnostics; the
          // visualizer simply gets nothing to colour.
          if (!cancelled) setDiagnostics([]);
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source]);

  const lines = useMemo(() => source.split(/\r?\n/), [source]);

  const jumpToLine = useCallback((line: number) => {
    setActiveLine(line);
    const target = codeRef.current?.querySelector(`[data-line="${line}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  return (
    <div className="playground">
      <header className="playground__header">
        <h1>stellar.toml corridor playground</h1>
        <p>
          Edit the info file and the corridor redraws. Missing or misconfigured service bridges are
          drawn red; click a stage to jump to the line that declared it.
        </p>
      </header>

      <section className="playground__editor">
        <label htmlFor="toml">stellar.toml</label>
        <textarea
          id="toml"
          spellCheck={false}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          rows={18}
        />
      </section>

      <section className="playground__graph">
        <CorridorVisualizer source={source} diagnostics={diagnostics} onSelectLine={jumpToLine} />
      </section>

      <section className="playground__source">
        <h2>Source</h2>
        <pre ref={codeRef} className="playground__code">
          {lines.map((text, index) => {
            const number = index + 1;
            return (
              <span
                key={number}
                data-line={number}
                className={number === activeLine ? 'code-line code-line--active' : 'code-line'}
              >
                <span className="code-line__number">{String(number).padStart(4, ' ')}</span>
                <span>{text}</span>
                {'\n'}
              </span>
            );
          })}
        </pre>
      </section>

      <section className="playground__findings">
        <h2>Findings ({diagnostics.length})</h2>
        <ul>
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.rule}-${index}`}>
              <strong>{diagnostic.severity}</strong> <code>{diagnostic.rule}</code>{' '}
              {diagnostic.message}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(<App />);
}
