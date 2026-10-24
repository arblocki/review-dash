import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError } from './api';
import type { AnalysisResponse, ProvidersResponse } from './types';

export interface ProviderChoice {
  provider: string;
  model: string;
}

export interface AnalysisContextValue {
  /** Last successful analysis; kept while a re-analysis is running. */
  result: AnalysisResponse | null;
  loading: boolean;
  /** Seconds since the current request started. */
  elapsedS: number;
  error: { code?: string; message: string } | null;
  providers: ProvidersResponse | null;
  /** Provider/model the next (or current) request uses; null = server default. */
  choice: ProviderChoice | null;
  setChoice(c: ProviderChoice): void;
  reanalyze(): void;
}

const AnalysisContext = createContext<AnalysisContextValue | null>(null);

export function useAnalysis(): AnalysisContextValue {
  const v = useContext(AnalysisContext);
  if (!v) throw new Error('useAnalysis outside AnalysisProvider');
  return v;
}

/**
 * Requests /api/analysis in the background so the file view stays usable. The request is
 * aborted and replaced when the provider/model changes or Re-analyze is pressed.
 */
export function AnalysisProvider({ children }: { children: ReactNode }) {
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [elapsedS, setElapsedS] = useState(0);
  const [error, setError] = useState<AnalysisContextValue['error']>(null);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [choice, setChoiceState] = useState<ProviderChoice | null>(null);
  const [req, setReq] = useState({ id: 0, force: false });
  const choiceRef = useRef<ProviderChoice | null>(null);

  useEffect(() => {
    api<ProvidersResponse>('/api/providers').then(setProviders, () => undefined);
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    const started = Date.now();
    setLoading(true);
    setError(null);
    setElapsedS(0);
    const tick = setInterval(() => setElapsedS(Math.floor((Date.now() - started) / 1000)), 500);
    const params = new URLSearchParams();
    if (req.force) params.set('force', '1');
    const choice = choiceRef.current;
    if (choice) {
      params.set('provider', choice.provider);
      if (choice.model) params.set('model', choice.model);
    }
    const qs = params.toString();
    api<AnalysisResponse>(`/api/analysis${qs ? `?${qs}` : ''}`, { signal: ctl.signal })
      .then((res) => {
        setResult(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setError({
          code: err instanceof ApiError ? err.code : undefined,
          message: (err as Error).message,
        });
        setLoading(false);
      })
      .finally(() => clearInterval(tick));
    return () => {
      ctl.abort();
      clearInterval(tick);
    };
  }, [req]);

  const setChoice = useCallback((c: ProviderChoice) => {
    choiceRef.current = c;
    setChoiceState(c);
    setReq((r) => ({ id: r.id + 1, force: false }));
  }, []);
  const reanalyze = useCallback(() => setReq((r) => ({ id: r.id + 1, force: true })), []);

  const value = useMemo(
    () => ({ result, loading, elapsedS, error, providers, choice, setChoice, reanalyze }),
    [result, loading, elapsedS, error, providers, choice, setChoice, reanalyze],
  );
  return <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>;
}
