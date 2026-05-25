import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { GeoDataProvider } from '@/context/geo-data-context';
import { SavedMapsProvider } from '@/context/saved-maps-context';

export default function RootLayout() {
  return (
    <GeoDataProvider>
      <SavedMapsProvider>
        <ThemeProvider value={DarkTheme}>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: '#0f0f18' },
              headerTintColor: '#ffffff',
              headerShadowVisible: false,
              headerTitleStyle: { color: '#ffffff', fontWeight: '600' },
              contentStyle: { backgroundColor: '#0a0a0f' },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="mapa" options={{ title: 'Mapa interactivo' }} />
            <Stack.Screen name="como-usar" options={{ title: 'Cómo usar' }} />
            <Stack.Screen name="ar" options={{ headerShown: false }} />
            <Stack.Screen name="mark-point" options={{ headerShown: false }} />
            <Stack.Screen name="mis-mapas" options={{ title: 'Mis mapas' }} />
            <Stack.Screen name="descargar-mapa" options={{ headerShown: false }} />
            <Stack.Screen name="ver-mapa-offline" options={{ headerShown: false }} />
            <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
          </Stack>
          <StatusBar style="light" />
        </ThemeProvider>
      </SavedMapsProvider>
    </GeoDataProvider>
  );
}
