import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useGeoData, type GeoFile, type GeoPoint } from '@/context/geo-data-context';

const DEFAULT_COLOR = '#4A90E2';

// ─── GeoJSON parser ───────────────────────────────────────────────────────────
function extractPoints(geojson: any, fileName: string): GeoFile {
  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const points: GeoPoint[] = [];

  function colorFrom(props: any): string {
    return props?._umap_options?.color ?? DEFAULT_COLOR;
  }

  function processGeom(geometry: any, props: any, idx: number) {
    if (!geometry) return;
    if (geometry.type === 'Point') {
      const [lng, lat] = geometry.coordinates as number[];
      points.push({
        id: `${fileId}-${idx}`,
        lat,
        lng,
        name: props?.name ?? props?.nombre ?? undefined,
        color: colorFrom(props),
      });
    } else if (geometry.type === 'MultiPoint') {
      (geometry.coordinates as number[][]).forEach(([lng, lat], i) => {
        points.push({
          id: `${fileId}-${idx}-${i}`,
          lat,
          lng,
          name: props?.name ?? undefined,
          color: colorFrom(props),
        });
      });
    }
  }

  if (geojson.type === 'FeatureCollection') {
    geojson.features.forEach((f: any, i: number) => processGeom(f.geometry, f.properties, i));
  } else if (geojson.type === 'Feature') {
    processGeom(geojson.geometry, geojson.properties, 0);
  } else if (geojson.type === 'Point') {
    const [lng, lat] = geojson.coordinates as number[];
    points.push({ id: `${fileId}-0`, lat, lng, color: DEFAULT_COLOR });
  }

  return { id: fileId, name: fileName, points };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
type SelectionState = 'all' | 'none' | 'partial';

function fileSelectionState(file: GeoFile, selectedIds: Set<string>): SelectionState {
  const count = file.points.filter((p) => selectedIds.has(p.id)).length;
  if (count === 0) return 'none';
  if (count === file.points.length) return 'all';
  return 'partial';
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function TriCheckbox({
  state,
  onPress,
}: {
  state: SelectionState;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.checkbox} onPress={onPress} hitSlop={8}>
      {state !== 'none' && (
        <Text style={styles.checkboxMark}>{state === 'all' ? '✓' : '−'}</Text>
      )}
    </Pressable>
  );
}

function Checkbox({ checked, onPress }: { checked: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.checkbox} onPress={onPress} hitSlop={8}>
      {checked && <Text style={styles.checkboxMark}>✓</Text>}
    </Pressable>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const { files, addFile, removeFile, selectedIds, togglePoint, setFileSelection, visiblePoints, allPoints } =
    useGeoData();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggleExpand(fileId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  async function handleLoadGeoJSON() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['*/*'],
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled) return;

      for (const asset of result.assets) {
        const text = await (await fetch(asset.uri)).text();
        const geojson = JSON.parse(text);
        const file = extractPoints(geojson, asset.name ?? 'archivo.geojson');

        if (file.points.length === 0) {
          Alert.alert('Sin puntos', `"${file.name}" no contiene geometrías de tipo Point.`);
          continue;
        }

        addFile(file);
        // Auto-expand the newly loaded file
        setExpandedIds((prev) => new Set(prev).add(file.id));
      }
    } catch {
      Alert.alert('Error', 'No se pudo leer el archivo. Asegurate de que sea un GeoJSON válido.');
    }
  }

  function handleRemove(id: string, name: string) {
    Alert.alert('Eliminar archivo', `¿Eliminar "${name}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar', style: 'destructive', onPress: () => removeFile(id) },
    ]);
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>OpenLiveMap</Text>

        <Pressable style={styles.loadButton} onPress={handleLoadGeoJSON}>
          <Text style={styles.loadButtonText}>+ Cargar mapa</Text>
        </Pressable>

        {files.map((file) => {
          const expanded = expandedIds.has(file.id);
          const selState = fileSelectionState(file, selectedIds);
          const selCount = file.points.filter((p) => selectedIds.has(p.id)).length;

          return (
            <View key={file.id} style={styles.fileCard}>
              {/* File header */}
              <View style={styles.fileHeader}>
                <TriCheckbox
                  state={selState}
                  onPress={() => setFileSelection(file.id, selState !== 'all')}
                />
                <Pressable style={styles.fileHeaderCenter} onPress={() => toggleExpand(file.id)}>
                  <Text style={styles.fileName} numberOfLines={1}>
                    {file.name}
                  </Text>
                  <Text style={styles.fileCount}>
                    {selCount}/{file.points.length} punto{file.points.length !== 1 ? 's' : ''}
                  </Text>
                </Pressable>
                <Text style={styles.expandArrow}>{expanded ? '▲' : '▼'}</Text>
                <Pressable
                  style={styles.deleteButton}
                  onPress={() => handleRemove(file.id, file.name)}
                  hitSlop={8}
                >
                  <Text style={styles.deleteText}>✕</Text>
                </Pressable>
              </View>

              {/* Point list */}
              {expanded &&
                file.points.map((point) => (
                  <Pressable
                    key={point.id}
                    style={styles.pointRow}
                    onPress={() => togglePoint(point.id)}
                  >
                    <View style={[styles.pointColorDot, { backgroundColor: point.color }]} />
                    <Text style={styles.pointName} numberOfLines={1}>
                      {point.name ?? point.id}
                    </Text>
                    <Checkbox
                      checked={selectedIds.has(point.id)}
                      onPress={() => togglePoint(point.id)}
                    />
                  </Pressable>
                ))}
            </View>
          );
        })}
      </ScrollView>

      {/* Sticky bottom */}
      <View style={styles.bottom}>
        {allPoints.length === 0 && (
          <Text style={styles.hint}>Cargá al menos un archivo GeoJSON para ver los puntos en AR</Text>
        )}
        {allPoints.length > 0 && visiblePoints.length === 0 && (
          <Text style={styles.hint}>Seleccioná al menos un punto para continuar</Text>
        )}
        <Pressable
          style={[styles.verButton, visiblePoints.length === 0 && styles.verButtonDisabled]}
          onPress={() => router.push('/ar')}
          disabled={visiblePoints.length === 0}
        >
          <Text style={styles.verButtonText}>
            Ver{visiblePoints.length > 0 ? ` (${visiblePoints.length})` : ''}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f0f0f5',
  },
  scrollContent: {
    padding: 20,
    paddingTop: 72,
    paddingBottom: 16,
    gap: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 8,
  },

  // Load button
  loadButton: {
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  loadButtonText: {
    color: '#007AFF',
    fontSize: 17,
    fontWeight: '600',
  },

  // File card
  fileCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  fileHeaderCenter: {
    flex: 1,
  },
  fileName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  fileCount: {
    fontSize: 12,
    color: '#888',
    marginTop: 1,
  },
  expandArrow: {
    fontSize: 11,
    color: '#aaa',
  },
  deleteButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#FFE5E5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteText: {
    color: '#FF3B30',
    fontSize: 12,
    fontWeight: '700',
  },

  // Point rows
  pointRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ebebeb',
    gap: 10,
  },
  pointColorDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    flexShrink: 0,
  },
  pointName: {
    flex: 1,
    fontSize: 14,
    color: '#333',
  },

  // Checkbox
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  checkboxMark: {
    color: '#007AFF',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 14,
  },

  // Bottom section
  bottom: {
    padding: 20,
    paddingBottom: 36,
    backgroundColor: '#f0f0f5',
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ddd',
  },
  hint: {
    textAlign: 'center',
    color: '#aaa',
    fontSize: 13,
  },
  verButton: {
    backgroundColor: '#007AFF',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  verButtonDisabled: {
    backgroundColor: '#b0c8e8',
    shadowOpacity: 0,
    elevation: 0,
  },
  verButtonText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});
