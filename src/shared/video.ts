import { AppError } from "./errors";
import type { Options } from "./types";
export const RESOLUTIONS = ["1080p", "720p", "360p", "240p"] as const;
export const VIDEO_FORMATS = ["webm", "mp4"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export type VideoFormat = (typeof VIDEO_FORMATS)[number];
export function videoOptions(input: Partial<Options>): {
  includeVideos: boolean;
  videoResolution: Resolution;
  videoFormat: VideoFormat;
} {
  const videoResolution = input.videoResolution ?? "360p";
  const videoFormat = input.videoFormat ?? "mp4";
  if (
    !(RESOLUTIONS as readonly string[]).includes(videoResolution) ||
    !(VIDEO_FORMATS as readonly string[]).includes(videoFormat)
  ) {
    throw new AppError(
      "INVALID_VIDEO_OPTIONS",
      "请选择有效的视频分辨率和格式。",
    );
  }
  return {
    includeVideos: input.includeVideos === true,
    videoResolution,
    videoFormat,
  };
}
