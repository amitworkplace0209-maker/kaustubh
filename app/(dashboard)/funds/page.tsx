'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Wallet, TrendingUp, TrendingDown, Plus, Minus, RefreshCw, IndianRupee, Coins } from 'lucide-react';
import { getFunds, getSystemStatus, updateSetting } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

export default function AccountPage() {
  const [funds, setFunds] = useState<any>(null);
  const [system, setSystem] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [coinAmount, setCoinAmount] = useState('');
  const [dummyBalance, setDummyBalance] = useState(100000);
  const [dummyUsed, setDummyUsed] = useState(0);
  const { toast } = useToast();

  const fetch = useCallback(async () => {
    try {
      const [fundsRes, sysRes] = await Promise.allSettled([getFunds(), getSystemStatus()]);
      if (fundsRes.status === 'fulfilled') setFunds(fundsRes.value);
      if (sysRes.status === 'fulfilled') setSystem(sysRes.value);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, [fetch]);

  const isApiMode = system?.pythonStatus?.logged_in ?? false;

  const apiTotal = funds?.data?.limitObject?.RMS?.fund_limit ?? funds?.data?.margin ?? funds?.fund_limit ?? 0;
  const apiUsed = funds?.data?.limitObject?.RMS?.utilised_debit ?? funds?.data?.utilised_debit ?? funds?.utilised_debit ?? 0;
  const apiAvailable = funds?.data?.limitObject?.RMS?.available_margin ?? funds?.data?.available_margin ?? funds?.available_margin ?? (apiTotal - apiUsed);

  const handleAddCoin = () => {
    const amt = parseFloat(coinAmount);
    if (isNaN(amt) || amt <= 0) return;
    setDummyBalance((b) => b + amt);
    setCoinAmount('');
    toast({ title: 'Coins added', description: `₹${amt.toLocaleString('en-US')} added to dummy balance` });
  };

  const handleWithdrawCoin = () => {
    const amt = parseFloat(coinAmount);
    if (isNaN(amt) || amt <= 0) return;
    if (amt > dummyBalance - dummyUsed) {
      toast({ title: 'Insufficient balance', variant: 'destructive' });
      return;
    }
    setDummyBalance((b) => b - amt);
    setCoinAmount('');
    toast({ title: 'Coins withdrawn', description: `₹${amt.toLocaleString('en-US')} withdrawn` });
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full"><RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Account</h1>
          <p className="text-sm text-muted-foreground">Manage your trading balance</p>
        </div>
        <Button size="sm" variant="ghost" onClick={fetch}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      <Tabs defaultValue={isApiMode ? 'api' : 'dummy'}>
        <TabsList>
          <TabsTrigger value="dummy" className="gap-2"><Coins className="h-4 w-4" /> Dummy Mode</TabsTrigger>
          <TabsTrigger value="api" className="gap-2"><Wallet className="h-4 w-4" /> API Mode</TabsTrigger>
        </TabsList>

        {/* Dummy Mode */}
        <TabsContent value="dummy" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="card-accent-green">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total Balance</CardTitle>
                <Wallet className="h-4 w-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">₹{dummyBalance.toLocaleString('en-US')}</div>
              </CardContent>
            </Card>
            <Card className="card-accent-orange">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Used Balance</CardTitle>
                <TrendingDown className="h-4 w-4 text-orange-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">₹{dummyUsed.toLocaleString('en-US')}</div>
              </CardContent>
            </Card>
            <Card className="card-accent-teal">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Available Balance</CardTitle>
                <TrendingUp className="h-4 w-4 text-teal-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">₹{(dummyBalance - dummyUsed).toLocaleString('en-US')}</div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Manage Coins</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Amount (₹)</Label>
                <Input type="number" placeholder="Enter amount" value={coinAmount} onChange={(e) => setCoinAmount(e.target.value)} />
              </div>
              <div className="flex gap-3">
                <Button className="flex-1 bg-success hover:bg-success/90 text-success-foreground" onClick={handleAddCoin}>
                  <Plus className="h-4 w-4 mr-2" /> Add Coin
                </Button>
                <Button className="flex-1" variant="outline" onClick={handleWithdrawCoin}>
                  <Minus className="h-4 w-4 mr-2" /> Withdraw Coin
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* API Mode */}
        <TabsContent value="api" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="card-accent-green">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total Balance</CardTitle>
                <IndianRupee className="h-4 w-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">₹{Number(apiTotal).toLocaleString('en-US')}</div>
              </CardContent>
            </Card>
            <Card className="card-accent-orange">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Used Balance</CardTitle>
                <TrendingDown className="h-4 w-4 text-orange-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">₹{Number(apiUsed).toLocaleString('en-US')}</div>
              </CardContent>
            </Card>
            <Card className="card-accent-teal">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Available Balance</CardTitle>
                <TrendingUp className="h-4 w-4 text-teal-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">₹{Number(apiAvailable).toLocaleString('en-US')}</div>
              </CardContent>
            </Card>
          </div>
          {!isApiMode && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                <p className="text-sm">API mode requires an active Kotak login. Switch to Dummy mode to practice.</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
