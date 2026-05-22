import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type GeoPoint = {
  id: string;
  lat: number;
  lng: number;
  name?: string;
  color: string; // CSS color, from _umap_options.color or default
};

export type GeoFile = {
  id: string;
  name: string;
  points: GeoPoint[];
};

type GeoDataContextType = {
  files: GeoFile[];
  addFile: (file: GeoFile) => void;
  removeFile: (id: string) => void;
  selectedIds: Set<string>;
  togglePoint: (pointId: string) => void;
  setFileSelection: (fileId: string, selected: boolean) => void;
  visiblePoints: GeoPoint[];
  allPoints: GeoPoint[];
};

const GeoDataContext = createContext<GeoDataContextType | null>(null);

export function GeoDataProvider({ children }: { children: ReactNode }) {
  const [files, setFiles] = useState<GeoFile[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  function addFile(file: GeoFile) {
    setFiles((prev) => [...prev, file]);
    // Auto-select all points of the new file
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const p of file.points) next.add(p.id);
      return next;
    });
  }

  function removeFile(id: string) {
    const file = files.find((f) => f.id === id);
    setFiles((prev) => prev.filter((f) => f.id !== id));
    if (file) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const p of file.points) next.delete(p.id);
        return next;
      });
    }
  }

  function togglePoint(pointId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(pointId)) next.delete(pointId);
      else next.add(pointId);
      return next;
    });
  }

  function setFileSelection(fileId: string, selected: boolean) {
    const file = files.find((f) => f.id === fileId);
    if (!file) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const p of file.points) {
        if (selected) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  }

  const allPoints = useMemo(() => files.flatMap((f) => f.points), [files]);

  const visiblePoints = useMemo(
    () => allPoints.filter((p) => selectedIds.has(p.id)),
    [allPoints, selectedIds],
  );

  return (
    <GeoDataContext.Provider
      value={{ files, addFile, removeFile, selectedIds, togglePoint, setFileSelection, visiblePoints, allPoints }}
    >
      {children}
    </GeoDataContext.Provider>
  );
}

export function useGeoData() {
  const ctx = useContext(GeoDataContext);
  if (!ctx) throw new Error('useGeoData must be used within GeoDataProvider');
  return ctx;
}
