import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';

import { isSafUri, useSavedMaps } from '@/context/saved-maps-context';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Bytes per chunk sent to the WebView via injectJavaScript */
const CHUNK_SIZE = 180 * 1024; // 180 KB — safe for JS string injection

// ── Leaflet HTML (base — no OSM data yet) ────────────────────────────────────

function buildBaseHtml(lat: number, lng: number): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    html,body{margin:0;padding:0;height:100%;background:#1a1a1e;overflow:hidden}
    #map{width:100%;height:100%}
    .user-dot{
      width:16px;height:16px;border-radius:50%;
      background:#007AFF;border:3px solid #fff;
      box-shadow:0 0 0 4px rgba(0,122,255,0.25),0 2px 8px rgba(0,0,0,0.4);
    }
    #overlay{
      position:fixed;top:0;left:0;width:100%;height:100%;
      background:rgba(15,15,25,0.85);
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:14px;z-index:9999;transition:opacity 0.4s;
    }
    #overlay.hidden{opacity:0;pointer-events:none}
    .spinner{
      width:36px;height:36px;border:3px solid rgba(255,255,255,0.15);
      border-top-color:#007AFF;border-radius:50%;
      animation:spin 0.8s linear infinite;
    }
    @keyframes spin{to{transform:rotate(360deg)}}
    #status{color:rgba(255,255,255,0.7);font-family:system-ui;font-size:14px}
    #progress-bar{
      width:200px;height:4px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;
    }
    #progress-fill{height:100%;background:#007AFF;width:0%;transition:width 0.1s}
  </style>
</head>
<body>
<div id="overlay">
  <div class="spinner"></div>
  <div id="progress-bar"><div id="progress-fill"></div></div>
  <div id="status">Cargando mapa…</div>
</div>
<div id="map"></div>
<script>
  // ── Map init ──────────────────────────────────────────────────────────────
  var map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
  }).setView([${lat}, ${lng}], 14);

  // Online tile basemap (loads if internet is available, silent fallback if not)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  }).addTo(map);

  // User location marker
  var userIcon = L.divIcon({
    className: '',
    html: '<div class="user-dot"></div>',
    iconSize: [16, 16], iconAnchor: [8, 8],
  });
  var userMarker = L.marker([${lat}, ${lng}], {
    icon: userIcon, interactive: false, zIndexOffset: 1000,
  }).addTo(map);

  // ── Chunk receiver ────────────────────────────────────────────────────────
  var _chunks = [];
  var _totalChunks = 0;

  function receiveChunk(chunk, chunkIndex, totalChunks, isLast) {
    _chunks.push(chunk);
    _totalChunks = totalChunks;
    var pct = Math.round(((chunkIndex + 1) / totalChunks) * 100);
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('status').textContent =
      'Cargando datos… ' + pct + '%';
    if (isLast) {
      var fullContent = _chunks.join('');
      _chunks = [];
      document.getElementById('status').textContent = 'Renderizando…';
      setTimeout(function () { loadMapData(fullContent); }, 30);
    }
  }

  // ── OSM XML renderer ──────────────────────────────────────────────────────
  function loadMapData(raw) {
    var isGeoJSON = raw.trimStart().charAt(0) === '{';
    if (isGeoJSON) {
      renderGeoJSON(JSON.parse(raw));
    } else {
      renderOSM(raw);
    }
  }

  function renderGeoJSON(geojson) {
    try {
      var layer = L.geoJSON(geojson, {
        style: function (f) {
          return { color: '#007AFF', weight: 2, fillOpacity: 0.25 };
        },
      }).addTo(map);
      if (layer.getBounds().isValid()) {
        map.fitBounds(layer.getBounds(), { padding: [20, 20] });
      }
    } catch (e) {
      notifyError('No se pudo renderizar el archivo GeoJSON.');
    }
    hideOverlay();
  }

  function renderOSM(xml) {
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(xml, 'text/xml');

      // Parse error check
      var parseError = doc.querySelector('parsererror');
      if (parseError) throw new Error('XML parse error');

      // Build node lookup: id → [lat, lng]
      var nodes = Object.create(null);
      var nodeEls = doc.querySelectorAll('node');
      for (var i = 0; i < nodeEls.length; i++) {
        var n = nodeEls[i];
        var nid = n.getAttribute('id');
        var nlat = parseFloat(n.getAttribute('lat'));
        var nlon = parseFloat(n.getAttribute('lon'));
        if (!isNaN(nlat) && !isNaN(nlon)) {
          nodes[nid] = [nlat, nlon];
        }
      }

      // Layer groups (rendered bottom-to-top)
      var layerGreen    = L.layerGroup();
      var layerWater    = L.layerGroup();
      var layerBuilding = L.layerGroup();
      var layerRoadMin  = L.layerGroup();
      var layerRoadMaj  = L.layerGroup();

      var allCoords = [];
      var wayEls = doc.querySelectorAll('way');

      for (var w = 0; w < wayEls.length; w++) {
        var way = wayEls[w];

        // Collect coordinates
        var latlngs = [];
        var nds = way.querySelectorAll('nd');
        for (var nd = 0; nd < nds.length; nd++) {
          var ref = nds[nd].getAttribute('ref');
          var coord = nodes[ref];
          if (coord) {
            latlngs.push(coord);
            allCoords.push(coord);
          }
        }
        if (latlngs.length < 2) continue;

        // Build tag map
        var tags = Object.create(null);
        var tagEls = way.querySelectorAll('tag');
        for (var t = 0; t < tagEls.length; t++) {
          tags[tagEls[t].getAttribute('k')] = tagEls[t].getAttribute('v');
        }

        var isClosed = latlngs.length > 2 &&
          latlngs[0][0] === latlngs[latlngs.length - 1][0] &&
          latlngs[0][1] === latlngs[latlngs.length - 1][1];

        // ── Buildings ──
        if (tags['building']) {
          L.polygon(latlngs, {
            color: '#c4996b', weight: 0.8,
            fillColor: '#d4b896', fillOpacity: 0.65,
          }).addTo(layerBuilding);
          continue;
        }

        // ── Highways ──
        var hw = tags['highway'];
        if (hw) {
          var isMaj = hw === 'motorway' || hw === 'trunk' ||
                      hw === 'primary' || hw === 'secondary';
          var clr =
            hw === 'motorway' || hw === 'trunk' ? '#e06020' :
            hw === 'primary'  ? '#e0a020' :
            hw === 'secondary'? '#e0c840' :
            hw === 'tertiary' || hw === 'residential' || hw === 'unclassified' ? '#cccccc' :
            hw === 'footway'  || hw === 'path' || hw === 'steps' ? '#aaaaaa' :
            hw === 'cycleway' ? '#4a90d9' : '#bbbbbb';
          var wt =
            hw === 'motorway' || hw === 'trunk' ? 5 :
            hw === 'primary'  ? 4 :
            hw === 'secondary'? 3 :
            hw === 'tertiary' || hw === 'residential' ? 2 : 1.2;
          L.polyline(latlngs, { color: clr, weight: wt })
            .addTo(isMaj ? layerRoadMaj : layerRoadMin);
          continue;
        }

        // ── Water ──
        var ww = tags['waterway'];
        var nat = tags['natural'];
        var lu  = tags['landuse'];
        if (ww || nat === 'water' || lu === 'reservoir' || lu === 'basin') {
          if (isClosed) {
            L.polygon(latlngs, {
              color: '#4a90d9', weight: 1,
              fillColor: '#a8d4f5', fillOpacity: 0.6,
            }).addTo(layerWater);
          } else {
            L.polyline(latlngs, { color: '#4a90d9', weight: 2 }).addTo(layerWater);
          }
          continue;
        }

        // ── Green areas ──
        var leisure = tags['leisure'];
        if (nat === 'wood' || nat === 'scrub' ||
            lu === 'forest' || lu === 'park' || lu === 'grass' || lu === 'meadow' ||
            leisure === 'park' || leisure === 'garden' || leisure === 'nature_reserve') {
          if (isClosed) {
            L.polygon(latlngs, {
              color: '#2d9a4e', weight: 0.5,
              fillColor: '#a8d8b0', fillOpacity: 0.45,
            }).addTo(layerGreen);
          }
          continue;
        }
      }

      // Add layers bottom-to-top
      layerGreen.addTo(map);
      layerWater.addTo(map);
      layerBuilding.addTo(map);
      layerRoadMin.addTo(map);
      layerRoadMaj.addTo(map);

      // Fit to content
      if (allCoords.length > 0) {
        map.fitBounds(allCoords, { padding: [24, 24] });
      }

    } catch (e) {
      notifyError('Error al renderizar el mapa OSM: ' + e.message);
    }
    hideOverlay();
  }

  // ── User location updates ─────────────────────────────────────────────────
  function handleRNMessage(raw) {
    try {
      var msg = JSON.parse(raw);
      if (msg.type === 'updateLocation') {
        userMarker.setLatLng([msg.lat, msg.lng]);
      }
      if (msg.type === 'goToMyLocation') {
        map.setView(userMarker.getLatLng(), map.getZoom(), { animate: true });
      }
    } catch (e) {}
  }
  document.addEventListener('message', function (e) { handleRNMessage(e.data); });
  window.addEventListener('message',   function (e) { handleRNMessage(e.data); });

  function hideOverlay() {
    var el = document.getElementById('overlay');
    if (el) el.classList.add('hidden');
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
  }

  function notifyError(msg) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', msg: msg }));
  }
</script>
</body>
</html>`;
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function VerMapaOfflineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { maps } = useSavedMaps();
  const webViewRef = useRef<WebView>(null);

  const map = maps.find((m) => m.id === id);

  const [mapHtml, setMapHtml] = useState<string | null>(null);
  const [locating, setLocating] = useState(true);
  const [userCoord, setUserCoord] = useState<{ lat: number; lng: number } | null>(null);
  const [webViewLoaded, setWebViewLoaded] = useState(false);
  const [sendingData, setSendingData] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  // fileContent is stored in a ref so we can access it when webViewLoaded flips
  const fileContentRef = useRef<string | null>(null);

  // ── GPS ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      const defaultLat = -34.6037;
      const defaultLng = -58.3816;

      if (status !== 'granted') {
        setMapHtml(buildBaseHtml(defaultLat, defaultLng));
        setLocating(false);
        return;
      }

      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      }).catch(() => null);

      const lat = loc?.coords.latitude ?? defaultLat;
      const lng = loc?.coords.longitude ?? defaultLng;
      setUserCoord({ lat, lng });
      setMapHtml(buildBaseHtml(lat, lng));
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

  // ── Read file ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!map) return;
    (async () => {
      try {
        let content: string;
        if (isSafUri(map.filePath)) {
          content = await FileSystem.StorageAccessFramework.readAsStringAsync(map.filePath);
        } else {
          content = await FileSystem.readAsStringAsync(map.filePath);
        }
        fileContentRef.current = content;
        // If WebView is already loaded, send data immediately
        if (webViewLoaded) {
          sendToWebView(content);
        }
      } catch (e) {
        setRenderError('No se pudo leer el archivo del mapa.');
      }
    })();
  }, [map?.id]);

  // ── Send data to WebView once both are ready ──────────────────────────────

  useEffect(() => {
    if (webViewLoaded && fileContentRef.current && !sendingData) {
      sendToWebView(fileContentRef.current);
    }
  }, [webViewLoaded]);

  /** Sends file content to WebView in chunks via injectJavaScript */
  async function sendToWebView(content: string) {
    setSendingData(true);
    const totalChunks = Math.ceil(content.length / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const chunk = content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const isLast = i === totalChunks - 1;
      webViewRef.current?.injectJavaScript(
        `receiveChunk(${JSON.stringify(chunk)}, ${i}, ${totalChunks}, ${isLast});true;`,
      );
      // Yield between chunks so the WebView JS thread can process
      await new Promise<void>((r) => setTimeout(r, 8));
    }
    setSendingData(false);
  }

  // ── WebView message handler ───────────────────────────────────────────────

  function handleMessage(event: { nativeEvent: { data: string } }) {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'error') {
        setRenderError(msg.msg ?? 'Error desconocido al renderizar.');
      }
    } catch { /* ignore */ }
  }

  function handleMyLocation() {
    if (!userCoord) return;
    webViewRef.current?.injectJavaScript(
      `handleRNMessage(${JSON.stringify(JSON.stringify({ type: 'goToMyLocation' }))});true;`,
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (!map) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Mapa no encontrado.</Text>
        <Pressable onPress={() => router.back()} style={styles.backBtnFallback}>
          <Text style={styles.backBtnFallbackText}>Volver</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {locating || !mapHtml ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Obteniendo ubicación…</Text>
        </View>
      ) : (
        <WebView
          ref={webViewRef}
          source={{ html: mapHtml }}
          style={styles.map}
          onMessage={handleMessage}
          onLoad={() => setWebViewLoaded(true)}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          allowUniversalAccessFromFileURLs
          allowFileAccess
        />
      )}

      {/* Floating header */}
      <View style={[styles.header, { top: insets.top + 12 }]} pointerEvents="box-none">
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>←</Text>
        </Pressable>
        <View style={styles.titlePill}>
          <Text style={styles.titleText} numberOfLines={1}>{map.name}</Text>
        </View>
        {userCoord && (
          <Pressable style={styles.locationBtn} onPress={handleMyLocation}>
            <Text style={styles.locationBtnText}>📍</Text>
          </Pressable>
        )}
      </View>

      {/* Render error overlay */}
      {renderError && (
        <View style={[styles.errorBanner, { top: insets.top + 64 }]}>
          <Text style={styles.errorBannerText}>⚠️ {renderError}</Text>
        </View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f' },
  map: { flex: 1 },

  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    backgroundColor: '#0a0a0f',
  },
  loadingText: { color: 'rgba(255,255,255,0.5)', fontSize: 15 },
  errorText: { color: 'rgba(255,255,255,0.6)', fontSize: 16, textAlign: 'center' },

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
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center', alignItems: 'center',
  },
  backText: {position: "absolute", color: '#fff', fontSize: 20, fontWeight: '500', bottom: 10 },
  titlePill: {
    flex: 1,
    backgroundColor: 'rgba(10,10,20,0.75)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 21,
  },
  titleText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  locationBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(10,10,20,0.75)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center', alignItems: 'center',
  },
  locationBtnText: { fontSize: 18 },

  // Error banner
  errorBanner: {
    position: 'absolute',
    left: 16, right: 16,
    backgroundColor: 'rgba(255,59,48,0.9)',
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
  },
  errorBannerText: { color: '#fff', fontSize: 13, fontWeight: '500' },

  // Fallback
  backBtnFallback: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12,
  },
  backBtnFallbackText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
