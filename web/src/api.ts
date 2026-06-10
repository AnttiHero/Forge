const BASE = '/api';

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function uploadDocument(fundId: string, file: File, title?: string): Promise<{
  documentId: string;
  title: string;
  type: string;
  provisionCount: number;
  charCount: number;
  embedded: number;
}> {
  const form = new FormData();
  form.append('fundId', fundId);
  if (title) form.append('title', title);
  form.append('file', file);
  const res = await fetch(`${BASE}/documents/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return res.json();
}

export async function downloadDocx(kind: 'mfn-compendium' | 'side-letters', payload: unknown, filename: string): Promise<void> {
  const res = await fetch(`${BASE}/export/docx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, payload, filename }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface RunEvent {
  ts: number;
  stage: string;
  status: 'start' | 'done' | 'error' | 'info';
  detail?: string;
}

export interface RunEnd {
  type: 'end';
  status: 'done' | 'error';
  result?: unknown;
  error?: string;
}

export function subscribeRun(runId: string, onEvent: (e: RunEvent) => void, onEnd: (e: RunEnd) => void): () => void {
  const source = new EventSource(`${BASE}/runs/${runId}/events`);
  source.onmessage = (msg) => {
    const data = JSON.parse(msg.data) as RunEvent | RunEnd;
    if ('type' in data && data.type === 'end') {
      onEnd(data);
      source.close();
    } else {
      onEvent(data as RunEvent);
    }
  };
  source.onerror = () => source.close();
  return () => source.close();
}

// ── Shared shapes ────────────────────────────────────────────────────────

export interface Citation {
  sourceType: string;
  sourceId: string;
  quote: string;
  verified?: boolean;
}

export interface Health {
  ok: boolean;
  model: string;
  anthropicKey: boolean;
  ollama: 'up' | 'down';
  degraded: { anonymization: string | null; search: string | null };
}

export interface Fund {
  id: string;
  name: string;
  numeral: number;
  target_size_usd: number;
  strategy: string;
  status: string;
  vintage: number;
  investor_count: number;
  committed_usd: number;
  obligation_count: number;
}

export interface Obligation {
  id: string;
  type: string;
  summary: string;
  geography: string | null;
  notice_days: number | null;
  source_clause: string;
  verified: number;
  investor_name: string | null;
  document_title: string;
}

export function usd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(n % 1_000_000_000 === 0 ? 0 : 1)}B`;
  if (n >= 1_000_000) return `$${Math.round(n / 1_000_000)}M`;
  return `$${n.toLocaleString()}`;
}
