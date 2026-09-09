import { object } from '../parsers/course';
import { AppError } from './errors';
export const RESOLUTIONS = ['1080p', '720p', '360p', '240p'] as const;
export const VIDEO_FORMATS = ['webm', 'mp4'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export type VideoFormat = (typeof VIDEO_FORMATS)[number];
export function videoOptions(value: unknown): {
  includeVideos: boolean;
  videoResolution: Resolution;
  videoFormat: VideoFormat;
} {
  const input = object(value);
  const videoResolution = RESOLUTIONS.find(
    (value) => value === (input.videoResolution ?? '360p'),
  );
  const videoFormat = VIDEO_FORMATS.find(
    (value) => value === (input.videoFormat ?? 'mp4'),
  );
  if (!videoResolution || !videoFormat) {
    throw new AppError(
      'INVALID_VIDEO_OPTIONS',
      'Choose a valid video resolution and format.',
    );
  }
  return {
    includeVideos: input.includeVideos === true,
    videoResolution,
    videoFormat,
  };
}
