'use client';

import { useState, useMemo } from 'react';
import { Settings, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type FieldGroup = {
  name: string;
  fields: [string, string][];
};

type FieldPickerProps = {
  groups: FieldGroup[];
  selectedFields: Set<string>;
  onSelectionChange: (fields: Set<string>) => void;
  mode: 'all' | 'custom';
  onModeChange: (mode: 'all' | 'custom') => void;
};

export default function FieldPicker({
  groups,
  selectedFields,
  onSelectionChange,
  mode,
  onModeChange,
}: FieldPickerProps) {
  const [open, setOpen] = useState(false);
  const [fieldSearch, setFieldSearch] = useState('');

  const allFields = groups.flatMap((g) => g.fields.map(([k]) => k));

  const filteredGroups = useMemo(() => {
    if (!fieldSearch) return groups;
    const q = fieldSearch.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        fields: g.fields.filter(([k, label]) =>
          k.toLowerCase().includes(q) || label.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.fields.length > 0);
  }, [groups, fieldSearch]);

  const toggleField = (key: string) => {
    const next = new Set(selectedFields);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  };

  const selectAll = () => onSelectionChange(new Set(allFields));
  const clearAll = () => onSelectionChange(new Set());

  const selectedLabels = useMemo(() => {
    if (mode !== 'custom') return [];
    const labelMap: Record<string, string> = {};
    for (const g of groups) {
      for (const [k, label] of g.fields) {
        labelMap[k] = label;
      }
    }
    return Array.from(selectedFields).map((k) => labelMap[k] || k);
  }, [selectedFields, mode, groups]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base font-semibold">Data Type & Fields</CardTitle>
        <Badge variant="secondary" className="text-xs">
          {mode === 'all' ? 'All fields' : `${selectedFields.size} / ${allFields.length}`}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(v) => { if (v) onModeChange(v as typeof mode); }}
            className="justify-start"
          >
            <ToggleGroupItem value="custom" className="text-xs">Custom Fields</ToggleGroupItem>
            <ToggleGroupItem value="all" className="text-xs">All Fields</ToggleGroupItem>
          </ToggleGroup>

          {mode === 'custom' && (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs">
                  <Settings className="h-3.5 w-3.5" />
                  Configure
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[420px] max-h-[500px] overflow-y-auto p-4" align="start">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">Field Configuration</span>
                    <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setOpen(false)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  <div className="relative">
                    <Input
                      placeholder="Search fields..."
                      value={fieldSearch}
                      onChange={(e) => setFieldSearch(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {selectedFields.size} of {allFields.length} selected
                    </span>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" className="h-6 text-xs" onClick={selectAll}>Select All</Button>
                      <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={clearAll}>Clear</Button>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {filteredGroups.map((group) => (
                      <div key={group.name} className="space-y-1.5">
                        <p className="text-xs font-semibold uppercase tracking-wide text-primary">{group.name}</p>
                        <div className="grid grid-cols-2 gap-1">
                          {group.fields.map(([key, label]) => (
                            <label
                              key={key}
                              className={cn(
                                'flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-xs transition',
                                selectedFields.has(key) ? 'border-primary/30 bg-primary/5' : 'hover:bg-muted/40',
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={selectedFields.has(key)}
                                onChange={() => toggleField(key)}
                                className="h-3.5 w-3.5 rounded border-border"
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {mode === 'custom' && selectedLabels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {selectedLabels.map((label) => (
              <Badge key={label} variant="secondary" className="text-xs">{label}</Badge>
            ))}
          </div>
        )}

        {mode === 'custom' && selectedLabels.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Click Configure to select fields for export.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
