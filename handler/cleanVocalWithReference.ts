import { FFmpegKit, ReturnCode } from "ffmpeg-kit-react-native";

function stripFileScheme(uri: string): string {
  if (uri.startsWith("file://")) {
    return uri.slice(7);
  }
  return uri;
}

export type CleanVocalResult =
  | { ok: true }
  | { ok: false; message: string };

const POST_MIC =
  "highpass=f=220,alimiter=level_in=1:level_out=0.92[out]";

export async function exportVokalSadeMicOnly(params: {
  micUri: string;
  outUri: string;
  playbackLeadMs?: number;
}): Promise<CleanVocalResult> {
  const mic = stripFileScheme(params.micUri);
  const out = stripFileScheme(params.outUri);
  const trimMs = params.playbackLeadMs ?? 0;

  let micIn = "[0:a]";
  const pre: string[] = [];
  if (trimMs > 0) {
    const s = (trimMs / 1000).toFixed(4);
    pre.push(`[0:a]atrim=start=${s}[mictrim];`);
    micIn = "[mictrim]";
  } else if (trimMs < 0) {
    const s = (-trimMs / 1000).toFixed(4);
    pre.push(`[0:a]atrim=start=${s}[mictrim];`);
    micIn = "[mictrim]";
  }

  const base = `${micIn}aresample=48000,pan=mono|c0=c0,aformat=sample_fmts=fltp:channel_layouts=mono[raw];`;
  const afterRaw = `[raw]${POST_MIC}`;

  const filter = [...pre, base, afterRaw].join("");

  const args = ["-y", "-i", mic, "-filter_complex", filter, "-map", "[out]", "-c:a", "pcm_s16le", "-f", "wav", out];

  try {
    const session = await FFmpegKit.executeWithArguments(args);
    const returnCode = await session.getReturnCode();
    if (ReturnCode.isSuccess(returnCode)) {
      return { ok: true };
    }
    const logs = await session.getAllLogsAsString(8000);
    return { ok: false, message: logs || "FFmpeg vokal_sade başarısız." };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
