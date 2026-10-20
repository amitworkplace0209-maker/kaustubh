'use client';

import { useState } from 'react';
import { BookOpen, Lightbulb, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, SectionCard, EmptyState } from '@/components/design-system';
import { useToast } from '@/hooks/use-toast';
import { aiSuggest } from '@/lib/ai-api';

export default function AiSuggestionsPage() {
  const { toast } = useToast();
  const [series, setSeries] = useState('10 12 12 14 13 15');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [note, setNote] = useState('');

  const run = async () => {
    const s = series.split(/[\s,]+/).map((x) => parseFloat(x)).filter((n) => Number.isFinite(n));
    setBusy(true);
    try {
      const res = await aiSuggest({ series: s });
      setSuggestions(res.suggestions ?? []);
      setNote(res.note ?? '');
    } catch (e: any) {
      toast({ title: 'Error', description: e?.message ?? String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Suggestions" subtitle="Statistically derived from the real series you provide — never fabricated" />
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Source series" icon={BookOpen}>
          <div className="space-y-3">
            <div>
              <Label>Numeric series</Label>
              <Input value={series} onChange={(e) => setSeries(e.target.value)} />
            </div>
            <Button onClick={run} disabled={busy} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lightbulb className="h-4 w-4" />}
              Compute suggestions
            </Button>
          </div>
        </SectionCard>
        <SectionCard title="Output" icon={Lightbulb}>
          {suggestions.length === 0 ? (
            <EmptyState icon={Lightbulb} title={note || 'No suggestions yet'} />
          ) : (
            <div className="space-y-2">
              {suggestions.map((s, i) => (
                <div key={i} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-cyan-300">{s.kind}</span>
                  <span>{s.text}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
