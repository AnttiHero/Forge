/**
 * In-memory run registry — long pipelines (drafting) report progress here;
 * the SSE route streams it to the browser.
 */

export interface RunEvent {
  ts: number;
  stage: string;
  status: 'start' | 'done' | 'error' | 'info';
  detail?: string;
}

export interface Run {
  id: string;
  kind: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  events: RunEvent[];
  result?: unknown;
  error?: string;
}

type Listener = (event: RunEvent | { type: 'end'; status: Run['status'] }) => void;

const runs = new Map<string, Run>();
const listeners = new Map<string, Set<Listener>>();
const MAX_RUNS = 50;

export function createRun(id: string, kind: string): Run {
  const run: Run = { id, kind, status: 'running', startedAt: Date.now(), events: [] };
  runs.set(id, run);
  if (runs.size > MAX_RUNS) {
    const oldest = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest && oldest.id !== id) runs.delete(oldest.id);
  }
  return run;
}

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function emit(runId: string, stage: string, status: RunEvent['status'], detail?: string): void {
  const run = runs.get(runId);
  if (!run) return;
  const event: RunEvent = { ts: Date.now(), stage, status, detail };
  run.events.push(event);
  for (const l of listeners.get(runId) ?? []) l(event);
}

export function finishRun(runId: string, result: unknown): void {
  const run = runs.get(runId);
  if (!run) return;
  run.status = 'done';
  run.result = result;
  for (const l of listeners.get(runId) ?? []) l({ type: 'end', status: 'done' });
}

export function failRun(runId: string, error: string): void {
  const run = runs.get(runId);
  if (!run) return;
  run.status = 'error';
  run.error = error;
  for (const l of listeners.get(runId) ?? []) l({ type: 'end', status: 'error' });
}

export function subscribe(runId: string, listener: Listener): () => void {
  let set = listeners.get(runId);
  if (!set) {
    set = new Set();
    listeners.set(runId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(runId);
  };
}
