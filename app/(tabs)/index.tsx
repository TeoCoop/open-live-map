import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useGeoData, type GeoFile, type GeoPoint } from '@/context/geo-data-context';

const DEFAULT_COLOR = '#4A90E2';

// CSS named colors → hex. Reanimated (v4) only accepts hex/rgb, not color names.
const CSS_COLORS: Record<string, string> = {
  aliceblue: '#F0F8FF', antiquewhite: '#FAEBD7', aqua: '#00FFFF', aquamarine: '#7FFFD4',
  azure: '#F0FFFF', beige: '#F5F5DC', bisque: '#FFE4C4', black: '#000000',
  blanchedalmond: '#FFEBCD', blue: '#0000FF', blueviolet: '#8A2BE2', brown: '#A52A2A',
  burlywood: '#DEB887', cadetblue: '#5F9EA0', chartreuse: '#7FFF00', chocolate: '#D2691E',
  coral: '#FF7F50', cornflowerblue: '#6495ED', cornsilk: '#FFF8DC', crimson: '#DC143C',
  cyan: '#00FFFF', darkblue: '#00008B', darkcyan: '#008B8B', darkgoldenrod: '#B8860B',
  darkgray: '#A9A9A9', darkgrey: '#A9A9A9', darkgreen: '#006400', darkkhaki: '#BDB76B',
  darkmagenta: '#8B008B', darkolivegreen: '#556B2F', darkorange: '#FF8C00',
  darkorchid: '#9932CC', darkred: '#8B0000', darksalmon: '#E9967A', darkseagreen: '#8FBC8F',
  darkslateblue: '#483D8B', darkslategray: '#2F4F4F', darkslategrey: '#2F4F4F',
  darkturquoise: '#00CED1', darkviolet: '#9400D3', deeppink: '#FF1493',
  deepskyblue: '#00BFFF', dimgray: '#696969', dimgrey: '#696969', dodgerblue: '#1E90FF',
  firebrick: '#B22222', floralwhite: '#FFFAF0', forestgreen: '#228B22', fuchsia: '#FF00FF',
  gainsboro: '#DCDCDC', ghostwhite: '#F8F8FF', gold: '#FFD700', goldenrod: '#DAA520',
  gray: '#808080', grey: '#808080', green: '#008000', greenyellow: '#ADFF2F',
  honeydew: '#F0FFF0', hotpink: '#FF69B4', indianred: '#CD5C5C', indigo: '#4B0082',
  ivory: '#FFFFF0', khaki: '#F0E68C', lavender: '#E6E6FA', lavenderblush: '#FFF0F5',
  lawngreen: '#7CFC00', lemonchiffon: '#FFFACD', lightblue: '#ADD8E6', lightcoral: '#F08080',
  lightcyan: '#E0FFFF', lightgoldenrodyellow: '#FAFAD2', lightgray: '#D3D3D3',
  lightgrey: '#D3D3D3', lightgreen: '#90EE90', lightpink: '#FFB6C1', lightsalmon: '#FFA07A',
  lightseagreen: '#20B2AA', lightskyblue: '#87CEFA', lightslategray: '#778899',
  lightslategrey: '#778899', lightsteelblue: '#B0C4DE', lightyellow: '#FFFFE0',
  lime: '#00FF00', limegreen: '#32CD32', linen: '#FAF0E6', magenta: '#FF00FF',
  maroon: '#800000', mediumaquamarine: '#66CDAA', mediumblue: '#0000CD',
  mediumorchid: '#BA55D3', mediumpurple: '#9370DB', mediumseagreen: '#3CB371',
  mediumslateblue: '#7B68EE', mediumspringgreen: '#00FA9A', mediumturquoise: '#48D1CC',
  mediumvioletred: '#C71585', midnightblue: '#191970', mintcream: '#F5FFFA',
  mistyrose: '#FFE4E1', moccasin: '#FFE4B5', navajowhite: '#FFDEAD', navy: '#000080',
  oldlace: '#FDF5E6', olive: '#808000', olivedrab: '#6B8E23', orange: '#FFA500',
  orangered: '#FF4500', orchid: '#DA70D6', palegoldenrod: '#EEE8AA', palegreen: '#98FB98',
  paleturquoise: '#AFEEEE', palevioletred: '#DB7093', papayawhip: '#FFEFD5',
  peachpuff: '#FFDAB9', peru: '#CD853F', pink: '#FFC0CB', plum: '#DDA0DD',
  powderblue: '#B0E0E6', purple: '#800080', red: '#FF0000', rosybrown: '#BC8F8F',
  royalblue: '#4169E1', saddlebrown: '#8B4513', salmon: '#FA8072', sandybrown: '#F4A460',
  seagreen: '#2E8B57', seashell: '#FFF5EE', sienna: '#A0522D', silver: '#C0C0C0',
  skyblue: '#87CEEB', slateblue: '#6A5ACD', slategray: '#708090', slategrey: '#708090',
  snow: '#FFFAFA', springgreen: '#00FF7F', steelblue: '#4682B4', tan: '#D2B48C',
  teal: '#008080', thistle: '#D8BFD8', tomato: '#FF6347', turquoise: '#40E0D0',
  violet: '#EE82EE', wheat: '#F5DEB3', white: '#FFFFFF', whitesmoke: '#F5F5F5',
  yellow: '#FFFF00', yellowgreen: '#9ACD32',
};

function resolveColor(raw: string | undefined | null): string {
  if (!raw) return DEFAULT_COLOR;
  // Already hex or rgb — keep as-is
  if (raw.startsWith('#') || raw.startsWith('rgb')) return raw;
  const hex = CSS_COLORS[raw.toLowerCase()];
  return hex ?? DEFAULT_COLOR;
}

// ─── GeoJSON parser ───────────────────────────────────────────────────────────
function extractPoints(geojson: any, fileName: string): GeoFile {
  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const points: GeoPoint[] = [];

  function colorFrom(props: any): string {
    return resolveColor(props?._umap_options?.color);
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

        <Pressable style={styles.markButton} onPress={() => router.push('/mark-point')}>
          <Text style={styles.markButtonText}>📍 Marcar puntos en mapa</Text>
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

  // Mark button
  markButton: {
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#34C759',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  markButtonText: {
    color: '#34C759',
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
