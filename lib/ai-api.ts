'use client';

// Client for the Khumbha AI local Python runtime (separate from the trading backend).
import { dedupeFetch } from '@/lib/shared-request';

const AI_BASE = process.env.NEXT_PUBLIC_AI_API_BASE || 'http://127.0.0.1:8001';

async function aiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AI_BASE}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${text}`);
  }
  return res.json() as Promise<T>;
}

export const aiHealth = () => aiFetch('/health');

export const aiDashboard = () =>
  dedupeFetch('ai:dashboard', () => aiFetch('/api/dashboard'), { ttlMs: 4000 });

export const aiHardware = () =>
  dedupeFetch('ai:hardware', () => aiFetch('/api/hardware'), { ttlMs: 5000 });

export const aiModels = () =>
  dedupeFetch('ai:models', () => aiFetch('/api/models'), { ttlMs: 4000 });

export const aiDatasets = () =>
  dedupeFetch('ai:datasets', () => aiFetch('/api/datasets'), { ttlMs: 4000 });

export const aiJobs = () =>
  dedupeFetch('ai:jobs', () => aiFetch('/api/jobs'), { ttlMs: 3000 });

export const aiAgents = () =>
  dedupeFetch('ai:agents', () => aiFetch('/api/agents'), { ttlMs: 4000 });

export const aiLogs = () => aiFetch('/api/logs');

export const aiModelStart = (id: string) => aiFetch(`/api/models/${id}/start`, { method: 'POST' });
export const aiModelStop = (id: string) => aiFetch(`/api/models/${id}/stop`, { method: 'POST' });

export const aiAgentStart = (id: string) => aiFetch(`/api/agents/${id}/start`, { method: 'POST' });
export const aiAgentStop = (id: string) => aiFetch(`/api/agents/${id}/stop`, { method: 'POST' });

export const aiTrain = (body: { name: string; xs: number[]; ys: number[]; epochs?: number }) =>
  aiFetch('/api/training/start', { method: 'POST', body: JSON.stringify(body) });

export const aiInfer = (body: { model_id: string; inputs: number[]; dataset?: number[] }) =>
  aiFetch('/api/inference/run', { method: 'POST', body: JSON.stringify(body) });

export const aiSuggest = (body: { series?: number[]; prices?: number[] }) =>
  aiFetch('/api/suggestions', { method: 'POST', body: JSON.stringify(body) });
