'use client';

import { useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, SectionCard } from '@/components/design-system';
import { useToast } from '@/hooks/use-toast';
import { aiInfer } from '@/lib/ai-api';

function parseNums(raw: string): number[] {
  return raw.split(/[\s,]+/).map((s) => parseFloat(s)).filter((n) => Number.isFinite(n));
}

export default function AiInferencePage() {
  const { toast } = useToast();
  const [modelId, setModelId] = useState('reg-default');
  const [inputs, setInputs] = useState('6 7 8');
  const [dataset, setDataset] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<{ jobId: string; outputs: number[]; latencyMs: number } | null>(null);

  const run = async () => {
    const inp = parseNums(inputs);
    if (inp.length === 0) {
      toast({ title: 'Provide at least one numeric input', variant: 'destructive' });
      return;
    }
    const ds = parseNums(dataset);
    setBusy(true);
    try {
      const res = await aiInfer({ model_id: modelId, inputs: inp, dataset: ds.length >= 2 ? ds : undefined });
      setOutput(res.data);
      toast({ title: `Inference done in ${res.data.latencyMs}ms` });
    } catch (e: any) {
      toast({ title: 'Error', description: e?.message ?? String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Inference" subtitle="Run the trained model on new inputs (real computation)" />
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Request" icon={Sparkles}>
          <div className="space-y-3">
            <div>
              <Label>Model</Label>
              <Input value={modelId} onChange={(e) => setModelId(e.target.value)} />
            </div>
            <div>
              <Label>Input values</Label>
              <Input value={inputs} onChange={(e) => setInputs(e.target.value)} />
            </div>
            <div>
              <Label>Dataset (optional, if model not yet trained)</Label>
              <Input value={dataset} onChange={(e) => setDataset(e.target.value)} placeholder="e.g. 10 12 14 16" />
            </div>
            <Button onClick={run} disabled={busy} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Run inference
            </Button>
          </div>
        </SectionCard>

        <SectionCard title="Output" icon={Sparkles}>
          {output ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">Job {output.jobId} · {output.latencyMs}ms</p>
              <div className="flex flex-wrap gap-2">
                {output.outputs.map((v, i) => (
                  <span key={i} className="rounded-lg bg-cyan-500/10 px-3 py-1.5 text-sm font-semibold tabular-nums text-cyan-300 ring-1 ring-cyan-500/30">
                    {v.toFixed(4)}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Predictions appear here after running.</p>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
