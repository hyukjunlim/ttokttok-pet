'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./renderer-fixture');

const LAYOUT = { layout: 'above', scale: 1, petLeft: 88, margin: 10 };

// What the page sent, as plain data: arrays made inside the vm context have another Array
// prototype, which strict deepEqual refuses.
function shapes(f) {
  return f.calls.filter((call) => call[0] === 'setShape').map((call) => JSON.parse(JSON.stringify(call[1])));
}

function pill(f, rect) {
  return { style: {}, offsetWidth: 193, getBoundingClientRect: () => ({ width: rect.right - rect.left, height: rect.bottom - rect.top, ...rect }), addEventListener() {} };
}

test('the pet is reported from the window edge it sits against', () => {
  const f = fixture();
  f.callbacks.Layout(LAYOUT);
  // The sprite's rectangle (10, 20, 100 x 120 in its 144 x 156 box at 88, 284) ends 76 above the bottom of a 500 px window.
  assert.deepEqual(shapes(f), [{ layout: 'above', rects: [[98, 76, 100, 120]] }]);

  const below = fixture();
  below.callbacks.Layout({ ...LAYOUT, layout: 'below' });
  assert.deepEqual(shapes(below), [{ layout: 'below', rects: [[98, 304, 100, 120]] }]);
});

test('an unchanged shape is not sent again', () => {
  const f = fixture();
  f.callbacks.Layout(LAYOUT);
  f.callbacks.Layout(LAYOUT);
  f.player().onShapeChange();
  assert.equal(shapes(f).length, 1);
});

test('a frame from another row of the sheet gets its own shape before it is drawn', () => {
  const f = fixture();
  f.callbacks.Layout(LAYOUT);
  f.player().rects = [[0, 0, 144, 156]];
  f.player().onShapeChange();
  assert.deepEqual(shapes(f).at(-1), { layout: 'above', rects: [[88, 60, 144, 156]] });
  assert.equal(shapes(f).length, 2);
});

test('each bubble is covered, with room all round for its shadow', () => {
  const f = fixture();
  f.nodes.tray.children = [pill(f, { left: 80, top: 100, right: 273, bottom: 160 })];
  f.nodes.tray.scrollHeight = 100;
  f.nodes.tray.clientHeight = 300;
  f.nodes.tray.getBoundingClientRect = () => ({ left: 0, top: 50, right: 400, bottom: 440, width: 400, height: 390 });
  f.callbacks.Layout(LAYOUT);
  assert.deepEqual(shapes(f).at(-1).rects, [[98, 76, 100, 120], [54, 308, 245, 110]]);
});

test('a stack scrolled past the top of its tray is cut off there', () => {
  const f = fixture();
  f.nodes.tray.children = [pill(f, { left: 80, top: 100, right: 273, bottom: 160 })];
  f.nodes.tray.scrollHeight = 100;
  f.nodes.tray.clientHeight = 300;
  f.nodes.tray.getBoundingClientRect = () => ({ left: 0, top: 50, right: 400, bottom: 120, width: 400, height: 70 });
  f.callbacks.Layout(LAYOUT);
  assert.deepEqual(shapes(f).at(-1).rects[1], [54, 348, 245, 70]);
});

test('bubbles clamp to the 10 px margin at each edge and center over the pet between them', () => {
  const f = fixture();
  const bubble = {
    style: {},
    offsetWidth: 193,
    getBoundingClientRect() {
      const left = parseFloat(this.style.marginLeft) || 0;
      return { left, top: 100, right: left + this.offsetWidth, bottom: 160, width: this.offsetWidth, height: 60 };
    },
    addEventListener() {},
  };
  f.nodes.tray.children = [bubble];
  f.nodes.tray.scrollHeight = 100;
  f.nodes.tray.clientHeight = 300;
  f.nodes.tray.getBoundingClientRect = () => ({ left: 0, top: 50, right: 400, bottom: 440, width: 400, height: 390 });

  f.callbacks.Layout({ layout: 'above', scale: 0.75, petLeft: 10, margin: 10 });
  assert.equal(bubble.style.maxWidth, '380px');
  assert.equal(bubble.style.marginLeft, '10px');
  assert.deepEqual(shapes(f).at(-1).rects[1], [0, 308, 229, 110]);

  f.callbacks.Layout({ layout: 'above', scale: 1, petLeft: 104, margin: 10 });
  assert.equal(bubble.style.marginLeft, '104px');
  assert.deepEqual(shapes(f).at(-1).rects[1], [78, 308, 245, 110]);

  f.callbacks.Layout({ layout: 'above', scale: 0.75, petLeft: 250, margin: 10 });
  assert.equal(bubble.style.marginLeft, '197px');
  assert.deepEqual(shapes(f).at(-1).rects[1], [171, 308, 229, 110]);
});

test('the badge on the pet is covered while it shows', () => {
  const f = fixture();
  f.nodes.badge.hidden = false;
  f.nodes.badge.getBoundingClientRect = () => ({ left: 100, top: 300, right: 122, bottom: 322, width: 22, height: 22 });
  f.callbacks.Layout(LAYOUT);
  assert.deepEqual(shapes(f).at(-1).rects[1], [96, 500 - 326, 30, 30]);
});

test('the pet follows the mouse itself: nothing asks the main process to track the cursor', () => {
  const f = fixture();
  f.pet.dispatch('pointerdown', f.event());
  f.pet.dispatch('pointerup', f.event({ buttons: 0, timeStamp: 40 }));
  assert.deepEqual([...new Set(f.calls.map((call) => call[0]))].sort(), ['activate', 'dragEnd', 'dragStart', 'ready']);
});
