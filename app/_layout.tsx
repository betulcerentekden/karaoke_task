// Kök düzen: güvenli alan sağlayıcı + yönlendirme yığını; tüm ekranlar bunun altında açılır.
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    // Çentik ve ev güvenli alanları için bağlam (alt/üst padding).
    <SafeAreaProvider>
      {/* Üst navigasyon çubuğunu gizle; ekran başlığı kendi içinde. */}
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
