import * as FileSystem from 'expo-file-system/legacy';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────────

export type SavedMapSource = 'loaded' | 'downloaded';

export type SavedMap = {
  id: string;
  name: string;
  source: SavedMapSource;
  /** file:// URI (internal) or content:// URI (SAF / Android Downloads) */
  filePath: string;
  fileSize: number; // bytes
  bbox?: { west: number; south: number; east: number; north: number };
  createdAt: number; // epoch ms
};

/** Returns true if the filePath is a SAF content:// URI (Android Downloads) */
export function isSafUri(filePath: string): boolean {
  return filePath.startsWith('content://');
}

/** Returns saved maps whose bbox contains the given coordinates. */
export function findMapsForLocation(
  maps: SavedMap[],
  lat: number,
  lng: number,
): SavedMap[] {
  return maps.filter((m) => {
    if (!m.bbox) return false;
    const { west, south, east, north } = m.bbox;
    return lat >= south && lat <= north && lng >= west && lng <= east;
  });
}

type SavedMapsCatalog = {
  version: 1;
  maps: SavedMap[];
};

type SavedMapsContextType = {
  maps: SavedMap[];
  isLoading: boolean;
  addLoadedMap: (pickedUri: string, originalName: string) => Promise<SavedMap>;
  addDownloadedMap: (entry: SavedMap) => Promise<void>;
  removeMap: (id: string) => Promise<void>;
};

// ── Internal storage (catalog + manually loaded files) ──────────────────────────

const INTERNAL_MAPS_DIR = `${FileSystem.documentDirectory}maps/`;
const CATALOG_PATH = `${INTERNAL_MAPS_DIR}catalog.json`;

async function ensureInternalDir() {
  const info = await FileSystem.getInfoAsync(INTERNAL_MAPS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(INTERNAL_MAPS_DIR, { intermediates: true });
  }
}

async function loadCatalog(): Promise<SavedMapsCatalog> {
  try {
    const info = await FileSystem.getInfoAsync(CATALOG_PATH);
    if (!info.exists) return { version: 1, maps: [] };
    const text = await FileSystem.readAsStringAsync(CATALOG_PATH);
    return JSON.parse(text) as SavedMapsCatalog;
  } catch {
    return { version: 1, maps: [] };
  }
}

async function saveCatalog(catalog: SavedMapsCatalog): Promise<void> {
  await FileSystem.writeAsStringAsync(CATALOG_PATH, JSON.stringify(catalog));
}

// ── Context ──────────────────────────────────────────────────────────────────────

const SavedMapsContext = createContext<SavedMapsContextType | null>(null);

export function SavedMapsProvider({ children }: { children: ReactNode }) {
  const [maps, setMaps] = useState<SavedMap[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      await ensureInternalDir();
      const catalog = await loadCatalog();
      setMaps(catalog.maps);
      setIsLoading(false);
    })();
  }, []);

  /** Copies a user-picked file into internal storage (DocumentPicker result) */
  async function addLoadedMap(pickedUri: string, originalName: string): Promise<SavedMap> {
    await ensureInternalDir();
    const id = `map-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ext = originalName.toLowerCase().endsWith('.osm') ? 'osm' : 'geojson';
    const destPath = `${INTERNAL_MAPS_DIR}${id}.${ext}`;

    await FileSystem.copyAsync({ from: pickedUri, to: destPath });

    const info = await FileSystem.getInfoAsync(destPath);
    const fileSize = info.exists && 'size' in info ? (info.size ?? 0) : 0;

    const entry: SavedMap = {
      id,
      name: originalName,
      source: 'loaded',
      filePath: destPath,
      fileSize,
      createdAt: Date.now(),
    };

    const catalog = await loadCatalog();
    catalog.maps.unshift(entry);
    await saveCatalog(catalog);
    setMaps(catalog.maps);
    return entry;
  }

  /** Adds a map entry that was already written to disk by the caller */
  async function addDownloadedMap(entry: SavedMap): Promise<void> {
    const catalog = await loadCatalog();
    catalog.maps.unshift(entry);
    await saveCatalog(catalog);
    setMaps(catalog.maps);
  }

  async function removeMap(id: string): Promise<void> {
    const catalog = await loadCatalog();
    const entry = catalog.maps.find((m) => m.id === id);

    if (entry) {
      try {
        if (isSafUri(entry.filePath)) {
          // SAF content:// URI — use the SAF-aware delete
          await FileSystem.StorageAccessFramework.deleteAsync(entry.filePath, { idempotent: true });
        } else {
          const info = await FileSystem.getInfoAsync(entry.filePath);
          if (info.exists) {
            await FileSystem.deleteAsync(entry.filePath, { idempotent: true });
          }
        }
      } catch { /* ignore — file may have been deleted externally */ }
    }

    catalog.maps = catalog.maps.filter((m) => m.id !== id);
    await saveCatalog(catalog);
    setMaps(catalog.maps);
  }

  return (
    <SavedMapsContext.Provider value={{ maps, isLoading, addLoadedMap, addDownloadedMap, removeMap }}>
      {children}
    </SavedMapsContext.Provider>
  );
}

export function useSavedMaps(): SavedMapsContextType {
  const ctx = useContext(SavedMapsContext);
  if (!ctx) throw new Error('useSavedMaps must be used within a SavedMapsProvider');
  return ctx;
}
