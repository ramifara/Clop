import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import sharp from 'sharp';
import { run } from '../run';
import { analysePDFDPI, cropPDF, dropLowDPIOutliers, gsArgs, imageDPIs, loadPDF, nextPDFDPIStepDown, optimisePDF, renderPDFPages, resolvePDFDPI } from './pdf';
import { A4_RATIO, boxes, leftovers, photoPDF, textPDF, workspace } from './pdf.fixtures';

test('Ghostscript arguments follow PDF.swift', () => {
  const lossy = gsArgs('in.pdf', 'out.pdf', { lossy: true, dpi: 150 });
  assert.ok(lossy.includes('-dDownsampleColorImages=true') && lossy.includes('-dPassThroughJPEGImages=false') && lossy.includes('-dAutoFilterMonoImages=true'));
  assert.ok(lossy.includes('-dColorImageResolution=150') && lossy.includes('-dMonoImageResolution=300'));
  assert.ok(!lossy.some(arg => arg.includes('/QFactor 0.76')), 'no extra QFactor above 100 DPI');
  // The DeviceRGB strategy is repeated after /screen so it wins, and the input sits between the pre and post PostScript.
  assert.ok(lossy.lastIndexOf('-dColorConversionStrategy=/RGB') > lossy.indexOf('-dPDFSETTINGS=/screen'));
  assert.deepEqual(lossy.slice(lossy.indexOf('-o'), lossy.indexOf('-o') + 2), ['-o', 'out.pdf']);
  assert.equal(lossy[lossy.indexOf('in.pdf') - 1], '-f');
  assert.deepEqual(lossy.slice(-6), ['-c', '/pdfmark { originalpdfmark } bind def', '-f', '-c', '[ /Producer () /ModDate () /CreationDate () /DOCINFO pdfmark', '-f']);

  const lossless = gsArgs('in.pdf', 'out.pdf', { lossy: false, dpi: 300 });
  assert.ok(lossless.includes('-dDownsampleColorImages=false') && lossless.includes('-dPassThroughJPEGImages=true') && lossless.includes('-dShowAcroForm=true'));
  for (const [dpi, q] of [[100, '0.76'], [72, '1.0'], [48, '1.3']] as const) assert.ok(gsArgs('i', 'o', { lossy: true, dpi }).some(arg => arg.includes(`/QFactor ${q} `)), `QFactor ${q} at ${dpi}`);
  assert.ok(gsArgs('i', 'o', { lossy: true, dpi: 10 }).includes('-dColorImageResolution=48'), 'DPI clamps to 48');
  assert.ok(gsArgs('i', 'o', { lossy: false, dpi: 600 }).includes('-dColorImageResolution=300'), 'DPI clamps to 300');
});

test('adaptive DPI picks the highest stop with more than three images at or above it', () => {
  assert.deepEqual(analysePDFDPI([], 300), { chosen: 300 });
  assert.deepEqual(analysePDFDPI([285, 290, 260], 300), { chosen: 300, maxSourceDPI: 290 }, 'three images are not enough');
  assert.deepEqual(analysePDFDPI([285, 290, 260, 255], 300), { chosen: 250, maxSourceDPI: 290 });
  assert.deepEqual(analysePDFDPI([600, 600, 160, 155], 300), { chosen: 150, maxSourceDPI: 600 });
  assert.deepEqual(analysePDFDPI([600, 600, 600, 600], 200), { chosen: 200, maxSourceDPI: 600 });
  // Small partial-page images read as very low DPI and fall below the lower Tukey fence.
  assert.deepEqual(dropLowDPIOutliers([300, 310, 305, 295, 12]), [300, 310, 305, 295]);
  assert.deepEqual(dropLowDPIOutliers([12, 300, 310]), [12, 300, 310]);
  assert.equal(nextPDFDPIStepDown(300), 250);
  assert.equal(nextPDFDPIStepDown(120), 100);
  assert.equal(nextPDFDPIStepDown(48), 48);
});

test('the DPI resolves from the override, the setting and aggressive mode as resolvePDFDPI does', () => {
  const images = [285, 290, 260, 255];
  assert.deepEqual(resolvePDFDPI(images, {}), { chosen: 250, maxSourceDPI: 290 });
  assert.deepEqual(resolvePDFDPI(images, { aggressive: true }), { chosen: 200, maxSourceDPI: 290 });
  assert.deepEqual(resolvePDFDPI(images, { setting: 150 }), { chosen: 150, maxSourceDPI: 290 });
  assert.deepEqual(resolvePDFDPI(images, { setting: 300 }), { chosen: 300, maxSourceDPI: undefined }, 'a fixed 300 neither downsamples nor scans');
  assert.deepEqual(resolvePDFDPI(images, { setting: 300, aggressive: true }), { chosen: 250, maxSourceDPI: 290 });
  assert.deepEqual(resolvePDFDPI(images, { dpi: 72, aggressive: true }), { chosen: 72, maxSourceDPI: 290 }, 'an explicit DPI ignores aggressive');
  assert.deepEqual(resolvePDFDPI([], {}), { chosen: 300, maxSourceDPI: undefined }, 'no images keep full resolution');
});

test('image DPI is the image size over the page size in inches', async () => {
  const doc = await PDFDocument.load(await photoPDF({ pages: 2, page: [288, 216], dpi: 150 }));
  assert.deepEqual(imageDPIs(doc).map(Math.round), [150, 150]);
  assert.deepEqual(imageDPIs(await PDFDocument.load(await textPDF(2))), []);
});

test('optimise compresses images at the adaptive, aggressive and explicit DPI', async t => {
  const w = await workspace(t, 'gs'); if (!w) return;
  const input = await w.file('photos.pdf', await photoPDF());
  const original = (await stat(input)).size;
  const progress: number[] = [];
  const adaptive = await optimisePDF(input, w.out, { onProgress: f => progress.push(f) });
  t.diagnostic(`${original} → ${adaptive.bytes} bytes at ${adaptive.dpi} DPI`);
  assert.equal(adaptive.dpi, 250);
  assert.equal(adaptive.sourceDPI, 285);
  assert.equal(adaptive.pages, 4);
  assert.ok(!adaptive.unchanged && adaptive.bytes < original && adaptive.path === path.join(w.out, 'photos.pdf'));
  assert.deepEqual(progress, [0.25, 0.5, 0.75, 1]);
  const dpis = imageDPIs(await loadPDF(adaptive.path));
  assert.ok(dpis.length > 0 && dpis.every(dpi => dpi <= 251), `images downsampled to 250 DPI: ${dpis}`);

  const aggressive = await optimisePDF(input, w.out, { aggressive: true, name: 'aggressive' });
  assert.equal(aggressive.dpi, 200);
  assert.ok(aggressive.bytes < adaptive.bytes);
  const fixed = await optimisePDF(input, w.out, { dpi: 72, aggressive: true, name: 'fixed' });
  assert.equal(fixed.dpi, 72);
  assert.ok(fixed.bytes < aggressive.bytes);
  assert.deepEqual(await leftovers(w.out), []);
});

test('a result that is not smaller keeps the input unless larger results are allowed', async t => {
  const w = await workspace(t, 'gs'); if (!w) return;
  // An empty page: Ghostscript's output carries more structure than pdf-lib's few hundred bytes.
  const doc = await PDFDocument.create(); doc.addPage([100, 100]);
  const input = await w.file('empty.pdf', await doc.save());
  const kept = await optimisePDF(input, w.out);
  assert.deepEqual(kept, { path: input, bytes: (await stat(input)).size, format: 'pdf', pages: 1, unchanged: true, dpi: 300, sourceDPI: undefined });
  const allowed = await optimisePDF(input, w.dir, { allowLarger: true });
  assert.ok(!allowed.unchanged && allowed.bytes > kept.bytes);
  assert.equal(allowed.path, path.join(w.dir, 'empty-optimised.pdf'), 'the output never overwrites the input');
});

test('PDFs over 150 pages optimise in parallel chunks and keep page order', async t => {
  const w = await workspace(t, 'gs'); if (!w) return;
  const input = await w.file('long.pdf', await textPDF(160, { width: i => 300 + i }));
  const progress: number[] = [];
  const output = await optimisePDF(input, w.out, { allowLarger: true, dpiSetting: 150, onProgress: f => progress.push(f) });
  assert.equal(output.pages, 160);
  assert.deepEqual((await boxes(output.path)).map(b => Math.round(b.media.width)), Array.from({ length: 160 }, (_, i) => 300 + i));
  assert.equal(progress.length, 160);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((f, i) => i === 0 || f > progress[i - 1]));
  assert.deepEqual(await leftovers(w.out), []);
});

test('aborting stops every Ghostscript chunk and cleans up', async t => {
  const w = await workspace(t, 'gs'); if (!w) return;
  const input = await w.file('long.pdf', await textPDF(400));
  const controller = new AbortController();
  const job = optimisePDF(input, w.out, { signal: controller.signal, onProgress: () => controller.abort() });
  await assert.rejects(job, { name: 'AbortError' });
  assert.deepEqual(await leftovers(w.out), []);
});

test('encrypted and invalid PDFs are refused', async t => {
  const w = await workspace(t, 'gs'); if (!w) return;
  const plain = await w.file('plain.pdf', await textPDF(1));
  const encrypted = path.join(w.dir, 'encrypted.pdf');
  await run('gs', ['-q', '-dSAFER', '-sDEVICE=pdfwrite', '-sOwnerPassword=owner', '-sUserPassword=', '-o', encrypted, plain]);
  await assert.rejects(optimisePDF(encrypted, w.out), /encrypted/);
  await assert.rejects(cropPDF(encrypted, w.out, { aspectRatio: 1 }), /encrypted/);
  await assert.rejects(optimisePDF(await w.file('broken.pdf', Buffer.from('not a pdf')), w.out), /not a valid PDF/);
});

test('pages render to PNG and JPEG at twice the CropBox size', async t => {
  const w = await workspace(t, 'gs'); if (!w) return;
  const input = await w.file('doc.pdf', await textPDF(3));
  const pngs = await renderPDFPages(input, w.out);
  assert.deepEqual(pngs.map(p => path.basename(p.path)), ['doc-page1.png', 'doc-page2.png', 'doc-page3.png']);
  for (const png of pngs) assert.deepEqual([png.format, png.width, png.height], ['png', 1224, 1584]);
  assert.equal((await sharp(pngs[0].path).metadata()).format, 'png');

  const progress: number[] = [];
  const jpegs = await renderPDFPages(input, w.out, { format: 'jpeg', firstPage: 2, lastPage: 3, scale: 1, onProgress: f => progress.push(f) });
  assert.deepEqual(jpegs.map(p => path.basename(p.path)), ['doc-page2.jpg', 'doc-page3.jpg']);
  assert.equal((await sharp(jpegs[0].path).metadata()).format, 'jpeg');
  assert.deepEqual(progress.sort(), [0.5, 1]);

  const cropped = await cropPDF(input, w.dir, { aspectRatio: A4_RATIO, name: 'cropped' });
  const [page] = await renderPDFPages(cropped.path, w.out, { firstPage: 1, lastPage: 1, scale: 1 });
  assert.deepEqual([page.width, page.height], [560, 792]);
  await assert.rejects(renderPDFPages(input, w.out, { firstPage: 4 }), /has 3 pages/);
  assert.deepEqual(await leftovers(w.out), []);
});

test('extracted pages can be optimised as images', async t => {
  const w = await workspace(t, 'gs', 'pngquant', 'jpegoptim', 'exiftool'); if (!w) return;
  const input = await w.file('photos.pdf', await photoPDF({ pages: 2, page: [144, 108], dpi: 200 }));
  const plain = await renderPDFPages(input, path.join(w.dir, 'plain'));
  const optimised = await renderPDFPages(input, w.out, { optimise: { tier: 'custom', factor: 30 } });
  assert.deepEqual(optimised.map(p => path.basename(p.path)), ['photos-page1.png', 'photos-page2.png']);
  for (const [i, page] of optimised.entries()) {
    assert.ok(page.bytes < plain[i].bytes, `page ${i + 1}: ${page.bytes} < ${plain[i].bytes}`);
    assert.equal(page.bytes, (await stat(page.path)).size);
  }
  const jpegs = await renderPDFPages(input, w.out, { format: 'jpeg', optimise: { tier: 'custom', factor: 30 } });
  assert.deepEqual(jpegs.map(p => path.basename(p.path)), ['photos-page1.jpg', 'photos-page2.jpg']);
  assert.deepEqual((await readdir(w.out)).sort(), ['photos-page1.jpg', 'photos-page1.png', 'photos-page2.jpg', 'photos-page2.png']);
});
