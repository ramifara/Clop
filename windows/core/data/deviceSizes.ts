import { groupMatches, type CropSizeGroup, type Size } from './cropSizes';

// Port of Shared/DeviceSizes.swift: screen sizes in pixels, portrait, newest devices first.
const sizes = (table: Record<string, [number, number]>) => Object.fromEntries(Object.entries(table).map(([name, [width, height]]) => [name, { width, height }])) as Record<string, Size>;

/** Every device by name; the names are also the macOS `Device` enum's values. */
export const DEVICE_SIZES: Record<string, Size> = sizes({
  'iPhone 17 Pro Max': [1320, 2868], 'iPhone 17 Pro': [1206, 2622], 'iPhone 17': [1206, 2622], 'iPhone 17e': [1170, 2532], 'iPhone Air': [1260, 2736],
  'iPad Pro M5 13inch': [2064, 2752], 'iPad Pro M5 11inch': [1668, 2420], 'iPad Pro M4 13inch': [2064, 2752], 'iPad Pro M4 11inch': [1668, 2420],
  'iPad Air M4 13inch': [2048, 2732], 'iPad Air M4 11inch': [1640, 2360], 'iPad Air M3 13inch': [2048, 2732], 'iPad Air M3 11inch': [1640, 2360],
  'iPad Air M2 13inch': [2048, 2732], 'iPad Air M2 11inch': [1640, 2360], 'iPad 11': [1640, 2360], 'iPad mini 7': [1488, 2266], 'iPhone 16e': [1170, 2532],
  'iPhone 16 Pro Max': [1320, 2868], 'iPhone 16 Pro': [1206, 2622], 'iPhone 16 Plus': [1290, 2796], 'iPhone 16': [1179, 2556], 'iPhone 15 Pro Max': [1290, 2796],
  'iPhone 15 Pro': [1179, 2556], 'iPhone 15 Plus': [1290, 2796], 'iPhone 15': [1179, 2556], 'iPad Pro': [2064, 2752], 'iPad Pro 6 12.9inch': [2048, 2732],
  'iPad Pro 6 11inch': [1668, 2388], 'iPad': [1640, 2360], 'iPad 10': [1640, 2360], 'iPhone 14 Plus': [1284, 2778], 'iPhone 14 Pro Max': [1290, 2796],
  'iPhone 14 Pro': [1179, 2556], 'iPhone 14': [1170, 2532], 'iPhone SE 3': [750, 1334], 'iPad Air': [1640, 2360], 'iPad Air 5': [1640, 2360], 'iPhone 13': [1170, 2532],
  'iPhone 13 mini': [1080, 2340], 'iPhone 13 Pro Max': [1284, 2778], 'iPhone 13 Pro': [1170, 2532], 'iPad 9': [1620, 2160], 'iPad Pro 5 12.9inch': [2048, 2732],
  'iPad Pro 5 11inch': [1668, 2388], 'iPad Air 4': [1640, 2360], 'iPhone 12': [1170, 2532], 'iPhone 12 mini': [1080, 2340], 'iPhone 12 Pro Max': [1284, 2778],
  'iPhone 12 Pro': [1170, 2532], 'iPad 8': [1620, 2160], 'iPhone SE 2': [750, 1334], 'iPad Pro 4 12.9inch': [2048, 2732], 'iPad Pro 4 11inch': [1668, 2388],
  'iPad 7': [1620, 2160], 'iPhone 11 Pro Max': [1242, 2688], 'iPhone 11 Pro': [1125, 2436], 'iPhone 11': [828, 1792], 'iPod touch 7': [640, 1136], 'iPad mini': [1488, 2266],
  'iPad mini 6': [1488, 2266], 'iPad mini 5': [1536, 2048], 'iPad Air 3': [1668, 2224], 'iPad Pro 3 12.9inch': [2048, 2732], 'iPad Pro 3 11inch': [1668, 2388],
  'iPhone XR': [828, 1792], 'iPhone XS Max': [1242, 2688], 'iPhone XS': [1125, 2436], 'iPad 6': [1536, 2048], 'iPhone X': [1125, 2436], 'iPhone 8 Plus': [1080, 1920],
  'iPhone 8': [750, 1334], 'iPad Pro 2 12.9inch': [2048, 2732], 'iPad Pro 2 10.5inch': [1668, 2224], 'iPad 5': [1536, 2048], 'iPhone 7 Plus': [1080, 1920],
  'iPhone 7': [750, 1334], 'iPhone SE 1': [640, 1136], 'iPad Pro 1 9.7inch': [1536, 2048], 'iPad Pro 1 12.9inch': [2048, 2732], 'iPhone 6s Plus': [1080, 1920],
  'iPhone 6s': [750, 1334], 'iPad mini 4': [1536, 2048], 'iPod touch 6': [640, 1136], 'iPad Air 2': [1536, 2048], 'iPad mini 3': [1536, 2048], 'iPhone 6 Plus': [1080, 1920],
  'iPhone 6': [750, 1334], 'iPad mini 2': [1536, 2048], 'iPad mini 1': [768, 1024], 'iPad Air 1': [1536, 2048], 'iPhone 5C': [640, 1136], 'iPhone 5S': [640, 1136],
  'iPad 4': [1536, 2048], 'iPod touch 5': [640, 1136], 'iPhone 5': [640, 1136], 'iPad 3': [1536, 2048], 'iPhone 4S': [640, 960], 'iPad 2': [768, 1024],
  'iPod touch 4': [640, 960], 'iPhone 4': [640, 960],
});

const group = (name: string, width: number, height: number, members: string[], summary?: string): CropSizeGroup => ({ name, width, height, members, ...(summary ? { summary } : {}) });

/** iPhones sharing one exact screen aspect ratio, newest first: a crop to the group's ratio fills every member's screen. */
export const IPHONE_SIZE_GROUPS: CropSizeGroup[] = [
  group('iPhone 17 Pro Max & 16 Pro Max', 1320, 2868, ['iPhone 17 Pro Max', 'iPhone 16 Pro Max']),
  group('iPhone 17 & 16 Pro', 1206, 2622, ['iPhone 17 Pro', 'iPhone 17', 'iPhone 16 Pro']),
  group('iPhone Air', 1260, 2736, ['iPhone Air']),
  group('iPhone 16 & 15 & 14 Pro', 1179, 2556, ['iPhone 16', 'iPhone 15 Pro', 'iPhone 15', 'iPhone 14 Pro']),
  group('iPhone 16 Plus & 15 Pro Max', 1290, 2796, ['iPhone 16 Plus', 'iPhone 15 Pro Max', 'iPhone 15 Plus', 'iPhone 14 Pro Max']),
  group('iPhone 17e & 16e & 12–14', 1170, 2532, ['iPhone 17e', 'iPhone 16e', 'iPhone 14', 'iPhone 13 Pro', 'iPhone 13', 'iPhone 12 Pro', 'iPhone 12']),
  group('iPhone 14 Plus & 13 Pro Max', 1284, 2778, ['iPhone 14 Plus', 'iPhone 13 Pro Max', 'iPhone 12 Pro Max']),
  group('iPhone 13 & 12 mini', 1080, 2340, ['iPhone 13 mini', 'iPhone 12 mini']),
  group('iPhone 11 Pro & X & XS', 1125, 2436, ['iPhone 11 Pro', 'iPhone XS', 'iPhone X']),
  group('iPhone 11 & XR & Max', 1242, 2688, ['iPhone 11 Pro Max', 'iPhone 11', 'iPhone XS Max', 'iPhone XR']),
  group('iPhone Plus (16:9)', 1080, 1920, ['iPhone 8 Plus', 'iPhone 7 Plus', 'iPhone 6s Plus', 'iPhone 6 Plus']),
  group('iPhone 6–8 & SE', 750, 1334, ['iPhone SE 3', 'iPhone SE 2', 'iPhone 8', 'iPhone 7', 'iPhone 6s', 'iPhone 6']),
  group('iPhone 5 & SE 1', 640, 1136, ['iPhone SE 1', 'iPhone 5S', 'iPhone 5C', 'iPhone 5', 'iPod touch 7', 'iPod touch 6', 'iPod touch 5']),
  group('iPhone 4 (2:3)', 640, 960, ['iPhone 4S', 'iPhone 4', 'iPod touch 4']),
];

export const IPAD_SIZE_GROUPS: CropSizeGroup[] = [
  group('iPad & iPad Pro 13″ (3:4)', 2064, 2752, [
    'iPad Pro M5 13inch', 'iPad Pro M4 13inch',
    'iPad 9', 'iPad 8', 'iPad 7', 'iPad 6', 'iPad 5', 'iPad 4', 'iPad 3', 'iPad 2',
    'iPad mini 5', 'iPad mini 4', 'iPad mini 3', 'iPad mini 2', 'iPad mini 1',
    'iPad Air 3', 'iPad Air 2', 'iPad Air 1',
    'iPad Pro 2 10.5inch', 'iPad Pro 1 9.7inch',
  ], 'iPad 2–9, iPad mini 1–5, iPad Air 1–3, iPad Pro 9.7″/10.5″, iPad Pro 13″ M4/M5'),
  group('iPad Pro 12.9″ & Air 13″', 2048, 2732, [
    'iPad Air M4 13inch', 'iPad Air M3 13inch', 'iPad Air M2 13inch',
    'iPad Pro 6 12.9inch', 'iPad Pro 5 12.9inch', 'iPad Pro 4 12.9inch', 'iPad Pro 3 12.9inch', 'iPad Pro 2 12.9inch', 'iPad Pro 1 12.9inch',
  ], 'iPad Pro 12.9″ 1–6, iPad Air 13″ M2/M3/M4'),
  group('iPad 10.9″ & Air 11″', 1640, 2360, ['iPad 11', 'iPad 10', 'iPad Air M4 11inch', 'iPad Air M3 11inch', 'iPad Air M2 11inch', 'iPad Air 5', 'iPad Air 4'],
    'iPad 10/11, iPad Air 4/5, iPad Air 11″ M2/M3/M4'),
  group('iPad Pro 11″ M4/M5', 1668, 2420, ['iPad Pro M5 11inch', 'iPad Pro M4 11inch']),
  group('iPad Pro 11″ 2018–2022', 1668, 2388, ['iPad Pro 6 11inch', 'iPad Pro 5 11inch', 'iPad Pro 4 11inch', 'iPad Pro 3 11inch']),
  group('iPad mini 6 & 7', 1488, 2266, ['iPad mini 7', 'iPad mini 6']),
];

export const DEVICE_SIZE_GROUPS: { category: string; groups: CropSizeGroup[] }[] = [{ category: 'iPhone', groups: IPHONE_SIZE_GROUPS }, { category: 'iPad', groups: IPAD_SIZE_GROUPS }];

export const deviceSizeGroup = (name: string) => DEVICE_SIZE_GROUPS.flatMap(c => c.groups).find(g => groupMatches(g, name));

/** `findDeviceSize`: a device or device group's screen size by name, case-insensitively. */
export function findDeviceSize(name: string): Size | undefined {
  if (Object.hasOwn(DEVICE_SIZES, name)) return DEVICE_SIZES[name];
  const needle = name.toLowerCase();
  const key = Object.keys(DEVICE_SIZES).find(k => k.toLowerCase() === needle);
  if (key) return DEVICE_SIZES[key];
  const found = deviceSizeGroup(name);
  return found && { width: found.width, height: found.height };
}
