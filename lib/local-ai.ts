'use client';

/**
 * Client for the Khumbha AI *local* bridge (`khumbha-ai/`).
 *
 * The bridge is a loopback FastAPI service that talks to model runtimes on the
 * user's device:
 *   - Ollama            http://127.0.0.1:11434
 *   - LM Studio         http://127.0.0.1:1234/v1
 *   - llama.cpp server  http://127.0.0.1:8080/v1
 *   - any OpenAI-compatible endpoint
 *
 * It is separate from the VM-hosted trading backend on purpose: market data and
 * persistence stay on the VM, inference stays on the device. This module never
 * sends bridge configuration to any other origin.
 */

import { getAiEndpoint, getAiToken } from '@/lib/ai-endpoint';

export type LocalAiKind = 'ollama' | 'openai';

export interface LocalAiModel {
  id: string;
  name: string;
  sizeBytes?: number | null;
  family?: string | null;
  parameterSize?: string | null;
  quantization?: string | null;
  modifiedAt?: string | number | null;
  provider?: string;
  providerLabel?: string;
}

export interface LocalAiProvider {
  id: string;
  label: string;
  kind: LocalAiKind;
  baseUrl: string;
  enabled: boolean;
  model: string;
  reachable: boolean;
  error: string | null;
  models: LocalAiModel[];
  checkedAt: string | null;
  cached: boolean;
}

export interface LocalAiDefaults {
  provider: string;
  model: string;
  temperature: number;
  max_tokens: number;
}

export interface LocalAiSnapshot {
  bridge: boolean;
  version: string;
  providers: LocalAiProvider[];
  defaults: LocalAiDefaults;
  generatedAt: string;
}

export interface LocalAiHealth {
  status: string;
  service: string;
  bridgeVersion: string;
  uptimeSec: number;
  localAi: {
    bridge: boolean;
    version: string;
    providers: number;
    providersEnabled: number;
    providersReachable: number;
    defaultProvider: string;
    defaultModel: string;
  };
}

export interface LocalAiAnalysis {
  content: string;
  provider: string;
  providerLabel: string;
  model: string;
  kind: string;
  groundedFields: string[];
  contextChars: number;
  latencyMs: number;
  usage?: Record<string, unknown>;
  createdAt: string;
  disclaimer: string;
}

export interface LocalAiChatResult {
  content: string;
  provider: string;
  providerLabel: string;
  model: string;
  latencyMs: number;
  usage?: Record<string, unknown>;
  createdAt: string;
}

type FetchOptions = RequestInit & { timeoutMs?: number };

function timeoutMessage(ms: number): string {
  return `Local AI bridge did not answer within ${Math.round(ms / 1000)}s. A local model may still be loading — check the bridge window and try again.`;
}

/**
 * One fetch helper for every bridge call. Turns the two failure modes that
 * matter into actionable text: bridge absent, and bridge alive but slow.
 */
async function bridgeFetch<T>(path: string, init: FetchOptions = {}): Promise<T> {
  const endpoint = getAiEndpoint();
  const timeoutMs = init.timeoutMs ?? 12_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = getAiToken();
  const { timeoutMs: _timeoutMs, headers, ...rest } = init;

  try {
    const res = await fetch(`${endpoint}${path}`, {
      ...rest,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Khumbha-AI-Token': token } : {}),
        ...(headers || {}),
      },
    });

    const text = await res.text().catch(() => '');
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }

    if (!res.ok) {
      const detail =
        (body as any)?.detail ||
        (body as any)?.error ||
        text.slice(0, 300) ||
        res.statusText ||
        'request failed';
      throw new Error(`${res.status} — ${detail}`);
    }
    return body as T;
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error(timeoutMessage(timeoutMs));
    if (err instanceof TypeError) {
      throw new Error(
        `Local AI bridge not reachable at ${endpoint}. Start it with khumbha-ai/run_ai.cmd on this device, then retry.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const localAiHealth = () =>
  bridgeFetch<LocalAiHealth>('/health', { timeoutMs: 4_000 });

export const localAiStatus = () =>
  bridgeFetch<LocalAiSnapshot & { summary: LocalAiHealth['localAi']; uptimeSec: number }>(
    '/api/ai/status',
    { timeoutMs: 6_000 },
  );

export const localAiProviders = () =>
  bridgeFetch<LocalAiSnapshot>('/api/providers', { timeoutMs: 18_000 });

/** Last-known provider state — never touches a model server. */
export const localAiProvidersCached = () =>
  bridgeFetch<LocalAiSnapshot>('/api/providers?probe=false', { timeoutMs: 6_000 });

export const localAiProbe = (providerId: string) =>
  bridgeFetch<any>(`/api/providers/${encodeURIComponent(providerId)}/probe`, {
    method: 'POST',
    timeoutMs: 18_000,
  });

export const localAiSaveProvider = (
  providerId: string,
  body: { baseUrl?: string; kind?: LocalAiKind; label?: string; enabled?: boolean; model?: string },
) =>
  bridgeFetch<{ ok: boolean; provider: LocalAiProvider }>(
    `/api/providers/${encodeURIComponent(providerId)}`,
    { method: 'PUT', body: JSON.stringify(body), timeoutMs: 18_000 },
  );

export const localAiSaveDefaults = (body: {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}) =>
  bridgeFetch<{ ok: boolean; defaults: LocalAiDefaults }>('/api/ai/defaults', {
    method: 'PUT',
    body: JSON.stringify(body),
    timeoutMs: 10_000,
  });

export const localAiModels = () =>
  bridgeFetch<{ models: LocalAiModel[]; generatedAt: string }>('/api/ai/models', {
    timeoutMs: 20_000,
  });

export const localAiChat = (body: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutSec?: number;
}) =>
  bridgeFetch<{ data: LocalAiChatResult }>('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 185_000,
  });

export const localAiAnalyze = (body: {
  kind: 'market_watch_symbol' | 'market_watch_board' | 'suggestion_series' | 'suggestion_row' | 'generic';
  context: Record<string, unknown>;
  question?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}) =>
  bridgeFetch<{ data: LocalAiAnalysis }>('/api/ai/analyze', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 185_000,
  });

/** Format a model size the same way across provider cards. */
export function formatModelSize(bytes?: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${Math.round(mb)} MB`;
}

/** One-line label: provider · model, or an honest empty string. */
export function defaultModelLabel(snapshot: LocalAiSnapshot | null): string {
  if (!snapshot) return '';
  const providerId = snapshot.defaults?.provider;
  const provider = snapshot.providers.find((p) => p.id === providerId);
  const model = snapshot.defaults?.model || provider?.model || '';
  if (!provider) return model;
  return model ? `${provider.label} · ${model}` : provider.label;
}
