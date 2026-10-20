const FORMATS_KEY = 'dc_formats';
const STATE_KEY = 'dc_download_state';

export type DownloadStateData = {
  selectedFormats: string[];
  selectedStocks: string[];
  stockMode: string;
  selectedFields: string[];
  fieldMode: string;
  startDate: string;
  endDate: string;
  datePreset: string;
};

const DEFAULTS: DownloadStateData = {
  selectedFormats: [],
  selectedStocks: [],
  stockMode: 'custom',
  selectedFields: [],
  fieldMode: 'custom',
  startDate: '',
  endDate: '',
  datePreset: 'custom',
};

export function getSelectedFormats(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(sessionStorage.getItem(FORMATS_KEY) || '[]');
  } catch {
    return [];
  }
}

export function setSelectedFormats(formats: string[]): void {
  if (typeof window === 'undefined') return;
  if (formats.length === 0) {
    sessionStorage.removeItem(FORMATS_KEY);
  } else {
    sessionStorage.setItem(FORMATS_KEY, JSON.stringify(formats));
  }
}

export function loadDownloadState(): DownloadStateData {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveDownloadState(state: Partial<DownloadStateData>): void {
  if (typeof window === 'undefined') return;
  const current = loadDownloadState();
  const merged = { ...current, ...state };
  sessionStorage.setItem(STATE_KEY, JSON.stringify(merged));
}
