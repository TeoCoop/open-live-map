import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { WebViewMessageEvent } from 'react-native-webview';

import { SavedMap, useSavedMaps } from '@/context/saved-maps-context';

// ── Types ────────────────────────────────────────────────────────────────────────

type Bbox = { west: number; south: number; east: number; north: number };

type OutputDir =
  | { type: 'external'; dirUri: string }  // SAF content:// — Downloads/OpenLiveMap
  | { type: 'internal'; dirUri: string }; // file:// — documentDirectory/maps/

// ── SAF storage logic (Android only) ────────────────────────────────────────────

const SAF = FileSystem.StorageAccessFramework;
// Persists SAF URIs between sessions (stored in app's private directory)
const SAF_CONFIG_PATH = `${FileSystem.documentDirectory}.saf-config.json`;

type SafConfig = {
  downloadsUri: string;
  openlivemapUri: string;
};

async function readSafConfig(): Promise<SafConfig | null> {
  try {
    const text = await FileSystem.readAsStringAsync(SAF_CONFIG_PATH);
    return JSON.parse(text) as SafConfig;
  } catch { return null; }
}

async function writeSafConfig(config: SafConfig): Promise<void> {
  await FileSystem.writeAsStringAsync(SAF_CONFIG_PATH, JSON.stringify(config));
}

async function isDirAccessible(uri: string): Promise<boolean> {
  try {
    await SAF.readDirectoryAsync(uri);
    return true;
  } catch { return false; }
}

/**
 * Finds an existing OpenLiveMap directory inside `downloadsUri`, or creates
 * one if it doesn't exist.
 */
async function findOrCreateOpenLivemap(downloadsUri: string): Promise<string> {
  try {
    const children = await SAF.readDirectoryAsync(downloadsUri);
    // SAF child URIs contain the encoded folder name in the path
    const found = children.find((uri) =>
      decodeURIComponent(uri).toLowerCase().includes('openlive'),
    );
    if (found) return found;
  } catch { /* fall through to create */ }

  return SAF.makeDirectoryAsync(downloadsUri, 'OpenLiveMap');
}

/**
 * Returns the directory where downloaded maps should be written.
 *
 * Android flow:
 *   1. Use cached SAF config if still accessible.
 *   2. If Downloads dir is accessible but OpenLiveMap is not → recreate subfolder.
 *   3. Otherwise → show SAF picker (pre-opened at Downloads) to request permission.
 *   4. On denial → fall back to internal storage.
 *
 * iOS: always returns documentDirectory/maps/ (visible in the Files app).
 */
async function getOutputDir(): Promise<OutputDir> {
  // ── iOS ─────────────────────────────────────────────────────────────────────
  if (Platform.OS !== 'android') {
    const dir = `${FileSystem.documentDirectory}maps/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    return { type: 'internal', dirUri: dir };
  }

  // ── Android ─────────────────────────────────────────────────────────────────

  const fallbackInternal = async (): Promise<OutputDir> => {
    const dir = `${FileSystem.documentDirectory}maps/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    return { type: 'internal', dirUri: dir };
  };

  const config = await readSafConfig();

  // 1. Try stored OpenLiveMap directory
  if (config && await isDirAccessible(config.openlivemapUri)) {
    return { type: 'external', dirUri: config.openlivemapUri };
  }

  // 2. Try stored Downloads directory → recreate OpenLiveMap inside
  if (config && await isDirAccessible(config.downloadsUri)) {
    try {
      const olmUri = await findOrCreateOpenLivemap(config.downloadsUri);
      await writeSafConfig({ downloadsUri: config.downloadsUri, openlivemapUri: olmUri });
      return { type: 'external', dirUri: olmUri };
    } catch { /* fall through */ }
  }

  // 3. Need to request permission — ask the user first
  await new Promise<void>((resolve) => {
    Alert.alert(
      'Acceso a Descargas',
      'Para guardar en Descargas/OpenLiveMap, seleccioná esa carpeta en el selector que va a aparecer.',
      [{ text: 'Entendido', onPress: () => resolve() }],
    );
  });

  // Pre-navigate the SAF picker to the Downloads folder
  const downloadsHint = SAF.getUriForDirectoryInRoot('Download');
  const result = await SAF.requestDirectoryPermissionsAsync(downloadsHint);

  if (!result.granted) {
    Alert.alert(
      'Guardando en almacenamiento interno',
      'No se otorgó acceso a Descargas. El mapa se guardará en el almacenamiento interno de la app.',
    );
    return fallbackInternal();
  }

  try {
    const olmUri = await findOrCreateOpenLivemap(result.directoryUri);
    await writeSafConfig({ downloadsUri: result.directoryUri, openlivemapUri: olmUri });
    return { type: 'external', dirUri: olmUri };
  } catch {
    // Couldn't create subfolder — save directly in the granted directory
    await writeSafConfig({
      downloadsUri: result.directoryUri,
      openlivemapUri: result.directoryUri,
    });
    return { type: 'external', dirUri: result.directoryUri };
  }
}

// ── Size estimation ──────────────────────────────────────────────────────────────

const BYTES_PER_KM2 = 8 * 1024 * 1024; // 8 MB/km² — conservative urban estimate
const MAX_BYTES = 1024 * 1024 * 1024;   // 1 GB hard limit
const WARN_BYTES = 100 * 1024 * 1024;   // 100 MB
const DANGER_BYTES = 500 * 1024 * 1024; // 500 MB

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateBboxSizeBytes(bbox: Bbox): number {
  const widthKm = haversineKm(bbox.south, bbox.west, bbox.south, bbox.east);
  const heightKm = haversineKm(bbox.south, bbox.west, bbox.north, bbox.west);
  return widthKm * heightKm * BYTES_PER_KM2;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

type SizeStatus = 'safe' | 'warn' | 'danger' | 'blocked';

function getSizeStatus(bytes: number): SizeStatus {
  if (bytes > MAX_BYTES) return 'blocked';
  if (bytes > DANGER_BYTES) return 'danger';
  if (bytes > WARN_BYTES) return 'warn';
  return 'safe';
}

const STATUS_COLORS: Record<SizeStatus, string> = {
  safe: '#34C759',
  warn: '#FF9500',
  danger: '#FF3B30',
  blocked: '#FF3B30',
};

// ── Leaflet HTML ─────────────────────────────────────────────────────────────────

function buildAreaMapHtml(lat: number, lng: number): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <link rel="stylesheet" href="https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js"></script>
  <style>
    html,body{margin:0;padding:0;height:100%;background:#e8e0d8;overflow:hidden}
    #map{width:100%;height:100%}
    .user-dot{
      width:16px;height:16px;border-radius:50%;
      background:#007AFF;border:3px solid #fff;
      box-shadow:0 0 0 4px rgba(0,122,255,0.25),0 2px 8px rgba(0,0,0,0.3);
    }
    .leaflet-draw-toolbar a{
      background-color:rgba(10,10,20,0.85) !important;
      border-color:rgba(255,255,255,0.18) !important;
    }
    .leaflet-draw-toolbar a:hover{
      background-color:rgba(0,122,255,0.85) !important;
    }
  </style>
</head>
<body>
<div id="map"></div>
<script>
  var map = L.map('map',{zoomControl:true,attributionControl:true})
             .setView([${lat},${lng}],13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19,
    attribution:'© <a href="https://www.openstreetmap.org/copyright">OSM</a>'
  }).addTo(map);

  var userIcon = L.divIcon({
    className:'',
    html:'<div class="user-dot"></div>',
    iconSize:[16,16],iconAnchor:[8,8]
  });
  var userMarker = L.marker([${lat},${lng}],{
    icon:userIcon,interactive:false,zIndexOffset:1000
  }).addTo(map);

  var drawnItems = new L.FeatureGroup().addTo(map);

  var drawControl = new L.Control.Draw({
    draw:{
      rectangle:{shapeOptions:{color:'#007AFF',weight:2,fillOpacity:0.15}},
      polyline:false,polygon:false,circle:false,circlemarker:false,marker:false
    },
    edit:{featureGroup:drawnItems,remove:true}
  });
  map.addControl(drawControl);

  function notifyBbox(layer){
    var b = layer.getBounds();
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type:'bbox',
      west:b.getWest(),south:b.getSouth(),
      east:b.getEast(),north:b.getNorth()
    }));
  }

  map.on(L.Draw.Event.CREATED,function(e){
    drawnItems.clearLayers();
    drawnItems.addLayer(e.layer);
    notifyBbox(e.layer);
  });
  map.on(L.Draw.Event.EDITED,function(e){
    e.layers.eachLayer(function(layer){ notifyBbox(layer); });
  });
  map.on(L.Draw.Event.DELETED,function(){
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'bbox_cleared'}));
  });

  function handleRNMessage(raw){
    try{
      var msg=JSON.parse(raw);
      if(msg.type==='updateLocation'){ userMarker.setLatLng([msg.lat,msg.lng]); }
      if(msg.type==='goToMyLocation'){
        map.setView(userMarker.getLatLng(),13,{animate:true});
      }
    }catch(e){}
  }
  document.addEventListener('message',function(e){handleRNMessage(e.data);});
  window.addEventListener('message',function(e){handleRNMessage(e.data);});
</script>
</body>
</html>`;
}

// ── Screen ──────────────────────────────────────────────────────────────────────

export default function DescargarMapaScreen() {
  const insets = useSafeAreaInsets();
  const { addDownloadedMap } = useSavedMaps();
  const webViewRef = useRef<WebView>(null);

  const [mapHtml, setMapHtml] = useState<string | null>(null);
  const [locating, setLocating] = useState(true);
  const [userCoord, setUserCoord] = useState<{ lat: number; lng: number } | null>(null);

  const [bbox, setBbox] = useState<Bbox | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [savedLocation, setSavedLocation] = useState<'external' | 'internal' | null>(null);

  const estimatedBytes = bbox ? estimateBboxSizeBytes(bbox) : 0;
  const sizeStatus = getSizeStatus(estimatedBytes);
  const sizeColor = STATUS_COLORS[sizeStatus];

  // ── GPS init ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      const defaultLat = -34.6037;
      const defaultLng = -58.3816;

      if (status !== 'granted') {
        setMapHtml(buildAreaMapHtml(defaultLat, defaultLng));
        setLocating(false);
        return;
      }

      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      }).catch(() => null);

      const lat = loc?.coords.latitude ?? defaultLat;
      const lng = loc?.coords.longitude ?? defaultLng;
      setUserCoord({ lat, lng });
      setMapHtml(buildAreaMapHtml(lat, lng));
      setLocating(false);

      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 10 },
        (l) => {
          const coord = { lat: l.coords.latitude, lng: l.coords.longitude };
          setUserCoord(coord);
          webViewRef.current?.injectJavaScript(
            `handleRNMessage(${JSON.stringify(JSON.stringify({ type: 'updateLocation', ...coord }))});true;`,
          );
        },
      ).catch(() => null);
    })();
    return () => { sub?.remove(); };
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function handleMessage(event: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'bbox') {
        setBbox({ west: msg.west, south: msg.south, east: msg.east, north: msg.north });
        setDownloadError(null);
        setSavedLocation(null);
      }
      if (msg.type === 'bbox_cleared') {
        setBbox(null);
        setDownloadError(null);
        setSavedLocation(null);
      }
    } catch { /* ignore */ }
  }

  function handleMyLocation() {
    if (!userCoord) return;
    webViewRef.current?.injectJavaScript(
      `handleRNMessage(${JSON.stringify(JSON.stringify({ type: 'goToMyLocation' }))});true;`,
    );
  }

  async function handleDownload() {
    if (!bbox || sizeStatus === 'blocked') return;

    setDownloading(true);
    setDownloadError(null);
    setSavedLocation(null);

    try {
      if (!FileSystem.documentDirectory) {
        throw new Error('Sin acceso al sistema de archivos del dispositivo.');
      }

      // ── 1. Get output directory (may show SAF picker on first use) ──────────
      const outputDir = await getOutputDir();

      // ── 2. Fetch OSM data from Overpass API ──────────────────────────────────
      const url = `https://overpass-api.de/api/map?bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3 * 60 * 1000);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/xml, text/xml', 'User-Agent': 'OpenLiveMap/1.0' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.status === 400) {
        const body = await response.text().catch(() => '');
        console.warn('[descargar-mapa] Overpass 400:', body.slice(0, 300));
        throw new Error('area_too_large');
      }
      if (response.status === 429 || response.status === 509) throw new Error('rate_limited');
      if (response.status === 504 || response.status === 502) throw new Error('server_unavailable');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      const id = `map-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const fileName = `${id}.osm`;

      // ── 3. Write the file to the appropriate storage ──────────────────────────
      let filePath: string;
      let fileSize: number;

      if (outputDir.type === 'external') {
        // Android SAF: write to Downloads/OpenLiveMap
        filePath = await SAF.createFileAsync(outputDir.dirUri, fileName, 'application/xml');
        await SAF.writeAsStringAsync(filePath, text, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        // SAF files don't have an easy size API; use text byte length as estimate
        fileSize = new Blob([text]).size;
      } else {
        // Internal storage (file:// URI)
        filePath = `${outputDir.dirUri}${fileName}`;
        await FileSystem.writeAsStringAsync(filePath, text, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        const info = await FileSystem.getInfoAsync(filePath);
        fileSize = info.exists && 'size' in info ? (info.size ?? 0) : 0;
      }

      // ── 4. Save to catalog ───────────────────────────────────────────────────
      const entry: SavedMap = {
        id,
        name: `Área ${new Date().toLocaleDateString('es-AR', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })}`,
        source: 'downloaded',
        filePath,
        fileSize,
        bbox,
        createdAt: Date.now(),
      };

      await addDownloadedMap(entry);
      setSavedLocation(outputDir.type);

      // Navigate back after a brief moment so user sees the success state
      setTimeout(() => router.back(), 1200);

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[descargar-mapa] download error:', msg);

      if (msg === 'area_too_large') {
        setDownloadError('El área es demasiado grande para OpenStreetMaps. Reducí la selección.');
      } else if (msg === 'rate_limited') {
        setDownloadError('Demasiadas solicitudes al servidor. Esperá unos minutos e intentá de nuevo.');
      } else if (msg === 'server_unavailable') {
        setDownloadError('El servidor de OpenStreetMaps no está disponible. Intentá más tarde.');
      } else if (msg.includes('AbortError') || msg.includes('aborted')) {
        setDownloadError('La descarga tardó demasiado (más de 3 min). Intentá con un área más pequeña.');
      } else {
        setDownloadError(`Error al descargar: ${msg}`);
      }
    } finally {
      setDownloading(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const downloadDisabled = !bbox || sizeStatus === 'blocked' || downloading;

  return (
    <View style={styles.container}>
      {/* Map or loading */}
      {locating || !mapHtml ? (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Obteniendo ubicación…</Text>
        </View>
      ) : (
        <WebView
          ref={webViewRef}
          source={{ html: mapHtml }}
          style={styles.map}
          onMessage={handleMessage}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          allowUniversalAccessFromFileURLs
          onError={() =>
            Alert.alert(
              'Sin conexión',
              'No se pudo cargar el mapa. Verificá tu conexión a internet.',
            )
          }
        />
      )}

      {/* Floating header */}
      <View style={[styles.header, { top: insets.top + 12 }]} pointerEvents="box-none">
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>←</Text>
        </Pressable>
        <View style={styles.titlePill}>
          <Text style={styles.titleText}>Descargar área OSM</Text>
        </View>
      </View>

      {/* Bottom panel */}
      {!locating && (
        <View style={[styles.panel, { paddingBottom: insets.bottom + 20 }]}>
          {savedLocation ? (
            /* ── Success state ── */
            <View style={styles.successContainer}>
              <Text style={styles.successIcon}>✓</Text>
              <View>
                <Text style={styles.successLabel}>¡Mapa descargado!</Text>
                <Text style={styles.successSub}>
                  {savedLocation === 'external'
                    ? 'Guardado en Descargas/OpenLiveMap'
                    : 'Guardado en almacenamiento interno'}
                </Text>
              </View>
            </View>
          ) : downloading ? (
            /* ── Downloading state ── */
            <View style={styles.downloadingContainer}>
              <ActivityIndicator color="#007AFF" />
              <View style={styles.downloadingText}>
                <Text style={styles.downloadingLabel}>Descargando datos de OSM…</Text>
                <Text style={styles.downloadingHint}>Esto puede tardar unos minutos</Text>
              </View>
            </View>
          ) : !bbox ? (
            /* ── No area drawn ── */
            <Text style={styles.hint}>
              Tocá el ícono del rectángulo en el mapa y dibujá el área que querés descargar
            </Text>
          ) : (
            /* ── Area drawn ── */
            <View style={styles.sizeContainer}>
              <View style={styles.sizeRow}>
                <View style={[styles.sizeDot, { backgroundColor: sizeColor }]} />
                <Text style={styles.sizeLabel}>Tamaño estimado:</Text>
                <Text style={[styles.sizeValue, { color: sizeColor }]}>
                  ~{formatSize(estimatedBytes)}
                </Text>
              </View>
              {sizeStatus === 'warn' && (
                <Text style={styles.warnText}>
                  ⚠️ Área grande. La descarga puede tardar varios minutos.
                </Text>
              )}
              {sizeStatus === 'danger' && (
                <Text style={styles.warnText}>
                  🔴 Área muy grande. Considerá reducirla para evitar errores.
                </Text>
              )}
              {sizeStatus === 'blocked' && (
                <Text style={styles.errorText}>
                  El área excede el límite de 1 GB. Reducí la selección.
                </Text>
              )}
            </View>
          )}

          {downloadError && (
            <Text style={styles.errorText}>{downloadError}</Text>
          )}

          {!downloading && !savedLocation && (
            <View style={styles.btnRow}>
              <Pressable
                style={[styles.secondaryBtn, !userCoord && styles.btnDisabled]}
                onPress={handleMyLocation}
                disabled={!userCoord}
              >
                <Text style={styles.secondaryBtnText}>Mi ubicación</Text>
              </Pressable>

              <Pressable
                style={[styles.downloadBtn, downloadDisabled && styles.btnDisabled]}
                onPress={handleDownload}
                disabled={downloadDisabled}
              >
                <Text style={styles.downloadBtnText}>
                  {!bbox ? 'Seleccioná un área' : 'Descargar'}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f' },
  map: { flex: 1 },

  // Loading
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#0a0a0f',
  },
  loadingText: { color: 'rgba(255,255,255,0.5)', fontSize: 15 },

  // Floating header
  header: {
    position: 'absolute',
    left: 16, right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  backBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(10,10,20,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center', alignItems: 'center',
  },
  backText: {position: "absolute", color: '#fff', fontSize: 20, fontWeight: '500', bottom: 10 },
  titlePill: {
    backgroundColor: 'rgba(10,10,20,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 21,
  },
  titleText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // Bottom panel
  panel: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    backgroundColor: '#0f0f18',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    gap: 14,
  },
  hint: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Size info
  sizeContainer: { gap: 6 },
  sizeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sizeDot: { width: 8, height: 8, borderRadius: 4 },
  sizeLabel: { fontSize: 14, color: 'rgba(255,255,255,0.5)' },
  sizeValue: { fontSize: 14, fontWeight: '700' },
  warnText: { fontSize: 13, color: 'rgba(255,255,255,0.55)', lineHeight: 18 },
  errorText: { fontSize: 13, color: '#FF3B30', lineHeight: 18 },

  // Downloading state
  downloadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 4,
  },
  downloadingText: { flex: 1, gap: 2 },
  downloadingLabel: { fontSize: 15, color: 'rgba(255,255,255,0.7)' },
  downloadingHint: { fontSize: 12, color: 'rgba(255,255,255,0.35)' },

  // Success state
  successContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 4,
  },
  successIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#34C759',
    textAlign: 'center',
    lineHeight: 36,
    fontSize: 18,
    color: '#fff',
    fontWeight: '700',
    overflow: 'hidden',
  },
  successLabel: { fontSize: 15, fontWeight: '600', color: '#fff' },
  successSub: { fontSize: 13, color: 'rgba(255,255,255,0.45)', marginTop: 2 },

  // Buttons
  btnRow: { flexDirection: 'row', gap: 10 },
  secondaryBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 14, borderCurve: 'continuous',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', alignItems: 'center',
  },
  secondaryBtnText: { color: 'rgba(255,255,255,0.75)', fontSize: 15, fontWeight: '500' },
  downloadBtn: {
    flex: 1.6, paddingVertical: 14, borderRadius: 14, borderCurve: 'continuous',
    backgroundColor: '#007AFF', alignItems: 'center',
  },
  downloadBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  btnDisabled: { opacity: 0.3 },
});
