import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultSettings } from '../core/settings/schema';
import { Welcome } from './Welcome';

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('the first-run card points to the tray and the keys that work, and can be dismissed', () => {
  const html = renderToStaticMarkup(<Welcome settings={defaultSettings()} onDismiss={() => {}}/>);
  assert.match(text(html), /Welcome to Clop/);
  assert.match(text(html), /tray/);
  assert.match(text(html), /Ctrl\+Shift\+C optimise the clipboard now/);
  assert.match(html, /<button[^>]*>Got it<\/button>/);
});

test('keys that are off are not promised', () => {
  const none = text(renderToStaticMarkup(<Welcome settings={{ ...defaultSettings(), enabledKeys: [] }} onDismiss={() => {}}/>));
  assert.doesNotMatch(none, /optimise the clipboard now|pause or resume/);
  assert.match(none, /tray/);
  const one = text(renderToStaticMarkup(<Welcome settings={{ ...defaultSettings(), enabledKeys: ['P'] }} onDismiss={() => {}}/>));
  assert.match(one, /pause or resume/);
  assert.doesNotMatch(one, /clipboard now/);
});
