import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SavedMap, isSafUri, useSavedMaps } from '@/context/saved-maps-context';

// ── Helpers ──────────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── SavedMapCard ─────────────────────────────────────────────────────────────────

function SavedMapCard({ map, onDelete }: { map: SavedMap; onDelete: () => void }) {
  const sourcePill = map.source === 'downloaded'
    ? { label: 'Descargado', color: '#34C759' }
    : { label: 'Cargado', color: '#007AFF' };

  const storageLabel = isSafUri(map.filePath)
    ? 'Descargas/OpenLiveMap'
    : 'Almacenamiento interno';

  return (
    <Pressable
      style={styles.mapCard}
      onPress={() => router.push(`/ver-mapa-offline?id=${map.id}`)}
    >
      <View style={styles.mapCardIcon}>
        <Text style={styles.mapCardIconText}>🗺</Text>
      </View>

      <View style={styles.mapCardContent}>
        <View style={styles.mapCardTopRow}>
          <Text style={styles.mapCardName} numberOfLines={1}>{map.name}</Text>
          <View style={[styles.sourcePill, { borderColor: sourcePill.color + '55' }]}>
            <Text style={[styles.sourcePillText, { color: sourcePill.color }]}>
              {sourcePill.label}
            </Text>
          </View>
        </View>
        <Text style={styles.mapCardMeta}>
          {formatSize(map.fileSize)} · {formatDate(map.createdAt)}
        </Text>
        <Text style={styles.mapCardLocation}>{storageLabel}</Text>
      </View>

      <Pressable
        style={styles.deleteBtn}
        onPress={() =>
          Alert.alert(
            'Eliminar mapa',
            `¿Querés eliminar "${map.name}"?`,
            [
              { text: 'Cancelar', style: 'cancel' },
              { text: 'Eliminar', style: 'destructive', onPress: onDelete },
            ],
          )
        }
        hitSlop={12}
      >
        <Text style={styles.deleteBtnText}>✕</Text>
      </Pressable>
    </Pressable>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────────

export default function MisMapsScreen() {
  const insets = useSafeAreaInsets();
  const { maps, isLoading, addLoadedMap, removeMap } = useSavedMaps();

  async function handleLoadMap() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;

      const asset = result.assets[0];
      const name = asset.name ?? 'mapa.geojson';
      const ext = name.toLowerCase();

      if (!ext.endsWith('.osm') && !ext.endsWith('.geojson') && !ext.endsWith('.json')) {
        Alert.alert(
          'Formato no soportado',
          'Por ahora solo se pueden cargar archivos .osm, .geojson o .json.',
        );
        return;
      }

      await addLoadedMap(asset.uri, name);
    } catch {
      Alert.alert('Error', 'No se pudo cargar el archivo. Intentá de nuevo.');
    }
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingTop: 24, paddingBottom: insets.bottom + 40 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      {/* Action buttons */}
      <View style={styles.btnRow}>
        <Pressable
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
          onPress={handleLoadMap}
        >
          <Text style={styles.primaryBtnText}>+ Cargar mapa</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}
          onPress={() => router.push('/descargar-mapa')}
        >
          <Text style={styles.secondaryBtnText}>+ Descargar área</Text>
        </Pressable>
      </View>

      {/* Format hint */}
      <Text style={styles.hint}>
        Formatos soportados: .osm, .geojson
      </Text>

      {/* Map list */}
      {isLoading ? (
        <Text style={styles.emptyText}>Cargando…</Text>
      ) : maps.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>🗺️</Text>
          <Text style={styles.emptyTitle}>No tenés mapas guardados aún</Text>
          <Text style={styles.emptySubtitle}>
            Cargá un archivo desde tu dispositivo o descargá un área del mapa.
          </Text>
        </View>
      ) : (
        <View style={styles.mapList}>
          <Text style={styles.listHeader}>
            {maps.length} mapa{maps.length !== 1 ? 's' : ''} guardado{maps.length !== 1 ? 's' : ''}
          </Text>
          {maps.map((map) => (
            <SavedMapCard
              key={map.id}
              map={map}
              onDelete={() => removeMap(map.id)}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0a0a0f',
  },
  content: {
    paddingHorizontal: 20,
    gap: 16,
  },

  // ── Action buttons ───────────────────────────────────────────────────────────
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    borderRadius: 14,
    borderCurve: 'continuous',
    alignItems: 'center',
  },
  primaryBtnPressed: {
    backgroundColor: '#0062CC',
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
  },
  secondaryBtnPressed: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  secondaryBtnText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 15,
    fontWeight: '500',
  },

  // ── Hint ─────────────────────────────────────────────────────────────────────
  hint: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.25)',
    textAlign: 'center',
    marginTop: -4,
  },

  // ── Empty state ──────────────────────────────────────────────────────────────
  emptyState: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.3)',
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyText: {
    color: 'rgba(255,255,255,0.3)',
    textAlign: 'center',
    marginTop: 24,
  },

  // ── Map list ─────────────────────────────────────────────────────────────────
  mapList: {
    gap: 10,
  },
  listHeader: {
    fontSize: 13,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.35)',
    marginBottom: 2,
  },

  // ── Map card ─────────────────────────────────────────────────────────────────
  mapCard: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingVertical: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  mapCardIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  mapCardIconText: {
    fontSize: 20,
  },
  mapCardContent: {
    flex: 1,
    gap: 4,
  },
  mapCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mapCardName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
  },
  mapCardMeta: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.35)',
  },
  mapCardLocation: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.22)',
    letterSpacing: 0.2,
  },
  sourcePill: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  sourcePillText: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  deleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.07)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteBtnText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    fontWeight: '500',
  },
});
