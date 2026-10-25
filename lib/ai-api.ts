'use client';

// Client for the Khumbha AI local Python runtime (separate from the trading backend).
// The endpoint is read per call so a downloaded copy can use the AI runtime on
// *this* device, and a user can change it without rebuilding the app.
import { getAiEndpoint, getAiToken } from '@/lib/ai-endpoint';
import { dedupeFetch } from '@/lib/shared-request';

function aiKey(resource: string): string {
  return `${resource}:${getAiEndpoint()}`;
}

async function aiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const endpoint = getAiEndpoint();
  const token = getAiToken();
  const res = await fetch(`${endpoint}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Khumbha-AI-Token': token } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${text}`);
  }
  return res.json() as Promise<T>;
}

export const aiHealth = () => aiFetch('/health');

export const aiDashboard = () =>
  dedupeFetch(aiKey('ai:dashboard'), () => aiFetch('/api/dashboard'), { ttlMs: 4000 });

export const aiHardware = () =>
  dedupeFetch(aiKey('ai:hardware'), () => aiFetch('/api/hardware'), { ttlMs: 5000 });

export const aiModels = () =>
  dedupeFetch(aiKey('ai:models'), () => aiFetch('/api/models'), { ttlMs: 4000 });

export const aiDatasets = () =>
  dedupeFetch(aiKey('ai:datasets'), () => aiFetch('/api/datasets'), { ttlMs: 4000 });

export const aiJobs = () =>
  dedupeFetch(aiKey('ai:jobs'), () => aiFetch('/api/jobs'), { ttlMs: 3000 });

export const aiAgents = () =>
  dedupeFetch(aiKey('ai:agents'), () => aiFetch('/api/agents'), { ttlMs: 4000 });

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
