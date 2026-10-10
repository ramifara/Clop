import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandPathTemplate, expandTemplate, isAbsoluteTemplate, nameMatchesTemplate, resolveHome, safeFileName, type Counter } from './template';

// Tuesday 5 March 2024, 14:07:09 local time.
const now = new Date(2024, 2, 5, 14, 7, 9);
const posix = '/Users/rami/Pictures/shot.png';
const windows = 'C:\\Users\\rami\\Pictures\\shot.png';
const fixed = { now, locale: 'en-US', random: () => 'abcde' };

// The expected names are what Shared/FileNameTemplate.swift's generateFileName gives for the same inputs.
const fixtures: [string, string, string][] = [
  ['%y', '2024', 'year'],
  ['%m', '03', 'month number'],
  ['%n', 'March', 'month name'],
  ['%d', '05', 'day'],
  ['%w', '3', 'weekday, Sunday is 1'],
  ['%H', '14', 'hour'],
  ['%M', '07', 'minutes'],
  ['%S', '09', 'seconds'],
  ['%p', 'PM', 'PM after noon'],
  ['%r', 'abcde', 'random letters'],
  ['%i', '1', 'counter starts at 1'],
  ['%f', 'shot', 'file name'],
  ['%e', 'png', 'extension'],
  ['%y-%m-%d %H.%M.%S', '2024-03-05 14.07.09', 'date and time'],
  ['%f-optimised', 'shot-optimised', 'the default same-folder template'],
  ['Clop %n %d, %y at %H.%M', 'Clop March 05, 2024 at 14.07', 'a screenshot-style name'],
  ['%r%r', 'abcdeabcde', 'the same random letters for every %r'],
  ['100%', '100%', 'a lone percent sign'],
  ['%x %%f', '%x %shot', 'unknown tokens stay'],
  ['', '', 'empty, which is why callers fall back to a default template'],
];
for (const [template, name, what] of fixtures) test(`expands "${template}" (${what})`, () => {
  const expected = `${name}.png`;
  assert.equal(expandTemplate(template, { ...fixed, path: posix }), expected);
  assert.equal(expandTemplate(template, { ...fixed, path: windows, platform: 'win32' }), expected);
});

test('%P and %F give the folder and the full path, and are not made safe in path templates', () => {
  assert.equal(expandTemplate('%P|%F', { path: posix, platform: 'linux' }, { safe: false }), '/Users/rami/Pictures|/Users/rami/Pictures/shot.png.png');
  assert.equal(expandTemplate('%P', { path: windows, platform: 'win32' }, { safe: false }), 'C:\\Users\\rami\\Pictures.png');
});

test('hours around noon follow the macOS comparison, where 12:xx still reads AM', () => {
  const at = (hour: number) => expandTemplate('%p', { now: new Date(2024, 0, 1, hour, 30) });
  assert.deepEqual([0, 9, 12, 13, 23].map(at), ['AM', 'AM', 'AM', 'PM', 'PM']);
});

test('no extension is appended when there is no file or the file has none', () => {
  assert.equal(expandTemplate('%y', fixed), '2024');
  assert.equal(expandTemplate('%f', { path: '/tmp/README' }), 'README');
  assert.equal(expandTemplate('%f', { path: '/tmp/.hidden' }), '.hidden');
  assert.equal(expandTemplate('%f-%e', { path: '/tmp/a.tar.gz' }), 'a.tar-gz.gz');
});

test('%i counts up from the stored number and only templates that use it move the counter', () => {
  const counter: Counter = { value: 4 };
  assert.equal(expandTemplate('img-%i-%i', { path: posix, counter }), 'img-5-5.png');
  assert.equal(counter.value, 5);
  assert.equal(expandTemplate('plain', { path: posix, counter }), 'plain.png');
  assert.equal(counter.value, 5);
  assert.equal(expandTemplate('%i', { path: posix, counter }), '6.png');
  assert.equal(counter.value, 6);
});

test('a value that looks like a token is not expanded twice', () => {
  assert.equal(expandTemplate('%f', { path: '/tmp/100%d.png', now }), '100%d.png');
  assert.equal(expandTemplate('%P', { path: '/tmp/%y/a.png', now }, { safe: false }), '/tmp/%y.png');
});

test('names are made safe for Windows as well as macOS', () => {
  assert.equal(safeFileName('a/b:c*d|e'), 'a_b_c_d_e');
  assert.equal(safeFileName('x<y>z"q?w\\v'), 'x_y_z_q_w_v');
  assert.equal(safeFileName("it's {a} $b #c &d ^e ;f `g"), 'it_s _a_ _b _c _d _e _f _g');
  assert.equal(safeFileName('tab\there\nnew\u0001'), 'tab_here_new_');
  assert.equal(safeFileName('report. . '), 'report____');
  assert.equal(safeFileName('v1.2'), 'v1.2');
  assert.equal(safeFileName('CON'), 'CON_');
  assert.equal(safeFileName('nul.txt'), 'nul_.txt');
  assert.equal(safeFileName('com1'), 'com1_');
  assert.equal(safeFileName('lpt9.tar.gz'), 'lpt9_.tar.gz');
  assert.equal(safeFileName('console'), 'console');
  assert.equal(safeFileName('com10'), 'com10');
  assert.equal(safeFileName('photo-2024'), 'photo-2024');
  assert.equal(safeFileName('naïve – 写真'), 'naïve – 写真');
});

test('expanding applies the safe rules to the name but not to the extension', () => {
  assert.equal(expandTemplate('%f?', { path: '/tmp/con.png' }), 'con_.png');
  assert.equal(expandTemplate('%f', { path: '/tmp/con.png' }), 'con_.png');
  assert.equal(expandTemplate('CON', { path: '/tmp/a.png' }), 'CON_.png');
  assert.equal(expandTemplate('a:b', { path: '/tmp/a.png' }), 'a_b.png');
  assert.equal(expandTemplate('a:b', { path: '/tmp/a.png' }, { safe: false }), 'a:b.png');
});

test('~, $HOME and %USERPROFILE% mean the profile folder; the last only on Windows', () => {
  assert.equal(resolveHome('~/Pictures', '/home/me', 'linux'), '/home/me/Pictures');
  assert.equal(resolveHome('$HOME/Pictures/%f', '/home/me', 'linux'), '/home/me/Pictures/%f');
  assert.equal(resolveHome('${HOME}', '/home/me', 'linux'), '/home/me');
  assert.equal(resolveHome('~other/x', '/home/me', 'linux'), '~other/x');
  assert.equal(resolveHome('%USERPROFILE%\\Pictures', 'C:\\Users\\me', 'win32'), 'C:\\Users\\me\\Pictures');
  assert.equal(resolveHome('%userprofile%/Pictures', 'C:\\Users\\me', 'win32'), 'C:\\Users\\me/Pictures');
  assert.equal(resolveHome('%USERPROFILE%/Pictures', '/home/me', 'linux'), '%USERPROFILE%/Pictures');
  assert.equal(resolveHome('C:\\Users\\me\\$HOME', 'C:\\Users\\me', 'win32'), 'C:\\Users\\me\\$HOME');
});

test('path templates expand tokens and the home prefix, and sanitise every component but the root', () => {
  const posixCtx = { ...fixed, path: posix, platform: 'linux' as const, home: '/home/me' };
  assert.equal(expandPathTemplate('%P/optimised/%f', posixCtx), '/Users/rami/Pictures/optimised/shot.png');
  assert.equal(expandPathTemplate('~/Clop/%y-%m/%f', posixCtx), '/home/me/Clop/2024-03/shot.png');
  assert.equal(expandPathTemplate('$HOME/Clop/%f', posixCtx), '/home/me/Clop/shot.png');
  assert.equal(expandPathTemplate('optimised/%f', posixCtx), '/Users/rami/Pictures/optimised/shot.png');
  assert.equal(expandPathTemplate('../up/%f', posixCtx), '/Users/rami/up/shot.png');
  assert.equal(expandPathTemplate('/out/a?b/%F', { ...posixCtx, path: '/x/y.png' }), '/out/a_b/x/y.png.png');
  const win = { ...fixed, path: windows, platform: 'win32' as const, home: 'C:\\Users\\me' };
  assert.equal(expandPathTemplate('%P/optimised/%f', win), 'C:\\Users\\rami\\Pictures\\optimised\\shot.png');
  assert.equal(expandPathTemplate('%USERPROFILE%\\Pictures\\Clop\\%f', win), 'C:\\Users\\me\\Pictures\\Clop\\shot.png');
  assert.equal(expandPathTemplate('~/Pictures/%f', win), 'C:\\Users\\me\\Pictures\\shot.png');
  assert.equal(expandPathTemplate('D:/Out/con/%f', win), 'D:\\Out\\con_\\shot.png');
  assert.equal(expandPathTemplate('\\\\server\\share\\Out\\%f', win), '\\\\server\\share\\Out\\shot.png');
  assert.equal(expandPathTemplate('optimised\\%f', win), 'C:\\Users\\rami\\Pictures\\optimised\\shot.png');
});

test('templates anchored at a root, %P or %F are absolute', () => {
  assert.equal(isAbsoluteTemplate('%P/optimised/%f'), true);
  assert.equal(isAbsoluteTemplate('%F-copy'), true);
  assert.equal(isAbsoluteTemplate('/srv/%f', { platform: 'linux' }), true);
  assert.equal(isAbsoluteTemplate('~/Pictures/%f', { platform: 'linux', home: '/home/me' }), true);
  assert.equal(isAbsoluteTemplate('C:\\Out\\%f', { platform: 'win32' }), true);
  assert.equal(isAbsoluteTemplate('%USERPROFILE%\\%f', { platform: 'win32', home: 'C:\\Users\\me' }), true);
  assert.equal(isAbsoluteTemplate('optimised/%f', { platform: 'linux' }), false);
});

test('nameMatchesTemplate recognises names a template produced, so it is not applied twice', () => {
  const match = (name: string, template: string, allowPathPrefix = false) => nameMatchesTemplate(name, template, { allowPathPrefix, platform: 'linux' });
  assert.equal(match('kitty-opt', '%f-opt'), true);
  assert.equal(match('kitty', '%f-opt'), false);
  assert.equal(match('kitty-optimised', '%f-optimised'), true);
  assert.equal(match('shot 2024-03-05 at 14.07.09', 'shot %y-%m-%d at %H.%M.%S'), true);
  assert.equal(match('shot 24-03-05 at 14.07.09', 'shot %y-%m-%d at %H.%M.%S'), false);
  assert.equal(match('img-12', 'img-%i'), true);
  assert.equal(match('img-x', 'img-%i'), false);
  assert.equal(match('a-abcde', 'a-%r'), true);
  assert.equal(match('a-abcd', 'a-%r'), false);
  assert.equal(match('March', '%n'), true);
  assert.equal(match('März', '%n'), true);
  assert.equal(match('x-PM', 'x-%p'), true);
  assert.equal(match('x-3', 'x-%w'), true);
  assert.equal(match('x.png', 'x.%e'), true);
  assert.equal(match('x.png', 'x%e'), false);
  assert.equal(match('', ''), false);
  assert.equal(match('a.b', 'a.b'), true);
  assert.equal(match('axb', 'a.b'), false);
  assert.equal(match('a(1)', 'a(1)'), true);
  assert.equal(match('50%', '50%'), true);
  assert.equal(match('/Users/x/optimised/img', '%P/optimised/%f'), true);
  assert.equal(match('/Users/x/img', '%P/optimised/%f'), false);
  assert.equal(match('/Users/x/Out/img', 'Out/%f', true), true);
  assert.equal(match('Out/img', 'Out/%f', true), true);
  assert.equal(match('/Users/x/Other/img', 'Out/%f', true), false);
  assert.equal(match('/Users/x/Out/img', 'Out/%f', false), false);
});

test('on Windows names compare with / separators and ignoring case', () => {
  const match = (name: string, template: string, allowPathPrefix = false) => nameMatchesTemplate(name, template, { allowPathPrefix, platform: 'win32' });
  assert.equal(match('C:\\Users\\x\\optimised\\img', '%P/optimised/%f'), true);
  assert.equal(match('C:\\Users\\x\\Optimised\\img', '%P\\optimised\\%f'), true);
  assert.equal(match('C:\\Users\\x\\img', '%P/optimised/%f'), false);
  assert.equal(match('C:\\Users\\x\\Out\\img', 'out/%f', true), true);
  assert.equal(match('Kitty-OPT', '%f-opt'), true);
});
