import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const cfg = pkg.grokBuild;

function platform() {
  let os;
  if (process.platform === 'darwin') os = 'macos';
  else if (process.platform === 'linux') os = 'linux';
  else if (process.platform === 'win32') os = 'windows';
  else throw new Error(`Unsupported OS: ${process.platform}`);

  let arch;
  if (process.arch === 'arm64') arch = 'aarch64';
  else if (process.arch === 'x64') arch = 'x86_64';
  else throw new Error(`Unsupported architecture: ${process.arch}`);

  return `${os}-${arch}`;
}

async function download(url, output) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(output, Buffer.from(arrayBuffer));
}

const version = process.env.GROK_BUILD_VERSION ?? cfg.version;
const plat = platform();
const outDir = path.join(ROOT, 'vendor', 'grok', version);
const binName = process.platform === 'win32' ? 'grok.exe' : 'grok';
const outPath = path.join(outDir, binName);
const artifact = `grok-${version}-${plat}${process.platform === 'win32' ? '.exe' : ''}`;
fs.mkdirSync(outDir, { recursive: true });

const urls = [cfg.baseUrl, cfg.fallbackBaseUrl].map((base) => `${base}/${artifact}`);
let lastError;
for (const artifactUrl of urls) {
  try {
    console.log(`Downloading ${artifactUrl}`);
    await download(artifactUrl, outPath);
    if (process.platform !== 'win32') fs.chmodSync(outPath, 0o755);
    fs.writeFileSync(path.join(outDir, 'version.txt'), `${version}\n`);
    console.log(`Wrote ${path.relative(ROOT, outPath)}`);
    process.exit(0);
  } catch (err) {
    lastError = err;
    console.warn(`Failed: ${artifactUrl}: ${err.message}`);
  }
}
throw lastError;
