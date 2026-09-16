const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const rootDir = path.resolve(__dirname, '..');
const mainSource = readFileSync(path.join(rootDir, 'main.js'), 'utf8');
const uiSource = [...readFileSync(path.join(rootDir, 'ui.html'), 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

// Model Figma's getter-based nodes, including synchronous APIs that throw in dynamic-page mode.
function node(id, type, properties = {}, children) {
  const state = { id, type, name: id, parent: null, ...properties };
  if (children) state.children = children;
  const reads = {};
  const proto = {};
  for (const key of Object.keys(state)) {
    Object.defineProperty(proto, key, { get() { return state[key]; } });
  }
  for (const key of ['masterComponent', 'mainComponent', 'instances', 'constrainProportions', 'horizontalPadding', 'verticalPadding']) {
    Object.defineProperty(proto, key, { get() {
      reads[key] = (reads[key] || 0) + 1;
      throw new Error(`Cannot read ${key} with documentAccess: dynamic-page`);
    } });
  }
  const result = Object.create(proto);
  result.state = state;
  result.reads = reads;
  result.findAll = predicate => {
    const found = [];
    const visit = current => {
      for (const child of current.children || []) {
        if (predicate(child)) found.push(child);
        visit(child);
      }
    };
    visit(result);
    return found;
  };
  for (const child of children || []) child.state.parent = result;
  return result;
}

function plugin(pages, selection = []) {
  const messages = [];
  const listeners = {};
  let loads = 0;
  let closed = false;
  const root = node('document', 'DOCUMENT', {}, pages);
  for (const page of pages) page.state.selection = [];
  pages[0].state.selection = selection;
  // Selection is editor state, not part of the exported layout.
  for (const page of pages) Object.defineProperty(page, 'selection', { get: () => page.state.selection });
  const figma = {
    root, currentPage: pages[0], ui: { postMessage: message => messages.push(message) },
    showUI() {}, on: (event, callback) => { listeners[event] = callback; },
    loadAllPagesAsync: async () => { loads++; }, closePlugin: () => { closed = true; }
  };
  vm.runInNewContext(mainSource, { figma, __html__: '', console: { error() {} } });
  return {
    figma, messages, listeners, get loads() { return loads; }, get closed() { return closed; },
    async request(type, exportType = 'project', requestId = 1) {
      await figma.ui.onmessage({ type, exportType, requestId });
      return messages.at(-1);
    }
  };
}

test('dynamic-page instances export their main component without reading removed APIs', async () => {
  const component = node('component', 'COMPONENT', {}, []);
  const instance = node('instance', 'INSTANCE', { fontSize: Symbol('mixed'), paddingLeft: 12, paddingRight: 20 }, []);
  let asyncReads = 0;
  instance.getMainComponentAsync = async () => { asyncReads++; return component; };
  const page = node('page', 'PAGE', {}, [component, instance]);
  const app = plugin([page]);
  const response = await app.request('request-json');
  assert.equal(response.type, 'response-json');
  const data = JSON.parse(response.jsonString);
  const exported = data.children[0].children[1];
  assert.equal(exported.masterComponent.id, 'component');
  assert.equal(exported.fontSize, 'Mixed');
  assert.equal(exported.paddingLeft, 12);
  assert.equal(exported.paddingRight, 20);
  assert.equal(data.exportType, 'PROJECT');
  assert.equal(asyncReads, 1);
  assert.equal(app.loads, 1);
  for (const item of [component, instance, page, app.figma.root]) assert.deepEqual(item.reads, {});
});

test('page and frame exports preserve document wrappers and use the live selection without loading other pages', async () => {
  const first = node('first', 'FRAME', {}, []);
  const second = node('second', 'FRAME', {}, []);
  const page = node('page', 'PAGE', {}, [first, second]);
  const otherPage = node('other-page', 'PAGE', {}, []);
  const app = plugin([page, otherPage], [first]);
  page.state.selection = [second];
  const frameResponse = await app.request('request-json', 'frame');
  const data = JSON.parse(frameResponse.jsonString);
  assert.equal(data.exportType, 'FRAME');
  assert.equal(data.children.length, 1);
  assert.deepEqual(data.children[0].parent, { id: 'document', type: 'DOCUMENT' });
  assert.equal(data.children[0].children.length, 1);
  assert.equal(data.children[0].children[0].id, 'second');
  assert.deepEqual(data.children[0].children[0].parent, { id: 'page', type: 'PAGE' });
  app.figma.currentPage = otherPage;
  const pageResponse = await app.request('request-json', 'page');
  assert.equal(JSON.parse(pageResponse.jsonString).children[0].id, 'other-page');
  assert.deepEqual(JSON.parse(pageResponse.jsonString).children[0].parent, { id: 'document', type: 'DOCUMENT' });
  assert.equal(app.loads, 0);
});

test('ZIP exports succeed with no images and no fonts', async () => {
  const frame = node('frame', 'FRAME', {}, []);
  const app = plugin([node('page', 'PAGE', {}, [frame])], [frame]);
  const response = await app.request('request-zip', 'frame', 7);
  assert.equal(response.type, 'response-zip');
  assert.equal(response.requestId, 7);
  assert.equal(response.images.length, 0);
  assert.equal(JSON.parse(response.jsonString).exportType, 'FRAME');
  assert.match(response.batchScript, /@echo off/);
});

test('image export includes root fills, deduplicates hashes, and handles mixed text fills', async () => {
  const imageFill = hash => ({ type: 'IMAGE', imageHash: hash });
  const text = node('text', 'TEXT', { fills: Symbol('mixed'), characters: 'hello' });
  text.getStyledTextSegments = () => [{ fills: [imageFill('text-image')] }];
  text.exportAsync = async () => Uint8Array.of(3);
  const frame = node('frame', 'FRAME', {
    fills: [imageFill('root-image'), imageFill('root-image'), imageFill(null), { ...imageFill('hidden'), visible: false }]
  }, [text]);
  let exports = 0;
  frame.exportAsync = async () => { exports++; return Uint8Array.of(1, 2); };
  const app = plugin([node('page', 'PAGE', {}, [frame])], [frame]);
  const response = await app.request('request-images', 'frame');
  assert.deepEqual(Array.from(response.images, image => image.filename), ['root-image.png', 'text-image.png']);
  assert.equal(exports, 1);
});

test('a ZIP keeps one frame scope even when selection changes while reading components', async () => {
  const instance = node('instance', 'INSTANCE', {}, []);
  const text = node('text', 'TEXT', { characters: 'A' });
  text.getRangeAllFontNames = () => [{ family: 'Selected Font', style: 'Regular' }];
  const first = node('first', 'FRAME', { fills: [{ type: 'IMAGE', imageHash: 'first' }] }, [instance, text]);
  first.exportAsync = async () => Uint8Array.of(1);
  const second = node('second', 'FRAME', {}, []);
  const page = node('page', 'PAGE', {}, [first, second]);
  instance.getMainComponentAsync = async () => { page.state.selection = [second]; return null; };
  const app = plugin([page], [first]);
  const response = await app.request('request-zip', 'frame');
  assert.equal(response.type, 'response-zip');
  assert.equal(JSON.parse(response.jsonString).children[0].children[0].id, 'first');
  assert.equal(response.images[0].filename, 'first.png');
  assert.match(response.batchScript, /Selected Font/);
});

test('invalid selection and rejected APIs report errors, and subsequent requests recover', async () => {
  const instance = node('instance', 'INSTANCE', {}, []);
  instance.getMainComponentAsync = async () => { throw new Error('Component unavailable'); };
  const frame = node('frame', 'FRAME', {}, [instance]);
  const page = node('page', 'PAGE', {}, [frame]);
  const app = plugin([page]);
  assert.equal((await app.request('request-json', 'frame')).type, 'response-error');
  page.state.selection = [frame];
  const failed = await app.request('request-json', 'frame');
  assert.equal(failed.type, 'response-error');
  assert.equal(failed.message, 'Component unavailable');
  instance.getMainComponentAsync = async () => null;
  assert.equal((await app.request('request-json', 'frame')).type, 'response-json');
  app.figma.loadAllPagesAsync = async () => { throw new Error('Page load failed'); };
  assert.equal((await app.request('request-json')).message, 'Page load failed');
  await app.request('request-cancel');
  assert.equal(app.closed, true);
});

test('component reference cycles terminate without losing the document tree', async () => {
  const instance = node('instance', 'INSTANCE', {}, []);
  const component = node('component', 'COMPONENT', {}, [instance]);
  instance.getMainComponentAsync = async () => component;
  const app = plugin([node('page', 'PAGE', {}, [component])]);
  const response = await app.request('request-json');
  assert.equal(response.type, 'response-json');
  assert.equal(JSON.parse(response.jsonString).children[0].children[0].children[0].masterComponent.id, 'component');
});

function ui({ zipAvailable = true } = {}) {
  const elements = {};
  const radioIds = ['export-project', 'export-page', 'export-frame'];
  for (const id of [...radioIds, 'export-zip', 'export-json', 'export-images', 'export-fonts', 'export-status']) {
    let checked = id === 'export-project';
    elements[id] = { id, disabled: id === 'export-frame', textContent: '', dataset: {} };
    Object.defineProperty(elements[id], 'checked', {
      get: () => checked,
      set: value => {
        checked = value;
        if (value && radioIds.includes(id)) {
          for (const other of radioIds) if (other !== id) elements[other].checked = false;
        }
      }
    });
  }
  const requests = [], downloads = [], archives = [], timers = [];
  const context = {
    document: {
      getElementById: id => elements[id],
      querySelectorAll: () => Object.values(elements).filter(element => element.id !== 'export-status'),
      querySelector: () => radioIds.map(id => elements[id]).find(element => element.checked),
      body: { appendChild() {} },
      createElement: () => ({ click() { downloads.push(this.download); }, remove() {} })
    },
    parent: { postMessage: message => requests.push(message.pluginMessage) },
    Blob, Uint8Array, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    setTimeout: callback => timers.push(callback)
  };
  if (zipAvailable) context.fflate = {
    strToU8: text => new TextEncoder().encode(text),
    zipSync: files => { archives.push(files); return Uint8Array.of(80, 75); }
  };
  vm.createContext(context);
  vm.runInContext(uiSource, context);
  return {
    elements, requests, downloads, archives,
    click: format => elements[`export-${format}`].onclick(),
    receive: message => context.onmessage({ data: { pluginMessage: message } }),
    context
  };
}

test('UI sends one ZIP request, accepts empty images, and supports JSON and another ZIP afterward', () => {
  const app = ui();
  assert.equal(app.requests[0].type, 'request-selection-state');
  app.click('zip');
  const request = app.requests.at(-1);
  assert.equal(request.type, 'request-zip');
  assert.equal(app.requests.length, 2);
  assert.equal(app.elements['export-json'].disabled, true);
  app.click('json');
  assert.equal(app.requests.length, 2);
  app.receive({ type: 'response-zip', requestId: request.requestId, jsonString: '{"name":"中文"}', images: [], batchScript: '@echo off' });
  assert.deepEqual(app.downloads, ['figma_godot_export.zip']);
  assert.deepEqual(Object.keys(app.archives[0]), ['figma_export.json', 'figma_download_fonts.bat']);
  assert.equal(app.elements['export-json'].disabled, false);
  app.click('json');
  app.receive({ type: 'response-json', requestId: app.requests.at(-1).requestId, jsonString: '{}' });
  app.click('zip');
  app.receive({ type: 'response-zip', requestId: app.requests.at(-1).requestId, jsonString: '{}', images: [{ filename: 'hash.png', data: [1, 2] }], batchScript: '@echo off' });
  assert.deepEqual(app.downloads, ['figma_godot_export.zip', 'figma_layout.json', 'figma_godot_export.zip']);
  assert.deepEqual(Array.from(app.archives[1]['images/hash.png']), [1, 2]);
});

test('UI recovers from errors, ignores stale responses, and tracks selection changes', () => {
  const app = ui();
  app.context.onmessage({ data: {} });
  app.receive({ type: 'response-is-frame-selected', isFrameSelected: true });
  assert.equal(app.elements['export-frame'].disabled, false);
  app.elements['export-frame'].checked = true;
  app.click('json');
  const request = app.requests.at(-1);
  assert.equal(request.exportType, 'frame');
  app.receive({ type: 'response-json', requestId: request.requestId - 1, jsonString: '{}' });
  assert.equal(app.downloads.length, 0);
  assert.equal(app.elements['export-json'].disabled, true);
  app.receive({ type: 'response-error', requestId: request.requestId, message: 'Try again' });
  assert.match(app.elements['export-status'].textContent, /Try again/);
  assert.equal(app.elements['export-json'].disabled, false);
  app.receive({ type: 'response-is-frame-selected', isFrameSelected: false });
  assert.equal(app.elements['export-frame'].disabled, true);
  assert.equal(app.elements['export-page'].checked, true);
  app.click('images');
  app.receive({ type: 'response-images', requestId: app.requests.at(-1).requestId, images: [] });
  assert.match(app.elements['export-status'].textContent, /No images/);
});

test('missing ZIP library reports a visible error while individual exports remain available', () => {
  const app = ui({ zipAvailable: false });
  app.click('zip');
  assert.match(app.elements['export-status'].textContent, /ZIP library could not load/);
  assert.equal(app.requests.length, 1);
  app.click('fonts');
  app.receive({ type: 'response-fonts', requestId: app.requests.at(-1).requestId, batchScript: '@echo off' });
  assert.deepEqual(app.downloads, ['figma_download_fonts.bat']);
});
