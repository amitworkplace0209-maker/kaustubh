'use client';

import { Suspense, useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Search, X, ChevronDown, Check } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { getDownloadFormats } from '@/lib/api';
import { getDownloadsState, updateDownloadsState } from '@/lib/downloads-store';

type Format = {
  id: string;
  displayName?: string;
  extension: string;
  available: boolean;
  description: string;
  category?: string;
};

function FormatSelectionContent() {
  const router = useRouter();

  const [formats, setFormats] = useState<Format[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  useEffect(() => {
    setSelected(new Set(getDownloadsState().selectedFormats));
    getDownloadFormats()
      .then((d) => setFormats(d.formats || []))
      .catch(() => {});
  }, []);

  const availableFormats = useMemo(
    () => formats.filter((f) => f.available),
    [formats],
  );

  const filteredFormats = useMemo(() => {
    if (!search) return formats;
    const q = search.toLowerCase();
    return formats.filter(
      (f) =>
        f.id.toLowerCase().includes(q) ||
        (f.displayName && f.displayName.toLowerCase().includes(q)) ||
        f.extension.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q),
    );
  }, [formats, search]);

  const categories = useMemo(() => {
    const grouped: Record<string, Format[]> = {};
    for (const f of filteredFormats) {
      const cat = f.category || 'General';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(f);
    }
    return grouped;
  }, [filteredFormats]);

  const toggleFormat = (id: string) => {
    const fmt = formats.find((f) => f.id === id);
    if (!fmt || !fmt.available) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectAll = () => setSelected(new Set(availableFormats.map((f) => f.id)));
  const clearAll = () => setSelected(new Set());

  const applyAndReturn = () => {
    const arr = Array.from(selected);
    updateDownloadsState({ selectedFormats: arr });
    router.push('/downloads');
  };

  const cancelAndReturn = () => {
    router.push('/downloads');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={cancelAndReturn}
          className="gap-1.5"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Select File Formats</h1>
          <p className="text-sm text-muted-foreground">
            Choose export formats for your tick data
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base font-semibold">File Formats</CardTitle>
          <Badge variant="secondary" className="text-xs">
            {selected.size} selected · {availableFormats.length} available
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search formats..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
            {search && (
              <X
                className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 cursor-pointer text-muted-foreground"
                onClick={() => setSearch('')}
              />
            )}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {selected.size} of {availableFormats.length} formats selected
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={selectAll}>
                Select All
              </Button>
              <Button size="sm" variant="ghost" onClick={clearAll}>
                Clear
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            {Object.entries(categories).map(([cat, catFormats]) => {
              const selectedInCat = catFormats.filter((f) => selected.has(f.id)).length;
              return (
                <details key={cat} className="group" open>
                  <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
                    <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
                    {cat}
                    <span className="text-xs text-muted-foreground">
                      ({selectedInCat}/{catFormats.length})
                    </span>
                  </summary>
                  <div className="ml-6 mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                    {catFormats.map((f) => (
                      <label
                        key={f.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition',
                          !f.available && 'opacity-40 cursor-not-allowed',
                          selected.has(f.id)
                            ? 'border-primary/30 bg-primary/5'
                            : 'hover:bg-muted/40',
                        )}
                        title={
                          f.available
                            ? f.description
                            : `Not available: ${f.description}`
                        }
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(f.id)}
                          disabled={!f.available}
                          onChange={() => toggleFormat(f.id)}
                          className="h-4 w-4 rounded border-border"
                        />
                        {selected.has(f.id) && (
                          <Check className="h-3 w-3 text-primary shrink-0" />
                        )}
                        <span className="flex-1 min-w-0">
                          <span className="font-medium">
                            {f.displayName || f.id}
                          </span>
                          <span className="text-muted-foreground text-xs ml-1">
                            .{f.extension}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>

          {formats.some((f) => !f.available) && (
            <div className="space-y-1 pt-2 border-t">
              <p className="text-xs text-muted-foreground font-medium">
                Unavailable formats
              </p>
              <div className="flex flex-wrap gap-2">
                {formats
                  .filter((f) => !f.available)
                  .map((f) => (
                    <Badge
                      key={f.id}
                      variant="outline"
                      className="text-[10px] opacity-60"
                    >
                      {f.displayName || f.id}: {f.description}
                    </Badge>
                  ))}
              </div>
            </div>
          )}

          <div className="pt-3 border-t flex items-center justify-between">
            <Button
              variant="outline"
              onClick={cancelAndReturn}
            >
              Cancel
            </Button>
            <Button onClick={applyAndReturn} className="gap-2">
              <Check className="h-4 w-4" />
              Apply & Return
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function FormatSelectionPage() {
  return (
    <Suspense>
      <FormatSelectionContent />
    </Suspense>
  );
}
