import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useGeoData, type GeoFile, type GeoPoint } from '@/context/geo-data-context';
import { findMapsForLocation, useSavedMaps } from '@/context/saved-maps-context';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';

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
        id: `${fileId}-${idx}`, lat, lng,
        name: props?.name ?? props?.nombre ?? undefined,
        color: colorFrom(props),
      });
    } else if (geometry.type === 'MultiPoint') {
      (geometry.coordinates as number[][]).forEach(([lng, lat], i) => {
        points.push({ id: `${fileId}-${idx}-${i}`, lat, lng, name: props?.name ?? undefined, color: colorFrom(props) });
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

function TriCheckbox({ state, onPress }: { state: SelectionState; onPress: () => void }) {
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
export default function MapaScreen() {
  const { files, addFile, removeFile, selectedIds, togglePoint, setFileSelection, visiblePoints, allPoints } =
    useGeoData();
  const { maps: savedMaps } = useSavedMaps();
  const { isConnected } = useNetworkStatus();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);

  // When offline, get a one-shot GPS fix to filter maps by location
  useEffect(() => {
    if (isConnected || userLocation) return;
    Location.requestForegroundPermissionsAsync()
      .then(({ status }) => {
        if (status !== 'granted') return;
        return Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      })
      .then((loc) => {
        if (loc) setUserLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      })
      .catch(() => {});
  }, [isConnected]);

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
      const result = await DocumentPicker.getDocumentAsync({ type: ['*/*'], copyToCacheDirectory: true, multiple: true });
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

        {/* Action buttons */}
        <Pressable
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
          onPress={handleLoadGeoJSON}
        >
          <Text style={styles.primaryBtnText}>+ Cargar geojson</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}
          onPress={() => router.push('/mark-point')}
        >
          <Text style={styles.secondaryBtnText}>📍  Marcar puntos en mapa</Text>
        </Pressable>

        {/* File cards */}
        {files.map((file) => {
          const expanded = expandedIds.has(file.id);
          const selState = fileSelectionState(file, selectedIds);
          const selCount = file.points.filter((p) => selectedIds.has(p.id)).length;

          return (
            <View key={file.id} style={styles.fileCard}>
              <View style={styles.fileHeader}>
                <TriCheckbox state={selState} onPress={() => setFileSelection(file.id, selState !== 'all')} />
                <Pressable style={styles.fileHeaderCenter} onPress={() => toggleExpand(file.id)}>
                  <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
                  <Text style={styles.fileCount}>
                    {selCount}/{file.points.length} punto{file.points.length !== 1 ? 's' : ''}
                  </Text>
                </Pressable>
                <Text style={styles.expandArrow}>{expanded ? '▲' : '▼'}</Text>
                <Pressable style={styles.deleteBtn} onPress={() => handleRemove(file.id, file.name)} hitSlop={8}>
                  <Text style={styles.deleteBtnText}>✕</Text>
                </Pressable>
              </View>

              {expanded && file.points.map((point) => (
                <Pressable
                  key={point.id}
                  style={styles.pointRow}
                  onPress={() => togglePoint(point.id)}
                >
                  <View style={[styles.pointDot, { backgroundColor: point.color }]} />
                  <Text style={styles.pointName} numberOfLines={1}>{point.name ?? point.id}</Text>
                  <Checkbox checked={selectedIds.has(point.id)} onPress={() => togglePoint(point.id)} />
                </Pressable>
              ))}
            </View>
          );
        })}
        {/* ── Mapas offline ────────────────────────────────────────────── */}

        {/* Offline banner */}
        {!isConnected && (
          <View style={styles.offlineBanner}>
            <Text style={styles.offlineBannerText}>🔴 Sin conexión — usando mapas offline</Text>
          </View>
        )}

        <View style={styles.offlineDivider}>
          <View style={styles.offlineLine} />
          <Text style={styles.offlineLabel}>MAPA OFFLINE</Text>
          <View style={styles.offlineLine} />
        </View>

        {(() => {
          // When offline: filter maps by user location (if known), else show all
          const mapsToShow = !isConnected && userLocation
            ? findMapsForLocation(savedMaps, userLocation.lat, userLocation.lng)
            : savedMaps;

          if (savedMaps.length === 0) {
            return (
              <Pressable
                style={({ pressed }) => [styles.emptyOfflineCard, pressed && { opacity: 0.7 }]}
                onPress={() => router.push('/mis-mapas')}
              >
                <Text style={styles.emptyOfflineIcon}>🗺️</Text>
                <Text style={styles.emptyOfflineText}>
                  No tenés mapas guardados.{'\n'}
                  <Text style={styles.emptyOfflineLink}>Ir a Mis mapas →</Text>
                </Text>
              </Pressable>
            );
          }

          if (!isConnected && userLocation && mapsToShow.length === 0) {
            return (
              <Pressable
                style={({ pressed }) => [styles.emptyOfflineCard, pressed && { opacity: 0.7 }]}
                onPress={() => router.push('/mis-mapas')}
              >
                <Text style={styles.emptyOfflineIcon}>📍</Text>
                <Text style={styles.emptyOfflineText}>
                  No hay mapas descargados para tu ubicación actual.{'\n'}
                  <Text style={styles.emptyOfflineLink}>Ir a Mis mapas →</Text>
                </Text>
              </Pressable>
            );
          }

          return mapsToShow.map((m) => (
            <Pressable
              key={m.id}
              style={({ pressed }) => [styles.offlineMapCard, pressed && styles.offlineMapCardPressed]}
              onPress={() => router.push(`/ver-mapa-offline?id=${m.id}`)}
            >
              <Text style={styles.offlineMapIcon}>🗺</Text>
              <View style={styles.offlineMapInfo}>
                <Text style={styles.offlineMapName} numberOfLines={1}>{m.name}</Text>
                <Text style={styles.offlineMapMeta}>
                  {m.source === 'downloaded' ? 'Descargado' : 'Cargado'} ·{' '}
                  {m.fileSize < 1024 * 1024
                    ? `${(m.fileSize / 1024).toFixed(0)} KB`
                    : `${(m.fileSize / (1024 * 1024)).toFixed(1)} MB`}
                </Text>
              </View>
              <Text style={styles.offlineMapArrow}>→</Text>
            </Pressable>
          ));
        })()}

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
          style={[styles.verBtn, visiblePoints.length === 0 && styles.verBtnDisabled]}
          onPress={() => router.push('/ar')}
          disabled={visiblePoints.length === 0}
        >
          <Text style={styles.verBtnText}>
            {visiblePoints.length > 0 ? `Ver  (${visiblePoints.length})` : 'Ver'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Styles (dark) ────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0a0a0f' },
  scrollContent: { padding: 20, paddingTop: 16, paddingBottom: 16, gap: 12 },

  // Action buttons
  primaryBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 16,
    borderCurve: 'continuous',
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryBtnPressed: { backgroundColor: '#0066DD' },
  primaryBtnText: { color: '#fff', fontSize: 17, fontWeight: '700' },

  secondaryBtn: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 16,
    borderCurve: 'continuous',
    paddingVertical: 16,
    alignItems: 'center',
  },
  secondaryBtnPressed: { backgroundColor: 'rgba(255,255,255,0.11)' },
  secondaryBtnText: { color: 'rgba(255,255,255,0.8)', fontSize: 16, fontWeight: '500' },

  // File card
  fileCard: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 16,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 10,
  },
  fileHeaderCenter: { flex: 1 },
  fileName: { fontSize: 15, fontWeight: '600', color: '#ffffff' },
  fileCount: { fontSize: 12, color: 'rgba(255,255,255,0.38)', marginTop: 2 },
  expandArrow: { fontSize: 11, color: 'rgba(255,255,255,0.25)' },
  deleteBtn: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(255,69,58,0.18)',
    justifyContent: 'center', alignItems: 'center',
  },
  deleteBtnText: { color: '#FF453A', fontSize: 12, fontWeight: '700' },

  // Point rows
  pointRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.07)',
    gap: 10,
  },
  pointDot: { width: 12, height: 12, borderRadius: 6, flexShrink: 0 },
  pointName: { flex: 1, fontSize: 14, color: 'rgba(255,255,255,0.72)' },

  // Checkbox
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 1.5, borderColor: 'rgba(0,122,255,0.7)',
    justifyContent: 'center', alignItems: 'center', flexShrink: 0,
  },
  checkboxMark: { color: '#007AFF', fontSize: 13, fontWeight: '700', lineHeight: 14 },

  // Bottom
  bottom: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 36,
    backgroundColor: '#0f0f18',
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  hint: { textAlign: 'center', color: 'rgba(255,255,255,0.28)', fontSize: 13 },
  verBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 16,
    borderCurve: 'continuous',
    paddingVertical: 18,
    alignItems: 'center',
    boxShadow: '0 6px 24px rgba(0,122,255,0.35)',
  },
  verBtnDisabled: { backgroundColor: 'rgba(0,122,255,0.25)', boxShadow: 'none' },
  verBtnText: { color: '#fff', fontSize: 20, fontWeight: '700', letterSpacing: 0.3 },

  // ── Offline banner ────────────────────────────────────────────────────────
  offlineBanner: {
    backgroundColor: 'rgba(255,59,48,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.3)',
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  offlineBannerText: {
    color: '#FF453A',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },

  // ── Offline maps section ──────────────────────────────────────────────────
  offlineDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  offlineLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  offlineLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.28)',
    letterSpacing: 1,
  },

  emptyOfflineCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  emptyOfflineIcon: { fontSize: 24 },
  emptyOfflineText: {
    flex: 1,
    fontSize: 13,
    color: 'rgba(255,255,255,0.35)',
    lineHeight: 19,
  },
  emptyOfflineLink: {
    color: '#007AFF',
    fontWeight: '600',
  },

  offlineMapCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  offlineMapCardPressed: {
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  offlineMapIcon: { fontSize: 22 },
  offlineMapInfo: { flex: 1, gap: 2 },
  offlineMapName: {
    fontSize: 15,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
  },
  offlineMapMeta: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.35)',
  },
  offlineMapArrow: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.28)',
  },
});
