const STORAGE_KEY = 'dc_selected_formats';

export function getSelectedFormats(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

export function setSelectedFormats(formats: string[]): void {
  if (typeof window === 'undefined') return;
  if (formats.length === 0) {
    sessionStorage.removeItem(STORAGE_KEY);
  } else {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(formats));
  }
}
