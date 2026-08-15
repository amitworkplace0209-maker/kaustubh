'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Download, FileText, FileJson, FileSpreadsheet, FileCode, FileArchive,
  Loader2, CheckCircle2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { getDownloadUrl, getStocks } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

type Stock = { symbol: string; active: boolean };

type FormatOption = {
  value: string;
  label: string;
  icon: React.ElementType;
  desc: string;
  available: boolean;
};

const FORMATS: FormatOption[] = [
  { value: 'csv', label: 'CSV', icon: FileText, desc: 'Comma-separated values', available: true },
  { value: 'json', label: 'JSON', icon: FileJson, desc: 'Structured JSON array', available: true },
  { value: 'jsonl', label: 'JSONL', icon: FileCode, desc: 'JSON Lines (one per line)', available: true },
  { value: 'ndjson', label: 'NDJSON', icon: FileCode, desc: 'Newline-delimited JSON', available: true },
  { value: 'txt', label: 'TXT', icon: FileText, desc: 'Tab-separated text', available: true },
  { value: 'xlsx', label: 'Excel', icon: FileSpreadsheet, desc: 'Excel spreadsheet (.xls)', available: true },
  { value: 'parquet', label: 'Parquet', icon: FileArchive, desc: 'Columnar format (falls back to CSV)', available: true },
  { value: 'zip', label: 'ZIP', icon: FileArchive, desc: 'Compressed archive (falls back to CSV)', available: true },
];
const FIELD_GROUPS = [
  {
    name: 'Identity',
    fields: [
      ['symbol', 'Symbol'],
      ['instrumentToken', 'Instrument Token'],
      ['exchangeSegment', 'Exchange Segment'],
    ],
  },
  {
    name: 'Price & OHLC',
    fields: [
      ['ltp', 'LTP'],
      ['open', 'Open'],
      ['high', 'High'],
      ['low', 'Low'],
      ['close', 'Close'],
      ['averagePrice', 'Average Price'],
      ['change', 'Change'],
      ['changePercent', 'Change %'],
    ],
  },
  {
    name: 'Volume & Trades',
    fields: [
      ['volume', 'Volume'],
      ['ltq', 'Last Traded Quantity'],
      ['tbq', 'Total Buy Quantity'],
      ['tsq', 'Total Sell Quantity'],
    ],
  },
  {
    name: 'Market Depth',
    fields: [
      ['bp', 'Best Bid Price'],
      ['sp', 'Best Ask Price'],
      ['bq', 'Best Bid Quantity'],
      ['bs', 'Best Ask Quantity'],
    ],
  },
  {
    name: 'Time',
    fields: [
      ['ts', 'Tick Time'],
      ['receivedAt', 'Received At'],
    ],
  },
] as const;

export default function DownloadsPage() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [selectedStocks, setSelectedStocks] = useState<Set<string>>(new Set());
  const [allStocks, setAllStocks] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [format, setFormat] = useState('csv');
  const [downloading, setDownloading] = useState(false);
  const { toast } = useToast();
  const [stockSearch, setStockSearch] = useState('');
  const [downloadMode, setDownloadMode] = useState<'basic' | 'details'>('basic');
  const [showFieldSettings, setShowFieldSettings] = useState(false);
const [selectedFields, setSelectedFields] = useState<Set<string>>(
  new Set([
    'symbol',
    'instrumentToken',
    'ltp',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'ltq',
    'tbq',
    'tsq',
    'bp',
    'sp',
    'bq',
    'bs',
    'ts',
    'receivedAt',
  ])
);

  const fetchStocks = useCallback(async () => {
    try {
      const data = await getStocks();
     setStocks(data.data || []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchStocks();
  }, [fetchStocks]);
  const visibleStocks = stocks.filter((stock) =>
  stock.symbol.toLowerCase().includes(stockSearch.toLowerCase())
);

const selectAllVisible = () => {
  setSelectedStocks((prev) => {
    const next = new Set(prev);

    visibleStocks.forEach((stock) => {
      if (stock.active) {
        next.add(stock.symbol);
      }
    });

    return next;
  });
};

const clearAllStocks = () => {
  setSelectedStocks(new Set());
};
const toggleField = (field: string) => {
  setSelectedFields((prev) => {
    const next = new Set(prev);

    if (next.has(field)) {
      next.delete(field);
    } else {
      next.add(field);
    }

    return next;
  });
};

const selectAllFields = () => {
  const fields = FIELD_GROUPS.flatMap((group) =>
    group.fields.map(([key]) => key)
  );

  setSelectedFields(new Set(fields));
};

const clearAllFields = () => {
  setSelectedFields(new Set());
};

  const toggleStock = (symbol: string) => {
    setSelectedStocks((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const params: Record<string, string> = { format };
            if (downloadMode === 'details') {
        if (selectedFields.size === 0) {
          toast({
            title: 'Select fields',
            description: 'Choose at least one field for Details download.',
            variant: 'destructive',
          });
          setDownloading(false);
          return;
        }

        params.fields = Array.from(selectedFields).join(',');
      }
      if (allStocks) {
        params.all = 'true';
      } else if (selectedStocks.size > 0) {
        params.symbols = Array.from(selectedStocks).join(',');
      } else {
        toast({ title: 'Select stocks', description: 'Choose stocks or enable "All Stocks"', variant: 'destructive' });
        setDownloading(false);
        return;
      }
      if (startDate) params.start = new Date(startDate).toISOString();
      if (endDate) params.end = new Date(endDate).toISOString();

      const url = getDownloadUrl(params);
      window.open(url, '_blank');
      const fmt = FORMATS.find((f) => f.value === format);
      toast({
        title: 'Download started',
        description: `Generating ${fmt?.label || format.toUpperCase()} file...`,
      });
    } catch (err) {
      toast({
        title: 'Download failed',
        description: err instanceof Error ? err.message : 'Error',
        variant: 'destructive',
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Download Center</h1>
        <p className="text-sm text-muted-foreground">
          Export tick data from MongoDB — supports CSV, JSON, JSONL, NDJSON, TXT, Excel, Parquet, and ZIP
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Stock Selection */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stock Selection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <Switch checked={allStocks} onCheckedChange={setAllStocks} />
              <Label>All Active Stocks</Label>
            </div>
            {!allStocks && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
  <Label>
    Select Stocks ({selectedStocks.size} selected)
  </Label>

  <div className="flex gap-2">
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={selectAllVisible}
    >
      Select All
    </Button>

    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={clearAllStocks}
    >
      Clear All
    </Button>
  </div>
</div>
<Input
  placeholder="Search stock..."
  value={stockSearch}
  onChange={(e) => setStockSearch(e.target.value)}
/>
                <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
                  {stocks.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No stocks available</p>
                  ) : (
                    visibleStocks.map((stock) => (
                      <div key={stock.symbol} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border"
                          checked={selectedStocks.has(stock.symbol)}
                          onChange={() => toggleStock(stock.symbol)}
                        />
                        <span className="text-sm">{stock.symbol}</span>
                        {!stock.active && <span className="text-xs text-muted-foreground">(disabled)</span>}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      

      

      {/* Data Type & Fields */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              Data Type & Fields
            </CardTitle>

            <Badge variant="secondary">
              {downloadMode === 'basic'
                ? 'Basic'
                : `${selectedFields.size} fields`}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">

          {/* Download Mode */}
          <div className="grid grid-cols-2 gap-3">

            <button
              type="button"
              onClick={() => setDownloadMode('basic')}
              className={`rounded-lg border p-4 text-left transition ${
                downloadMode === 'basic'
                  ? 'border-primary bg-primary/10'
                  : 'border-border'
              }`}
            >
              <div className="font-medium">
                All Fields
              </div>

              <p className="mt-1 text-xs text-muted-foreground">
               Download all available fields from the selected stock.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setDownloadMode('details')}
              className={`rounded-lg border p-4 text-left transition ${
                downloadMode === 'details'
                  ? 'border-primary bg-primary/10'
                  : 'border-border'
              }`}
            >
              <div className="font-medium">
                Details 
              </div>

              <p className="mt-1 text-xs text-muted-foreground">
               Choose exactly which fields you want to download.
              </p>
            </button>

          </div>

          {/* Details Mode */}
          {downloadMode === 'details' && (
            <div className="space-y-4">

              <div className="flex items-center justify-between">
  <Label>
    Download Fields
  </Label>

  <div className="flex items-center gap-2">
    <Badge variant="secondary">
      {selectedFields.size} selected
    </Badge>

    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => setShowFieldSettings((prev) => !prev)}
    >
      {showFieldSettings ? 'Hide Settings' : 'Settings'}
    </Button>
  </div>
</div>

          {showFieldSettings && (
  <div className="rounded-lg border border-border p-4 space-y-4">

    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium">Field Settings</p>
        <p className="text-xs text-muted-foreground">
          Select only the fields you want in the downloaded file.
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={selectAllFields}
        >
          Select All
        </Button>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={clearAllFields}
        >
          Clear All
        </Button>
      </div>
    </div>

    <div className="space-y-4">
      {FIELD_GROUPS.map((group) => (
        <div key={group.name} className="space-y-2">

          <p className="text-xs font-semibold uppercase tracking-wide text-primary">
            {group.name}
          </p>

          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {group.fields.map(([key, label]) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 rounded-md border p-2 hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  checked={selectedFields.has(key)}
                  onChange={() => toggleField(key)}
                  className="h-4 w-4"
                />

                <span className="text-xs">
                  {label}
                </span>
              </label>
            ))}
          </div>

        </div>
      ))}
    </div>

  </div>
)}    

            </div>
          )}

          {/* Basic Mode */}
          {downloadMode === 'basic' && (
            <div className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium">
                Basic Download
              </p>

              <p className="mt-1 text-xs text-muted-foreground">
                Symbol, token, LTP, OHLC, volume, market depth
                and timestamps will be included automatically.
              </p>
            </div>
          )}

        </CardContent>
      </Card> 

            {/* Filters & Format */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Filters & Format
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Start Date/Time</Label>
              <Input
                type="datetime-local"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>End Date/Time</Label>
              <Input
                type="datetime-local"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Format</Label>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {FORMATS.map((f) => {
                const Icon = f.icon;
                const active = format === f.value;

                return (
                  <Button
                    key={f.value}
                    variant={active ? 'default' : 'outline'}
                    size="sm"
                    className="flex flex-col items-center gap-1 h-auto py-3"
                    onClick={() => setFormat(f.value)}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="text-xs font-medium">
                      {f.label}
                    </span>
                  </Button>
                );
              })}
            </div>

            {(() => {
              const f = FORMATS.find((x) => x.value === format);

              return f ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3 text-success" />
                  {f.desc}
                </p>
              ) : null;
            })()}
          </div>

          <Button
            className="w-full"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}

            {downloading ? 'Generating...' : 'Download'}
          </Button>
        </CardContent>
      </Card>
      </div>

      {/* Format info cards */}
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        {FORMATS.map((f) => {
          const Icon = f.icon;
          return (
            <Card key={f.value} className="p-3">
              <div className="flex items-start gap-2">
                <Icon className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{f.label}</span>
                    <Badge variant="secondary" className="text-[10px]">.{f.value === 'xlsx' ? 'xls' : f.value}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{f.desc}</p>
                </div>
              </div>
            </Card>

          );
        })}
      </div>
    </div>
  );
}
