import { FFmpegKit, ReturnCode } from "ffmpeg-kit-react-native";

function stripFileScheme(uri: string): string {
  if (uri.startsWith("file://")) {
    return uri.slice(7);
  }
  return uri;
}

export type MixResult = { ok: true } | { ok: false; message: string };

// Pan içinde enstrüman ağırlığı (c1); vokal c0. Toplam ~1. 
const PAN_VOX = 0.48;
const PAN_INST = 0.52;

export async function mixCleanVocalWithSong(params: {
  vocalUri: string;
  songUri: string;
  outUri: string;
  playbackLeadMs?: number;
}): Promise<MixResult> {
  const vocal = stripFileScheme(params.vocalUri);
  const song = stripFileScheme(params.songUri);
  const out = stripFileScheme(params.outUri);
  const lead = params.playbackLeadMs ?? 0;

  let songIn = "[1:a]";
  const pre: string[] = [];
  if (lead > 0) {
    const s = (lead / 1000).toFixed(4);
    pre.push(`[1:a]atrim=start=${s}[songtrim];`);
    songIn = "[songtrim]";
  }

  const voxBranch =
    `[0:a]aresample=48000,pan=mono|c0=c0,aformat=sample_fmts=fltp:channel_layouts=mono[vox];`;

  const filter = [
    ...pre,
    voxBranch,
    `${songIn}aresample=48000,pan=mono|c0=c0,aformat=sample_fmts=fltp:channel_layouts=mono[mus];`,
    `[vox][mus]amerge=inputs=2,pan=mono|c0=${PAN_VOX}*c0+${PAN_INST}*c1[am];`,
    "[am]alimiter=level_in=1:level_out=0.99[out]",
  ].join("");

  const args = ["-y", "-i", vocal, "-i", song, "-shortest", "-filter_complex", filter, "-map", "[out]", "-c:a", "pcm_s16le", "-f", "wav", out];

  try {
    const session = await FFmpegKit.executeWithArguments(args);
    const returnCode = await session.getReturnCode();
    if (ReturnCode.isSuccess(returnCode)) {
      return { ok: true };
    }
    const logs = await session.getAllLogsAsString(8000);
    return { ok: false, message: logs || "FFmpeg mix başarısız." };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
