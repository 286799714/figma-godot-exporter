const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const context = vm.createContext({ figma: {
  showUI() {}, on() {}, ui: { postMessage() {} }, currentPage: { selection: [] }
}, __html__: '' });
vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context);
const generate = fonts => context.getFontDownloaderBatchScript(fonts);
const quote = value => "'" + value.replace(/'/g, "''") + "'";

function cleanup(directory) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('figma-font-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

function executePayload(fonts, directory, { online = false, prefix = '' } = {}) {
  const batch = generate(fonts);
  const scriptPath = path.join(directory, 'generated-payload.ps1');
  fs.writeFileSync(scriptPath, batch.split('# POWERSHELL_START\r\n')[1]);
  const output = path.join(directory, 'output');
  const command = `${prefix}\n& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(scriptPath)}))) -OutputDirectory ${quote(output)} -FontDirectories @(${quote(directory)}) ${online ? '' : '-Offline'}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  const reportPath = path.join(output, 'font-download-report.json');
  assert.ok(fs.existsSync(reportPath), result.stdout + result.stderr);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, ''));
  return { ...result, output, report };
}

test('generated BAT uses official PuHuiTi 1.0 URLs and Godot importer filenames', () => {
  const batch = generate([{ family: 'Alibaba PuHuiTi', style: 'Bold' }, { family: 'Alibaba PuHuiTi', style: 'Medium' }]);
  assert.match(batch, /AlibabaPuHuiTi_Bold\.ttf/);
  assert.match(batch, /AlibabaPuHuiTi_Medium\.ttf/);
  assert.match(batch, /https:\/\/fonts.alibabadesign.com\/AlibabaPuHuiTi\/Alibaba-PuHuiTi-Bold\/Alibaba-PuHuiTi-Bold\.ttf/);
  assert.match(batch, /Referer = 'https:\/\/www.alibabafonts.com\/'/);
  assert.ok(!batch.includes('All operations completed!'));
  assert.ok(!batch.replace(/\r\n/g, '').includes('\n'));
});

test('font styles map explicit weights and do not substitute an unknown style', () => {
  assert.equal(context.getFontWeight('Semi Bold Italic'), 600);
  assert.equal(context.getFontWeight('Extra-Light'), 200);
  assert.equal(context.getFontWeight('Black Oblique'), 900);
  assert.equal(context.getFontWeight('Condensed Bold'), null);
  const batch = generate([{ family: 'Alibaba PuHuiTi 2.0', style: 'Bold' }]);
  assert.ok(!batch.includes('https://fonts.alibabadesign.com/AlibabaPuHuiTi/Alibaba-PuHuiTi-Bold'));
});

test('PowerShell copies a font using metadata despite an unrelated filename', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-font-local-'));
  t.after(() => cleanup(directory));
  const original = path.join(process.env.WINDIR, 'Fonts', 'arialbd.ttf');
  assert.ok(fs.existsSync(original));
  fs.copyFileSync(original, path.join(directory, 'unrelated-filename.ttf'));
  const result = executePayload([{ family: 'Arial', style: 'Bold' }], directory);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report[0].status, 'copied');
  assert.equal(result.report[0].filename, 'Arial_Bold.ttf');
  assert.deepEqual(fs.readFileSync(path.join(result.output, 'Arial_Bold.ttf')), fs.readFileSync(original));
});

test('missing fonts return failure and record the exact request without executing font names', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-font-missing-'));
  t.after(() => cleanup(directory));
  const family = "测试 & %PATH% ! O'Brien'; throw 'INJECTED";
  const result = executePayload([{ family, style: 'Medium' }], directory);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.report[0].family, family);
  assert.equal(result.report[0].status, 'missing');
  assert.match(result.report[0].message, /No matching local TTF/);
  assert.match(result.stdout, /Ready: 0; Missing: 1/);
});

test('wrong weights and HTML disguised as TTF are not reported as ready', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-font-invalid-'));
  t.after(() => cleanup(directory));
  fs.copyFileSync(path.join(process.env.WINDIR, 'Fonts', 'arial.ttf'), path.join(directory, 'Arial_Bold.ttf'));
  fs.writeFileSync(path.join(directory, 'Arial_Medium.ttf'), '<html>Download failed</html>');
  const result = executePayload([{ family: 'Arial', style: 'Bold' }, { family: 'Arial', style: 'Medium' }], directory);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.report.filter(item => item.status === 'missing').length, 2, JSON.stringify(result.report));
});

test('BAT wrapper handles a Unicode path, writes beside the script, and exits with success', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-font-中文 & test-'));
  t.after(() => cleanup(directory));
  const batchPath = path.join(directory, 'figma_download_fonts.bat');
  fs.writeFileSync(batchPath, generate([]));
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', batchPath, '--no-pause'], {
    cwd: root, encoding: 'utf8', timeout: 30000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(path.join(directory, 'fonts', 'font-download-report.json')));
});

test('consecutive downloads validate both weights despite the WPF directory cache', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-font-download-'));
  t.after(() => cleanup(directory));
  // Simulate Google CSS and file responses with real local TTF bytes; no network is used.
  const prefix = `function Invoke-WebRequest {
    param($Uri, $OutFile, $Headers, [switch]$UseBasicParsing, $TimeoutSec, $UserAgent)
    if (-not $OutFile) {
      $name = if ($Uri -match '700$') { 'arialbd.ttf' } else { 'arial.ttf' }
      return [pscustomobject]@{ Content = 'src: url(https://fonts.gstatic.com/' + $name + ')' }
    }
    $name = [IO.Path]::GetFileName(([Uri]$Uri).AbsolutePath)
    [IO.File]::Copy((Join-Path (Join-Path $env:WINDIR 'Fonts') $name), $OutFile)
  }`;
  const result = executePayload([{ family: 'Arial', style: 'Bold' }, { family: 'Arial', style: 'Regular' }], directory, { online: true, prefix });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.report.map(item => item.status), ['downloaded', 'downloaded']);
  assert.ok(fs.existsSync(path.join(result.output, 'Arial_Bold.ttf')));
  assert.ok(fs.existsSync(path.join(result.output, 'Arial_Regular.ttf')));
  assert.ok(!fs.readdirSync(result.output).some(name => name.startsWith('.figma-font-')));
});
