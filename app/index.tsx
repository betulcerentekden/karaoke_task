import { Asset } from "expo-asset";
import {
  AudioQuality,
  IOSOutputFormat,
  createAudioPlayer,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type AudioStatus,
  type RecordingOptions,
} from "expo-audio";
import {
  copyAsync,
  deleteAsync,
  documentDirectory,
  getInfoAsync,
  makeDirectoryAsync,
  readAsStringAsync,
  readDirectoryAsync,
} from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { exportVokalSadeMicOnly } from "@/handler/cleanVocalWithReference";
import { mixCleanVocalWithSong } from "@/handler/mixVocalWithSong";
import type { SrtCue } from "@/types/srt";

import lyricsAsset from "./assets/lyrics.srt";
import songAsset from "./assets/song.mp3";

const KARAOKE_RECORDING_OPTIONS: RecordingOptions = {
  isMeteringEnabled: false,
  extension: ".m4a",
  sampleRate: 44100,
  numberOfChannels: 2,
  bitRate: 192000,
  android: {
    extension: ".m4a",
    outputFormat: "mpeg4",
    audioEncoder: "aac",
    sampleRate: 44100,
    audioSource: "default",
  },
  ios: {
    extension: ".wav",
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.HIGH,
    sampleRate: 44100,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};

function getRecordingsDir(): string {
  const base = documentDirectory ?? "";
  return `${base}karaoke_recordings/`;
}

async function ensureRecordingsDir(): Promise<void> {
  const dir = getRecordingsDir();
  const info = await getInfoAsync(dir);
  if (!info.exists) {
    await makeDirectoryAsync(dir, { intermediates: true });
  }
}

async function listRecordingFiles(): Promise<string[]> {
  const dir = getRecordingsDir();
  const info = await getInfoAsync(dir);
  if (!info.exists) return [];
  const names = await readDirectoryAsync(dir);
  return names
    .filter((n) => n.endsWith(".wav") || n.endsWith(".m4a"))
    .sort((a, b) => a.localeCompare(b));
}

async function setSessionAudioMode(kind: "record" | "playback"): Promise<void> {
  await setAudioModeAsync(
    kind === "record"
      ? {
          allowsRecording: true,
          playsInSilentMode: true,
          interruptionMode: "doNotMix",
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: true,
        }
      : {
          allowsRecording: false,
          playsInSilentMode: true,
          interruptionMode: "mixWithOthers",
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
        },
  );
}

const RECORDING_PIPELINE_PREFACE_MS =
  Platform.select({ android: 980, ios: 140, default: 400 }) ?? 400;
const PLAY_RECORD_FINE_MS =
  Platform.select({ android: 45, ios: 32, default: 38 }) ?? 38;

const MAX_ALIGN_MS = 1800;

// Platform düzeltmesi + ~500 ms vokal öne alma (mik kesimi). 
const EXTRA_MIC_TRIM_MS =
  (Platform.select({ android: 220, ios: 90, default: 150 }) ?? 150) + 500;

function clampSyncLeadMs(raw: number): number {
  if (Number.isNaN(raw)) return 0;
  return Math.max(-MAX_ALIGN_MS, Math.min(MAX_ALIGN_MS, Math.round(raw)));
}

function sessionStartTrimMs(measuredLeadMs: number): number {
  const m = clampSyncLeadMs(measuredLeadMs);
  return clampSyncLeadMs(
    RECORDING_PIPELINE_PREFACE_MS + PLAY_RECORD_FINE_MS + m,
  );
}

function parseTimestamp(part: string): number {
  const t = part.trim();
  const m = t.match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4]);
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
}

function parseSrt(raw: string): SrtCue[] {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n\n+/);
  const cues: SrtCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim());
    if (lines.length < 2) continue;

    let i = 0;
    if (/^\d+$/.test(lines[0])) i = 1;
    const timeLine = lines[i];
    const arrow = timeLine.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/,
    );
    if (!arrow) continue;

    const startMs = parseTimestamp(arrow[1]);
    const endMs = parseTimestamp(arrow[2]);
    const textLines = lines.slice(i + 1).filter(Boolean);
    if (textLines.length === 0) continue;

    cues.push({
      index: cues.length + 1,
      startMs,
      endMs,
      text: textLines.join("\n"),
    });
  }

  return cues.sort((a, b) => a.startMs - b.startMs);
}

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type AudioPlayerRef = ReturnType<typeof createAudioPlayer> | null;

type RefBox<T> = { current: T };

function releaseAudioPlayer(
  subRef: RefBox<{ remove: () => void } | null>,
  playerRef: RefBox<AudioPlayerRef>,
): void {
  if (subRef.current) {
    try {
      subRef.current.remove();
    } catch {}
    subRef.current = null;
  }
  const p = playerRef.current;
  if (p) {
    try {
      p.pause();
      p.remove();
    } catch {}
    playerRef.current = null;
  }
}

async function loadBundledSrt(): Promise<string> {
  const asset = Asset.fromModule(lyricsAsset);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  return readAsStringAsync(uri);
}

export default function Index() {
  const karaokeRecorder = useAudioRecorder(KARAOKE_RECORDING_OPTIONS);

  const [micGranted, setMicGranted] = useState<boolean | null>(null);
  const [cues, setCues] = useState<SrtCue[]>([]);
  const [lyricsLoading, setLyricsLoading] = useState(true);

  const [sessionRunning, setSessionRunning] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);

  const [recordings, setRecordings] = useState<string[]>([]);
  const [previewFileName, setPreviewFileName] = useState<string | null>(null);
  const [previewPositionMs, setPreviewPositionMs] = useState(0);
  const [previewDurationMs, setPreviewDurationMs] = useState(0);
  const [lyricsViewportH, setLyricsViewportH] = useState(280);
  const [savingRecording, setSavingRecording] = useState(false);

  const songPlayerRef = useRef<ReturnType<typeof createAudioPlayer> | null>(
    null,
  );
  const songPlaybackSubRef = useRef<{ remove: () => void } | null>(null);
  const previewPlayerRef = useRef<ReturnType<typeof createAudioPlayer> | null>(
    null,
  );
  const previewPlaybackSubRef = useRef<{ remove: () => void } | null>(null);

  const releaseSongPlayer = useCallback(() => {
    releaseAudioPlayer(songPlaybackSubRef, songPlayerRef);
  }, []);

  const releasePreviewPlayer = useCallback(() => {
    releaseAudioPlayer(previewPlaybackSubRef, previewPlayerRef);
  }, []);
  
  const finishingRef = useRef(false);
  const karaokePlaybackLeadMsRef = useRef(0);
  const lyricsScrollRef = useRef<ScrollView | null>(null);
  const lyricRowHeightsRef = useRef<number[]>([]);
  const previewScrubbingRef = useRef(false);
  const previewSeekBarWidthRef = useRef(0);
  const previewDurationRef = useRef(0);
  const scrubPreviewToXRef = useRef<(x: number) => void>(() => {});

  useEffect(() => {
    previewDurationRef.current = previewDurationMs;
  }, [previewDurationMs]);

  const previewSeekPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => previewFileName !== null,
        onMoveShouldSetPanResponder: () => previewFileName !== null,
        onPanResponderGrant: (e) => {
          previewScrubbingRef.current = true;
          scrubPreviewToXRef.current(e.nativeEvent.locationX);
        },
        onPanResponderMove: (e) => {
          scrubPreviewToXRef.current(e.nativeEvent.locationX);
        },
        onPanResponderRelease: () => {
          previewScrubbingRef.current = false;
        },
        onPanResponderTerminate: () => {
          previewScrubbingRef.current = false;
        },
      }),
    [previewFileName],
  );

  const { activeCue, activeCueIndex } = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (positionMs >= c.startMs && positionMs <= c.endMs) {
        idx = i;
        break;
      }
    }
    return {
      activeCue: idx >= 0 ? cues[idx]! : null,
      activeCueIndex: idx,
    };
  }, [cues, positionMs]);

  const scrollActiveLyricToCenter = useCallback(
    (animated: boolean) => {
      const scroll = lyricsScrollRef.current;
      if (!scroll || activeCueIndex < 0 || cues.length === 0) return;

      let offsetBefore = 0;
      const heights = lyricRowHeightsRef.current;
      for (let i = 0; i < activeCueIndex; i++) {
        offsetBefore += heights[i] ?? 80;
      }
      const h = heights[activeCueIndex] ?? 80;
      const target = Math.max(0, offsetBefore + h / 2);

      scroll.scrollTo({ y: target, animated });
    },
    [activeCueIndex, cues.length],
  );

  useEffect(() => {
    lyricRowHeightsRef.current = [];
  }, [cues]);

  useEffect(() => {
    if (activeCueIndex < 0 || cues.length === 0) return;
    requestAnimationFrame(() => scrollActiveLyricToCenter(true));
  }, [activeCueIndex, cues.length, lyricsViewportH, scrollActiveLyricToCenter]);

  const refreshRecordings = useCallback(async () => {
    const list = await listRecordingFiles();
    setRecordings(list);
  }, []);

  useEffect(() => {
    void (async () => {
      const perm = await getRecordingPermissionsAsync();
      setMicGranted(perm.granted);
      if (!perm.granted) {
        const req = await requestRecordingPermissionsAsync();
        setMicGranted(req.granted);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const raw = await loadBundledSrt();
        setCues(parseSrt(raw));
      } catch {
        setCues([]);
      } finally {
        setLyricsLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    void refreshRecordings();
  }, [refreshRecordings]);

  useEffect(() => {
    return () => {
      releaseSongPlayer();
      releasePreviewPlayer();
      void (async () => {
        try {
          if (karaokeRecorder.isRecording) await karaokeRecorder.stop();
        } catch {}
      })();
    };
  }, [karaokeRecorder, releaseSongPlayer, releasePreviewPlayer]);

  const cleanupAfterSession = useCallback(async () => {
    releaseSongPlayer();
    try {
      if (karaokeRecorder.isRecording) {
        await karaokeRecorder.stop();
      }
    } catch {}
    setSessionRunning(false);
    setPositionMs(0);
    setDurationMs(0);
    await setSessionAudioMode("playback");
  }, [karaokeRecorder, releaseSongPlayer]);

  const saveRecordingAfterSession = useCallback(
    async (tempUri: string | null) => {
      if (!tempUri) {
        await cleanupAfterSession();
        return;
      }

      let perm = await getRecordingPermissionsAsync();
      if (!perm.granted) {
        perm = await requestRecordingPermissionsAsync();
        setMicGranted(perm.granted);
      }
      if (!perm.granted) {
        Alert.alert(
          "Kayıt kaydedilemiyor",
          "Mikrofon izni verilmediği için kayıt dosyası kaydedilemiyor.",
        );
        try {
          await deleteAsync(tempUri, { idempotent: true });
        } catch {}
        await cleanupAfterSession();
        return;
      }

      setSavingRecording(true);
      const ts = Date.now();
      try {
        await ensureRecordingsDir();
        const extMatch = tempUri.match(/\.[^./]+$/);
        const ext = extMatch ? extMatch[0] : ".wav";
        const songAssetInst = Asset.fromModule(songAsset);
        await songAssetInst.downloadAsync();
        const songSrc = songAssetInst.localUri ?? songAssetInst.uri;
        if (!songSrc) {
          throw new Error("Enstrüman dosyası yüklenemedi.");
        }
        const vocalSoloDest = `${getRecordingsDir()}vokal_sade_${ts}.wav`;
        const karaokeMixDest = `${getRecordingsDir()}karaoke_${ts}.wav`;
        const trimMs = sessionStartTrimMs(karaokePlaybackLeadMsRef.current);
        const micTrimMs = Math.max(0, trimMs + EXTRA_MIC_TRIM_MS);

        const cleaned = await exportVokalSadeMicOnly({
          micUri: tempUri,
          outUri: vocalSoloDest,
          playbackLeadMs: micTrimMs,
        });

        const vokalSadeFromPipeline = cleaned.ok;

        if (!cleaned.ok) {
          const fallbackSolo = `${getRecordingsDir()}vokal_sade_${ts}${ext}`;
          await copyAsync({ from: tempUri, to: fallbackSolo });
          Alert.alert(
            "Bilgi",
            "Ham mikrofon kaydı saklandı; karaoke mix oluşturulmadı (önce vokal_sade üretilemedi).",
          );
        }

        if (vokalSadeFromPipeline) {
          await new Promise<void>((r) => setTimeout(r, 220));
          const mixed = await mixCleanVocalWithSong({
            vocalUri: vocalSoloDest,
            songUri: songSrc,
            outUri: karaokeMixDest,
            playbackLeadMs: trimMs,
          });
          if (!mixed.ok) {
            Alert.alert(
              "Kısmi kayıt",
              "vokal_sade hazır; şarkı ile karaoke mix oluşturulamadı.",
            );
          }
        }
        await refreshRecordings();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Kayıt kaydedilemedi.";
        Alert.alert("Hata", msg);
      } finally {
        try {
          await deleteAsync(tempUri, { idempotent: true });
        } catch {}
        try {
          await cleanupAfterSession();
        } catch {}
        setSavingRecording(false);
      }
    },
    [cleanupAfterSession, refreshRecordings],
  );

  const finishSession = useCallback(async () => {
    if (finishingRef.current) return;
    finishingRef.current = true;

    let tempUri: string | null = null;

    try {
      releaseSongPlayer();

      if (karaokeRecorder.isRecording) {
        try {
          await karaokeRecorder.stop();
        } catch {}
      }

      tempUri = karaokeRecorder.uri ?? karaokeRecorder.getStatus().url ?? null;

      setSessionRunning(false);
      await setSessionAudioMode("playback");

      await saveRecordingAfterSession(tempUri);
    } finally {
      finishingRef.current = false;
    }
  }, [karaokeRecorder, saveRecordingAfterSession, releaseSongPlayer]);

  const onPlaybackStatusUpdate = useCallback(
    (status: AudioStatus) => {
      if (!status.isLoaded) return;
      setPositionMs(status.currentTime * 1000);
      setDurationMs(status.duration * 1000);
      if (status.didJustFinish) {
        void finishSession();
      }
    },
    [finishSession],
  );

  const onPreviewPlaybackStatusUpdate = useCallback(
    (status: AudioStatus) => {
      if (!status.isLoaded) return;
      if (status.didJustFinish) {
        releasePreviewPlayer();
        setPreviewFileName(null);
        setPreviewPositionMs(0);
        setPreviewDurationMs(0);
        return;
      }
      if (!previewScrubbingRef.current) {
        setPreviewPositionMs(status.currentTime * 1000);
      }
      setPreviewDurationMs(status.duration * 1000);
    },
    [releasePreviewPlayer],
  );

  const startKaraoke = useCallback(async () => {
    const perm = await getRecordingPermissionsAsync();
    if (!perm.granted) {
      const req = await requestRecordingPermissionsAsync();
      setMicGranted(req.granted);
      if (!req.granted) {
        Alert.alert(
          "İzin gerekli",
          "Kayıt için mikrofon iznini ayarlardan açmanız gerekir.",
        );
        return;
      }
    }

    releasePreviewPlayer();
    setPreviewFileName(null);
    setPreviewPositionMs(0);
    setPreviewDurationMs(0);

    try {
      await setSessionAudioMode("record");

      await karaokeRecorder.prepareToRecordAsync();

      const player = createAudioPlayer(songAsset, { updateInterval: 120 });
      songPlayerRef.current = player;
      songPlaybackSubRef.current = player.addListener(
        "playbackStatusUpdate",
        onPlaybackStatusUpdate,
      );

      const playT = performance.now();
      player.play();
      karaokeRecorder.record();
      const recT = performance.now();
      karaokePlaybackLeadMsRef.current = clampSyncLeadMs(recT - playT);

      setSessionRunning(true);
    } catch (e) {
      await cleanupAfterSession();
      const msg = e instanceof Error ? e.message : "Bilinmeyen hata";
      Alert.alert("Başlatılamadı", msg);
    }
  }, [
    cleanupAfterSession,
    karaokeRecorder,
    onPlaybackStatusUpdate,
    releasePreviewPlayer,
  ]);

  const playRecording = useCallback(
    async (fileName: string) => {
      await setSessionAudioMode("playback");
      const uri = `${getRecordingsDir()}${fileName}`;

      releasePreviewPlayer();

      setPreviewFileName(null);
      setPreviewPositionMs(0);
      setPreviewDurationMs(0);

      try {
        const player = createAudioPlayer({ uri }, { updateInterval: 100 });
        previewPlayerRef.current = player;
        previewPlaybackSubRef.current = player.addListener(
          "playbackStatusUpdate",
          onPreviewPlaybackStatusUpdate,
        );
        player.play();
        setPreviewFileName(fileName);
      } catch {
        Alert.alert("Hata", "Kayıt oynatılamadı.");
      }
    },
    [onPreviewPlaybackStatusUpdate, releasePreviewPlayer],
  );

  const shareKaraokeRecording = useCallback(async (fileName: string) => {
    try {
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert(
          "Paylaşım",
          "Bu cihazda dosya paylaşımı kullanılamıyor.",
        );
        return;
      }
      const uri = `${getRecordingsDir()}${fileName}`;
      await Sharing.shareAsync(uri, {
        mimeType: "audio/wav",
        UTI: "com.microsoft.waveform-audio",
        dialogTitle: "Karaoke kaydını paylaş",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Paylaşılamadı.";
      Alert.alert("Hata", msg);
    }
  }, []);

  const stopPreview = useCallback(() => {
    releasePreviewPlayer();
    setPreviewFileName(null);
    setPreviewPositionMs(0);
    setPreviewDurationMs(0);
  }, [releasePreviewPlayer]);

  const skipPreviewMs = useCallback(async (deltaMs: number) => {
    const player = previewPlayerRef.current;
    if (!player || !player.isLoaded) return;
    try {
      const durSec = player.duration;
      if (durSec <= 0) return;
      const durMs = durSec * 1000;
      const posMs = player.currentTime * 1000;
      const next = Math.max(0, Math.min(durMs, posMs + deltaMs));
      setPreviewPositionMs(next);
      await player.seekTo(next / 1000);
    } catch {}
  }, []);

  scrubPreviewToXRef.current = (locationX: number) => {
    const w = previewSeekBarWidthRef.current;
    const dur = previewDurationRef.current;
    const player = previewPlayerRef.current;
    if (w <= 0 || dur <= 0 || !player) return;
    const ratio = Math.max(0, Math.min(1, locationX / w));
    const ms = ratio * dur;
    setPreviewPositionMs(ms);
    void player.seekTo(ms / 1000);
  };

  return (
    <>
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.title}>Eterna Karaoke</Text>

          {micGranted === false ? (
            <Text style={styles.warn}>
              Mikrofon izni kapalı. Kayıt için ayarlardan izin verin.
            </Text>
          ) : null}

          {lyricsLoading ? (
            <ActivityIndicator size="large" />
          ) : (
            <View
              style={styles.lyricsBox}
              onLayout={(e) => {
                setLyricsViewportH(e.nativeEvent.layout.height);
              }}
            >
              <ScrollView
                ref={lyricsScrollRef}
                style={styles.lyricsScroll}
                scrollEnabled
                showsVerticalScrollIndicator={false}
                contentContainerStyle={[
                  styles.lyricsContent,
                  { paddingVertical: lyricsViewportH / 2 },
                ]}
                onContentSizeChange={() => {
                  requestAnimationFrame(() => scrollActiveLyricToCenter(false));
                }}
              >
                {cues.map((item, index) => {
                  const isActive = activeCue?.index === item.index;
                  return (
                    <View
                      key={`${item.index}-${item.startMs}`}
                      onLayout={(ev) => {
                        lyricRowHeightsRef.current[index] =
                          ev.nativeEvent.layout.height;
                      }}
                    >
                      <Text
                        style={[styles.line, isActive && styles.lineActive]}
                      >
                        {item.text}
                      </Text>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          )}

          {sessionRunning ? (
            <View style={styles.row}>
              <Text style={styles.time}>
                {formatClock(positionMs)} / {formatClock(durationMs || 0)}
              </Text>
            </View>
          ) : null}

          <View style={styles.controls}>
            {!sessionRunning ? (
              <Pressable
                style={[styles.btn, styles.btnPrimary]}
                onPress={startKaraoke}
                disabled={lyricsLoading || micGranted === false}
              >
                <Text style={styles.btnText}>Başlat</Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.btn, styles.btnDanger]}
                onPress={() => void finishSession()}
              >
                <Text style={styles.btnText}>Durdur</Text>
              </Pressable>
            )}
          </View>

          {previewFileName ? (
            <View style={styles.previewPlayer}>
              <Text style={styles.previewFileLabel} numberOfLines={1}>
                {previewFileName}
              </Text>
              <View style={styles.previewSeekRow}>
                <Pressable
                  hitSlop={8}
                  style={styles.previewSkipBtn}
                  onPress={() => skipPreviewMs(-5000)}
                >
                  <Text style={styles.previewSkipText}>−5s</Text>
                </Pressable>
                <View
                  style={styles.previewSeekTrack}
                  onLayout={(e) => {
                    previewSeekBarWidthRef.current = e.nativeEvent.layout.width;
                  }}
                  {...previewSeekPanResponder.panHandlers}
                >
                  <View
                    style={[
                      styles.previewSeekFill,
                      {
                        width:
                          previewDurationMs > 0
                            ? `${Math.min(
                                100,
                                (previewPositionMs / previewDurationMs) * 100,
                              )}%`
                            : "0%",
                      },
                    ]}
                  />
                </View>
                <Pressable
                  hitSlop={8}
                  style={styles.previewSkipBtn}
                  onPress={() => skipPreviewMs(5000)}
                >
                  <Text style={styles.previewSkipText}>+5s</Text>
                </Pressable>
              </View>
              <Text style={styles.previewTime}>
                {formatClock(previewPositionMs)} /{" "}
                {formatClock(previewDurationMs)}
              </Text>
              <View style={styles.previewControls}>
                <Pressable
                  style={[styles.btnSmall, styles.btnPreviewStop]}
                  onPress={stopPreview}
                >
                  <Text style={styles.btnSmallText}>Durdur</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <Text style={styles.sectionTitle}>Kayıtlarım</Text>
          {recordings.length === 0 ? (
            <Text style={styles.muted}>Henüz kayıtlı vokal yok.</Text>
          ) : (
            recordings.map((name) => (
              <View key={name} style={styles.recRow}>
                <Text style={styles.recName} numberOfLines={1}>
                  {name}
                </Text>
                <View style={styles.recActions}>
                  {name.startsWith("karaoke_") ? (
                    <Pressable
                      style={[styles.btnSmall, styles.btnShare]}
                      onPress={() => void shareKaraokeRecording(name)}
                    >
                      <Text style={styles.btnSmallText}>Paylaş</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    style={styles.btnSmall}
                    onPress={() => playRecording(name)}
                  >
                    <Text style={styles.btnSmallText}>Oynat</Text>
                  </Pressable>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      </SafeAreaView>

      <Modal
        visible={savingRecording}
        transparent
        animationType="fade"
        statusBarTranslucent
      >
        <View style={styles.savingBackdrop}>
          <ActivityIndicator size="large" color="#e8e8f0" />
          <Text style={styles.savingLabel}>Kaydediliyor…</Text>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  safe: { 
    flex: 1, 
    backgroundColor: "#0b0b10" 
  },
  scroll: {
    padding: 16,
    paddingBottom: 32,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#f4f4f8",
    marginBottom: 12,
  },
  warn: { 
    color: "#ffb4b4", 
    marginBottom: 12, 
    fontSize: 14 
  },
  lyricsBox: {
    minHeight: 220,
    maxHeight: 320,
    borderRadius: 12,
    backgroundColor: "#15151c",
    marginBottom: 12,
  },
  lyricsScroll: { 
    flexGrow: 0 
  },
  lyricsContent: {
    paddingHorizontal: 16,
  },
  line: {
    color: "#6a6a78",
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
    textAlign: "center",
  },
  lineActive: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 26,
    lineHeight: 34,
    marginBottom: 16,
  },
  row: { 
    marginBottom: 8 
  },
  time: { 
    color: "#c8c8d4", 
    fontSize: 14 
  },
  controls: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
    marginBottom: 24,
    flexWrap: "wrap",
  },
  btn: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: "#2a2a36",
    minWidth: 120,
    alignItems: "center",
  },
  btnPrimary: { 
    backgroundColor: "#5b6cff" 
  },
  btnDanger: { 
    backgroundColor: "#c44b4b" 
  },
  btnText: { 
    color: "#fff", 
    fontSize: 16, 
    fontWeight: "600" 
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: "#e8e8f0",
    marginBottom: 8,
  },
  muted: { 
    color: "#6a6a78", 
    marginBottom: 8 
  },
  recRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2a2a36",
  },
  recName: { 
    flex: 1,
    color: "#d0d0dc", 
    marginRight: 12, 
    fontSize: 14 
  },
  recActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  btnShare: {
    backgroundColor: "#3d4a7a",
  },
  btnSmall: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#3a3a4a",
  },
  btnSmallText: { 
    color: "#fff", 
    fontWeight: "600" 
  },
  previewPlayer: {
    marginBottom: 16,
    padding: 14,
    borderRadius: 12,
    backgroundColor: "#15151c",
    gap: 10,
  },
  previewFileLabel: {
    color: "#c8c8d4",
    fontSize: 13,
    marginBottom: 4,
  },
  previewSeekRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  previewSkipBtn: {
    paddingVertical: 6,
    paddingHorizontal: 4,
    minWidth: 40,
    alignItems: "center",
  },
  previewSkipText: {
    color: "#9b9bb8",
    fontSize: 13,
    fontWeight: "600",
  },
  previewSeekTrack: {
    flex: 1,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#2a2a38",
    overflow: "hidden",
    justifyContent: "center",
  },
  previewSeekFill: {
    height: 10,
    borderRadius: 5,
    backgroundColor: "#5b6cff",
  },
  previewTime: {
    color: "#a0a0b0",
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  previewControls: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },
  btnPreviewStop: {
    backgroundColor: "#5a3a3a",
  },
  savingBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  savingLabel: {
    marginTop: 16,
    fontSize: 16,
    color: "#e8e8f0",
    fontWeight: "600",
  },
});
