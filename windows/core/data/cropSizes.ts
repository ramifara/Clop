import type { CropSize } from '../settings/schema';

// DEFAULT_CROP_SIZES and DEFAULT_CROP_ASPECT_RATIOS from Clop/Settings.swift, and CropSizeGroup from Shared/CropSize.swift.
export interface Size { width: number; height: number }
/** Devices or paper sizes sharing one aspect ratio, so cropping to any member gives the same result. */
export interface CropSizeGroup { name: string; width: number; height: number; members: string[]; summary?: string }

const size = (width: number, height: number, name: string): CropSize => ({ width, height, name, longEdge: false, smartCrop: false });
const ratio = (width: number, height: number, name: string): CropSize => ({ ...size(width, height, name), isAspectRatio: true });

/** The default of the `savedCropSizes` setting. */
export const DEFAULT_CROP_SIZES: readonly CropSize[] = [
  size(1920, 1080, '1080p'), size(1280, 720, '720p'), size(1440, 900, 'Mac App Store'), size(1200, 630, 'OpenGraph'),
  size(1600, 900, 'Twitter'), size(128, 128, 'Small Square'), size(512, 512, 'Medium Square'), size(1024, 1024, 'Large Square'),
];

/** The aspect ratios the crop window and batch crop offer. */
export const DEFAULT_CROP_ASPECT_RATIOS: readonly CropSize[] = [
  ratio(16, 9, '16:9'), ratio(4, 3, '4:3'), ratio(5, 3, '5:3'), ratio(5, 4, '5:4'), ratio(1618, 1000, 'φ:1'), ratio(16, 10, '16:10'), ratio(3, 2, '3:2'),
  ratio(1, 1, '1:1'), ratio(2, 1, '2:1'), ratio(210, 297, 'A4'), ratio(154, 100, '1.54:1'), ratio(6, 13, '6:13'), ratio(14, 9, '14:9'), ratio(32, 9, '32:9'), ratio(176, 250, 'B5'),
];

/** `CropSizeGroup.matches`: the group's own name or one of its members, case-insensitively. */
export function groupMatches(group: CropSizeGroup, name: string) {
  const needle = name.toLowerCase();
  return group.name.toLowerCase() === needle || group.members.some(member => member.toLowerCase() === needle);
}
