## Kurulum

```bash
npm install
```

## Çalıştırma

Metro geliştirici sunucusu:

```bash
npx expo start
```

Yerel derleme (önerilen — FFmpeg ve kayıt için):

```bash
npm run android
# veya
npm run ios
```

Lint:

```bash
npm run lint
```

## Proje yapısı (özet)

| Yol | Açıklama |
|-----|----------|
| `app/index.tsx` | Ana ekran: sözler, başlat/durdur, kayıt listesi, önizleme |
| `app/_layout.tsx` | Kök düzen (Safe Area + Stack) |
| `app/assets/` | `lyrics.srt`, `song.mp3` |
| `handler/` | FFmpeg: `cleanVocalWithReference.ts`, `mixVocalWithSong.ts` |
| `types/` | Paylaşılan tipler (ör. SRT) |

Android uygulama kimliği: `com.eterna_karaoke` (`app.json`).

## Teknoloji

- **Expo Router** — dosya tabanlı yönlendirme  
- **expo-audio** — oynatma ve kayıt  
- **expo-file-system** — kayıt dosya yolları  
- **ffmpeg-kit-react-native** — vokal işleme ve karaoke mix  

## Lisans

Özel proje (`private: true`).
