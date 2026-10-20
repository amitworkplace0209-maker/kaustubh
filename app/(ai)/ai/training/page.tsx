'use client';

import { useState } from 'react';
import { Cpu, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, SectionCard, StatusBadge } from '@/components/design-system';
import { useToast } from '@/hooks/use-toast';
import { aiTrain } from '@/lib/ai-api';

function parseNums(raw: string): number[] {
  return raw.split(/[\s,]+/).map((s) => parseFloat(s)).filter((n) => Number.isFinite(n));
}

export default function AiTrainingPage() {
  const { toast } = useToast();
  const [name, setName] = useState('my-model');
  const [xs, setXs] = useState('1 2 3 4 5');
  const [ys, setYs] = useState('3 5 7 9 11');
  const [epochs, setEpochs] = useState(10);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ jobId: string; modelId: string } | null>(null);

  const run = async () => {
    const xa = parseNums(xs);
    const ya = parseNums(ys);
    if (xa.length < 2 || xa.length !== ya.length) {
      toast({ title: 'Provide equal-length numeric xs and ys (>= 2 points)', variant: 'destructive' });
      return;
    }
    setBusy(true);
    try {
      const res = await aiTrain({ name: name || 'model', xs: xa, ys: ya, epochs });
      setResult(res.data);
      toast({ title: 'Training started', description: `Job ${res.data.jobId}` });
    } catch (e: any) {
      toast({ title: 'Error', description: e?.message ?? String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Training" subtitle="Fit a real regression model on your numeric dataset" />
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Configuration" icon={Cpu}>
          <div className="space-y-3">
            <div>
              <Label>Model name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-model" />
            </div>
            <div>
              <Label>X values (space or comma separated)</Label>
              <Input value={xs} onChange={(e) => setXs(e.target.value)} />
            </div>
            <div>
              <Label>Y values (targets, same length)</Label>
              <Input value={ys} onChange={(e) => setYs(e.target.value)} />
            </div>
            <div>
              <Label>Epochs</Label>
              <Input type="number" value={epochs} min={1} onChange={(e) => setEpochs(parseInt(e.target.value || '1', 10))} />
            </div>
            <Button onClick={run} disabled={busy} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cpu className="h-4 w-4" />}
              Train model
            </Button>
          </div>
        </SectionCard>

        <SectionCard title="Result" icon={Cpu}>
          {result ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge status="success" label="Started" />
                <span className="text-muted-foreground">Job {result.jobId}</span>
              </div>
              <p className="text-muted-foreground">Check the Jobs page for progress and fitted weights.</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Run a training job to fit weights on the default model (least-squares regression).
            </p>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
