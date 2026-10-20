'use client';

import { useState } from 'react';
import { Loader2, Lock, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface AuthGateProps {
  terminal: string;
  onAuthenticated: () => void;
}

export function AuthGate({ terminal, onAuthenticated }: AuthGateProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'pin' | 'password'>('password');
  const [pin, setPin] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/trading-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      if (data.token) {
        onAuthenticated();
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const terminalNames: Record<string, string> = {
    kotak: 'Kotak Neo',
    shoonya: 'Shoonya',
    dummy: 'Dummy Mode',
  };

  return (
    <Card className="border-destructive/30 bg-destructive/[0.03]">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Lock className="h-5 w-5 text-destructive" />
          Broker Login Required
        </CardTitle>
        <CardDescription>
          Connect to <strong>{terminalNames[terminal] || terminal}</strong> to enable trading.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="username" className="text-[11px] font-medium">Username</Label>
            <Input id="username" type="text" value={username} onChange={e => setUsername(e.target.value)} disabled={loading} placeholder="Enter username" className="h-10 text-[13px]" autoComplete="username" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-[11px] font-medium">Password</Label>
            <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} disabled={loading} placeholder="Enter password" className="h-10 text-[13px]" autoComplete="current-password" />
          </div>

          <Button type="submit" className="w-full h-11" disabled={loading || !username || !password}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
          </Button>
        </form>

        <p className="mt-3 text-center text-[10px] text-muted-foreground">
          Credentials are sent directly to the broker. Never stored in the browser.
        </p>
      </CardContent>
    </Card>
  );
}