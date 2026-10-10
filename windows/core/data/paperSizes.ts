// Port of Shared/PaperSizes.swift. Sizes are in millimetres, width × height.
export interface Size { width: number; height: number }
/** Paper sizes sharing one aspect ratio, so cropping to any member gives the same result (CropSizeGroup in Shared/CropSize.swift). */
export interface CropSizeGroup { name: string; width: number; height: number; members: string[]; summary?: string }

const sizes = (table: Record<string, [number, number]>) => Object.fromEntries(Object.entries(table).map(([name, [width, height]]) => [name, { width, height }])) as Record<string, Size>;

export const PAPER_SIZES_BY_CATEGORY: Record<string, Record<string, Size>> = {
  A: sizes({ 'A0': [841, 1189], 'A1': [594, 841], 'A2': [420, 594], 'A3': [297, 420], 'A4': [210, 297], 'A5': [148, 210], 'A6': [105, 148], 'A7': [74, 105], 'A8': [52, 74], 'A9': [37, 52], 'A10': [26, 37], 'A11': [18, 26], 'A12': [13, 18], 'A13': [9, 13], '2A0': [1189, 1682], '4A0': [1682, 2378], 'A0+': [914, 1292], 'A1+': [609, 914], 'A3+': [329, 483] }),
  B: sizes({ 'B0': [1000, 1414], 'B1': [707, 1000], 'B2': [500, 707], 'B3': [353, 500], 'B4': [250, 353], 'B5': [176, 250], 'B6': [125, 176], 'B7': [88, 125], 'B8': [62, 88], 'B9': [44, 62], 'B10': [31, 44], 'B11': [22, 31], 'B12': [15, 22], 'B13': [11, 15], 'B0+': [1118, 1580], 'B1+': [720, 1020], 'B2+': [520, 720] }),
  US: sizes({ 'Letter': [216, 279], 'Legal': [216, 356], 'Tabloid': [279, 432], 'Ledger': [432, 279], 'Junior Legal': [127, 203], 'Half Letter': [140, 216], 'Government Letter': [203, 267], 'Government Legal': [216, 330], 'ANSI A': [216, 279], 'ANSI B': [279, 432], 'ANSI C': [432, 559], 'ANSI D': [559, 864], 'ANSI E': [864, 1118], 'Arch A': [229, 305], 'Arch B': [305, 457], 'Arch C': [457, 610], 'Arch D': [610, 914], 'Arch E': [914, 1219], 'Arch E1': [762, 1067], 'Arch E2': [660, 965], 'Arch E3': [686, 991] }),
  Photography: sizes({ 'Passport': [35, 45], '2R': [64, 89], 'LD, DSC': [89, 119], '3R, L': [89, 127], 'LW': [89, 133], 'KGD': [102, 136], '4R, KG': [102, 152], '2LD, DSCW': [127, 169], '5R, 2L': [127, 178], '2LW': [127, 190], '6R': [152, 203], '8R, 6P': [203, 254], 'S8R, 6PW': [203, 305], '11R': [279, 356], 'A3+ Super B': [330, 483] }),
  Newspaper: sizes({ 'Berliner': [315, 470], 'Broadsheet': [597, 749], 'US Broadsheet': [381, 578], 'British Broadsheet': [375, 597], 'South African Broadsheet': [410, 578], 'Ciner': [350, 500], 'Compact': [280, 430], 'Nordisch': [400, 570], 'Rhenish': [350, 520], 'Swiss': [320, 475], 'Newspaper Tabloid': [280, 430], 'Canadian Tabloid': [260, 368], 'Norwegian Tabloid': [280, 400], 'New York Times': [305, 559], 'Wall Street Journal': [305, 578] }),
  Books: sizes({ 'Folio': [304.8, 482.6], 'Quarto': [241.3, 304.8], 'Imperial Octavo': [209.55, 292.1], 'Super Octavo': [177.8, 279.4], 'Royal Octavo': [165, 254], 'Medium Octavo': [165.1, 234.95], 'Octavo': [152.4, 228.6], 'Crown Octavo': [136.525, 203.2], '12mo': [127, 187.325], '16mo': [101.6, 171.45], '18mo': [101.6, 165.1], '32mo': [88.9, 139.7], '48mo': [63.5, 101.6], '64mo': [50.8, 76.2], 'A Format': [110, 178], 'B Format': [129, 198], 'C Format': [135, 216] }),
};
export const PAPER_SIZES: Record<string, Size> = Object.assign({}, ...Object.values(PAPER_SIZES_BY_CATEGORY));
/** The `PaperSize` enum's names, in its order. */
export const PAPER_SIZE_NAMES: readonly string[] = Object.values(PAPER_SIZES_BY_CATEGORY).flatMap(Object.keys);

const group = (name: string, width: number, height: number, members: string[] = [name], summary?: string): CropSizeGroup => ({ name, width, height, members, ...(summary ? { summary } : {}) });
export const ISO_PAPER_GROUPS: CropSizeGroup[] = [
  group('A & B series (1:√2)', 1000, 1414, ['4A0', '2A0', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13'], 'A0–A13, 2A0, 4A0, B0–B13'),
  group('A0+', 914, 1292), group('A1+', 609, 914), group('A3+', 329, 483), group('B0+', 1118, 1580), group('B1+', 720, 1020), group('B2+', 520, 720),
];
export const US_PAPER_GROUPS: CropSizeGroup[] = [
  group('Letter & ANSI A/C/E (17:22)', 170, 220, ['Letter', 'ANSI A', 'ANSI C', 'ANSI E']),
  group('Tabloid & Ledger & ANSI B/D (11:17)', 110, 170, ['Tabloid', 'Ledger', 'Half Letter', 'ANSI B', 'ANSI D']),
  group('Legal', 216, 356), group('Government Letter', 203, 267), group('Government Legal', 216, 330), group('Junior Legal', 127, 203),
  group('Arch A/C/E (3:4)', 300, 400, ['Arch A', 'Arch C', 'Arch E']), group('Arch B/D (2:3)', 200, 300, ['Arch B', 'Arch D']),
  group('Arch E1', 762, 1067), group('Arch E2', 660, 965), group('Arch E3', 686, 991),
];
export const PHOTO_PAPER_GROUPS: CropSizeGroup[] = [
  group('Photo 2:3', 200, 300, ['4R, KG', 'LW', '2LW', 'S8R, 6PW']), group('Photo 3:4', 300, 400, ['KGD', '6R', 'LD, DSC', '2LD, DSCW']),
  group('Photo 5:7', 500, 700, ['5R, 2L', '2R']), group('3R, L (7:10)', 700, 1000, ['3R, L']), group('8R, 6P (4:5)', 400, 500, ['8R, 6P']),
  group('11R (11:14)', 1100, 1400, ['11R']), group('Passport (7:9)', 350, 450, ['Passport']), group('A3+ Super B', 330, 483),
];
export const NEWSPAPER_PAPER_GROUPS: CropSizeGroup[] = [
  group('Compact & Tabloid', 280, 430, ['Compact', 'Newspaper Tabloid']), group('Ciner & Norwegian Tabloid (7:10)', 350, 500, ['Ciner', 'Norwegian Tabloid']),
  group('Berliner', 315, 470), group('Broadsheet', 597, 749), group('US Broadsheet', 381, 578), group('British Broadsheet', 375, 597), group('South African Broadsheet', 410, 578),
  group('Nordisch', 400, 570), group('Rhenish', 350, 520), group('Swiss', 320, 475), group('Canadian Tabloid', 260, 368), group('New York Times', 305, 559), group('Wall Street Journal', 305, 578),
];
export const BOOK_PAPER_GROUPS: CropSizeGroup[] = [
  group('Octavo & 64mo (2:3)', 200, 300, ['Octavo', '64mo']), group('Super Octavo & 32mo (7:11)', 700, 1100, ['Super Octavo', '32mo']), group('48mo & C Format (5:8)', 500, 800, ['48mo', 'C Format']),
  group('Folio', 305, 483), group('Quarto', 241, 305), group('Imperial Octavo', 210, 292), group('Royal Octavo', 165, 254), group('Medium Octavo', 165, 235), group('Crown Octavo', 137, 203),
  group('12mo', 127, 187), group('16mo', 102, 171), group('18mo', 102, 165), group('A Format', 110, 178), group('B Format', 129, 198),
];
export const PAPER_SIZE_GROUPS: { category: string; groups: CropSizeGroup[] }[] = [
  { category: 'ISO', groups: ISO_PAPER_GROUPS }, { category: 'US', groups: US_PAPER_GROUPS }, { category: 'Photography', groups: PHOTO_PAPER_GROUPS },
  { category: 'Newspaper', groups: NEWSPAPER_PAPER_GROUPS }, { category: 'Books', groups: BOOK_PAPER_GROUPS },
];

export function paperSizeGroup(name: string): CropSizeGroup | undefined {
  const needle = name.toLowerCase();
  return PAPER_SIZE_GROUPS.flatMap(c => c.groups).find(g => g.name.toLowerCase() === needle || g.members.some(m => m.toLowerCase() === needle));
}

/** Resolves a paper size or paper group name to its dimensions, case-insensitively. */
export function findPaperSize(name: string): Size | undefined {
  if (Object.hasOwn(PAPER_SIZES, name)) return PAPER_SIZES[name];
  const needle = name.toLowerCase();
  const key = Object.keys(PAPER_SIZES).find(k => k.toLowerCase() === needle);
  if (key) return PAPER_SIZES[key];
  const found = paperSizeGroup(name);
  return found && { width: found.width, height: found.height };
}
