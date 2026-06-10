import { useEffect, useRef, useState } from 'react';
import { get, post, uploadDocument, type Fund } from '../api.js';
import { SectionTitle, Button, ErrorNote } from '../components.js';

interface Extracted {
  obligations: Array<{ id: string; type: string; summary: string; geography: string | null; noticeDays: number | null; verified: boolean }>;
}

const TYPE_COLORS: Record<string, string> = {
  excuse: 'text-ember',
  notice: 'text-warn',
  reporting: 'text-verdant',
  consent: 'text-ember',
  mfn: 'text-fog',
  transfer_restriction: 'text-fog',
  investment_restriction: 'text-warn',
};

export function Intake({ onUseMatter }: { onUseMatter?: (fundId: string) => void }) {
  const [matters, setMatters] = useState<Fund[]>([]);
  const [matterId, setMatterId] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpload, setLastUpload] = useState<{ title: string; provisionCount: number; embedded: number } | null>(null);
  const [extracted, setExtracted] = useState<Extracted | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadMatters = () => get<Fund[]>('/funds').then(setMatters).catch(() => {});
  useEffect(() => {
    loadMatters();
  }, []);

  const createMatter = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const fund = await post<Fund>('/matters', { name: newName.trim() });
      setNewName('');
      await loadMatters();
      setMatterId(fund.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const onFile = async (file: File) => {
    if (!matterId) {
      setError('Create or choose an engagement first.');
      return;
    }
    setUploading(true);
    setError(null);
    setExtracted(null);
    setLastUpload(null);
    try {
      const up = await uploadDocument(matterId, file);
      setLastUpload(up);
      await loadMatters();
      // chain straight into extraction — the useful part
      setExtracting(true);
      setExtracted(await post<Extracted>(`/obligations/extract/${up.documentId}`, {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      setExtracting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const busy = uploading || extracting;
  const verifiedCount = extracted?.obligations.filter((o) => o.verified).length ?? 0;

  return (
    <div>
      <SectionTitle
        eyebrow="Bring your own"
        sub="Upload an LPA or side letter. It's read on your machine, every ongoing duty in it is pulled out, and each one is checked word-for-word against the document before it goes on file. Two steps, then ask it anything."
      >
        Documents
      </SectionTitle>

      <div className="stagger grid gap-6 md:grid-cols-2">
        {/* Choose / create engagement */}
        <div className="card p-7">
          <div className="flex items-center gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ember/12 font-mono text-xs font-semibold text-ember">
              1
            </span>
            <h3 className="text-sm font-semibold text-bone">Choose the matter</h3>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-fog">Documents are filed under a fund or client matter — like a deal room.</p>
          {matters.length > 0 && (
            <select value={matterId} onChange={(e) => setMatterId(e.target.value)} className="field mt-4 w-full">
              <option value="">Choose an existing engagement…</option>
              {matters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          <div className="mt-3 flex gap-2.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createMatter()}
              placeholder="…or name a new one"
              className="field w-full flex-1 py-2 text-sm"
            />
            <Button onClick={createMatter} busy={creating} disabled={!newName.trim()}>
              Create
            </Button>
          </div>
        </div>

        {/* Upload */}
        <div className="card p-7">
          <div className="flex items-center gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ember/12 font-mono text-xs font-semibold text-ember">
              2
            </span>
            <h3 className="text-sm font-semibold text-bone">Add a document</h3>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-fog">PDF, Word or text. Names are masked on this machine before any AI sees a word.</p>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              if (matterId && !busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file && matterId && !busy) void onFile(file);
            }}
            className={`mt-4 flex h-32 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed text-center text-xs transition-all duration-300 ${
              dragging
                ? 'scale-[1.02] border-ember bg-ember/[0.06] text-ember shadow-[0_8px_30px_rgba(196,95,63,0.18)]'
                : matterId
                  ? 'border-black/20 text-fog hover:border-ember/60 hover:bg-ember/[0.025] hover:text-ember'
                  : 'border-black/10 text-fog/50'
            }`}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.md,.txt,.markdown,text/*,application/pdf"
              className="hidden"
              disabled={!matterId || busy}
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
            {uploading ? (
              <span className="flex items-center gap-2">
                <span className="spinner-light spinner" /> Parsing on device…
              </span>
            ) : extracting ? (
              <span className="flex items-center gap-2">
                <span className="spinner-light spinner" /> Extracting obligations…
              </span>
            ) : (
              <>
                <span className="text-2xl transition-transform duration-300">{dragging ? '⬇' : '↥'}</span>
                <span className="mt-1.5 font-medium">
                  {dragging ? 'Drop it' : matterId ? 'Drop a file or click to choose' : 'Choose an engagement first'}
                </span>
              </>
            )}
          </label>
        </div>
      </div>
      <ErrorNote error={error} />

      {lastUpload && (
        <p className="animate-fade-up mt-5 text-xs text-fog">
          Parsed <span className="font-medium text-bone">{lastUpload.title}</span> — {lastUpload.provisionCount} provisions
          {lastUpload.embedded > 0 ? `, ${lastUpload.embedded} embedded for semantic search` : ''}.
        </p>
      )}

      {extracted && (
        <div className="animate-fade-up mt-6">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-bone">
              This document creates {extracted.obligations.length} ongoing dut{extracted.obligations.length === 1 ? 'y' : 'ies'} — now on file
            </h3>
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-fog tabular-nums">
              <span className={`h-1.5 w-1.5 rounded-full ${verifiedCount === extracted.obligations.length ? 'bg-verdant' : 'bg-warn'}`} />
              {verifiedCount}/{extracted.obligations.length} verified verbatim
            </span>
          </div>
          <div className="card-elevated overflow-hidden">
            <div className="stagger divide-y divide-black/[0.05]">
              {extracted.obligations.map((o) => (
                <div key={o.id} className="flex items-start gap-3 px-5 py-3.5 text-xs">
                  <span className={`mt-0.5 font-mono text-[10px] uppercase tracking-wider ${TYPE_COLORS[o.type] ?? 'text-fog'}`}>
                    {o.type.replace(/_/g, ' ')}
                  </span>
                  <span className="flex-1 leading-relaxed text-bone/90">{o.summary}</span>
                  {o.noticeDays != null && (
                    <span className="rounded-full bg-black/[0.05] px-2 py-0.5 font-mono text-[10px] text-fog tabular-nums">{o.noticeDays}d</span>
                  )}
                  <span className={`font-mono text-[10px] ${o.verified ? 'text-verdant' : 'text-warn'}`}>
                    {o.verified ? '✓ verified' : '✗ unverified'}
                  </span>
                </div>
              ))}
            </div>
          </div>
          {onUseMatter && matterId && (
            <div className="mt-5">
              <Button onClick={() => onUseMatter(matterId)}>Ask about this matter →</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
