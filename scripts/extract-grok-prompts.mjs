import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const PROMPTS_DIR = path.join(ROOT, 'prompts');
const SKILLS_DIR = path.join(ROOT, 'skills');
const SUBAGENTS_DIR = path.join(ROOT, 'subagents');
const RAW_DIR = path.join(ROOT, 'raw');
const README_FILE = path.join(ROOT, 'README.md');
const MIN_PROMPT_LENGTH = 260;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  return childProcess.execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function resolveGrokBinary() {
  if (process.env.GROK_BIN && fs.existsSync(process.env.GROK_BIN)) return fs.realpathSync(process.env.GROK_BIN);
  const version = process.env.GROK_BUILD_VERSION ?? pkg.grokBuild.version;
  const local = path.join(ROOT, 'vendor', 'grok', version, process.platform === 'win32' ? 'grok.exe' : 'grok');
  if (fs.existsSync(local)) return fs.realpathSync(local);
  throw new Error(`Grok binary not found at ${local}. Run bun run download:grok first.`);
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72).replace(/^-|-$/g, '') || 'prompt';
}

function printableAscii(byte) {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e);
}

function printableRatio(buffer) {
  if (buffer.length === 0) return 0;
  let good = 0;
  for (const byte of buffer) if (printableAscii(byte)) good += 1;
  return good / buffer.length;
}

function readU64(buffer, offset) {
  return buffer.readBigUInt64LE(offset);
}

function fixedString(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '');
}

function parseMachOSections(buffer) {
  const MH_MAGIC_64 = 0xfeedfacf;
  const LC_SEGMENT_64 = 0x19;
  if (buffer.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error('Only little-endian Mach-O 64-bit binaries are supported for Rust slice extraction.');
  }

  const ncmds = buffer.readUInt32LE(16);
  let commandOffset = 32;
  const sections = [];
  for (let i = 0; i < ncmds; i += 1) {
    const cmd = buffer.readUInt32LE(commandOffset);
    const cmdsize = buffer.readUInt32LE(commandOffset + 4);
    if (cmd === LC_SEGMENT_64) {
      const segname = fixedString(buffer, commandOffset + 8, 16);
      const nsects = buffer.readUInt32LE(commandOffset + 64);
      let sectionOffset = commandOffset + 72;
      for (let j = 0; j < nsects; j += 1) {
        const sectname = fixedString(buffer, sectionOffset, 16);
        const sectionSegname = fixedString(buffer, sectionOffset + 16, 16);
        sections.push({
          segname: sectionSegname || segname,
          sectname,
          addr: readU64(buffer, sectionOffset + 32),
          size: Number(readU64(buffer, sectionOffset + 40)),
          offset: buffer.readUInt32LE(sectionOffset + 48),
        });
        sectionOffset += 80;
      }
    }
    commandOffset += cmdsize;
  }
  return sections;
}

function findSection(sections, segname, sectname) {
  const section = sections.find((candidate) => candidate.segname === segname && candidate.sectname === sectname);
  if (!section) throw new Error(`Could not find Mach-O section ${segname},${sectname}`);
  return section;
}

function extractRustStringSlices(buffer) {
  const out = [];
  let textConst;
  let dataConst;
  try {
    const sections = parseMachOSections(buffer);
    textConst = findSection(sections, '__TEXT', '__const');
    dataConst = findSection(sections, '__DATA_CONST', '__const');
  } catch (err) {
    console.warn(`Skipping Rust slice extraction: ${err.message}`);
    return out;
  }

  for (let pairOffset = dataConst.offset; pairOffset + 16 <= dataConst.offset + dataConst.size; pairOffset += 8) {
    const ptr = readU64(buffer, pairOffset);
    const length = Number(readU64(buffer, pairOffset + 8));
    if (ptr < textConst.addr || ptr >= textConst.addr + BigInt(textConst.size)) continue;
    if (length < 40 || length > 20_000) continue;
    const fileOffset = textConst.offset + Number(ptr - textConst.addr);
    if (fileOffset + length > textConst.offset + textConst.size) continue;
    const bytes = buffer.subarray(fileOffset, fileOffset + length);
    if (printableRatio(bytes) < 0.85) continue;
    out.push({ text: bytes.toString('utf8'), source: { kind: 'rust-slice', offset: fileOffset, refOffset: pairOffset, length } });
  }
  return out;
}

function normalizeText(s) {
  return s.replace(/\r\n/g, '\n').replace(/\\n/g, '\n').replace(/\u2014/g, '-').replace(/\u2013/g, '-').replace(/\u2019/g, "'").replace(/\u201c|\u201d/g, '"').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isPromptLike(text, sourceKind) {
  const normalized = normalizeText(text);
  if (normalized.length < MIN_PROMPT_LENGTH) return false;
  if (/^(Usage:|Options:|Commands:|Examples:|Error:|Warning:)/i.test(normalized)) return false;
  if (/^(# Getting Started|# Keyboard Shortcuts|# Slash Commands|# Theming|# Custom Models|# Project Rules|# Headless Mode|# Agent Mode|# Subagents and Personas|# Sandbox Mode|# Terminal Support)/i.test(normalized)) return false;
  if (/https?:\/\//i.test(normalized) && normalized.length < 900) return false;
  const startsLikePrompt = /^(?:<[^>]+>\s*)?(You are|Your task is|You will|We need|Analyze|Review|Generate|Given|The following|Instructions:|System:|Plan mode|General-purpose agent|Complete the assigned task)/i.test(normalized);
  if (sourceKind === 'rust-slice' && !startsLikePrompt && !/^---\nname:/i.test(normalized)) return false;
  const hasPromptSection = /(^|\n)#{1,3}\s*(Role|Goal|Task|Instructions|Guidelines|Context|Output)|(^|\n)(?:Role|Goal|Task|Instructions|Guidelines|Context|Output):/i.test(normalized);
  if (!startsLikePrompt && !hasPromptSection) return false;
  const lines = normalized.split('\n').filter((line) => line.trim().length > 0).length;
  const sentences = normalized.split(/[.!?](?:\s|$)/).filter((part) => part.trim().length > 24).length;
  return lines >= 4 || sentences >= 4 || normalized.length >= 700;
}

function inferName(text) {
  const lower = text.toLowerCase();
  const rules = [
    [/memory assistant performing an incremental update/, 'memory-incremental-update'],
    [/name: create-skill|create a new grok skill/, 'skill-creator'],
    [/expert software engineer acting as a code verifier/, 'code-verifier'],
    [/plan mode|planning/, 'plan-mode'],
    [/code review|review.*code changes|pull request review/, 'code-review'],
    [/security review|security scan|vulnerabilit/, 'security-review'],
    [/commit message/, 'commit-message-generator'],
    [/pull request|pr description/, 'pull-request-helper'],
    [/summari[sz]e.*conversation|conversation summary/, 'conversation-summary'],
    [/search|exploration/, 'search-agent'],
    [/you are.*grok|grok build|coding agent/, 'grok-build-agent'],
  ];
  for (const [pattern, name] of rules) if (pattern.test(lower)) return name;
  const title = text.match(/^#\s+([^\n{}]+)/m)?.[1]?.trim();
  if (title) return slug(title);
  const firstLine = text.split('\n').find((line) => /[a-z]/i.test(line)) ?? text;
  return slug(firstLine.split(/[.!?]/, 1)[0].replace(/^You are an?\s+/i, '').replace(/^You are\s+/i, ''));
}

function inferCategory(text) {
  if (/^---\nname:/i.test(text)) return 'skill';
  if (/subagent|child session|independent child sessions/i.test(text) && !/create a new grok skill/i.test(text)) return 'subagent';
  return 'prompt';
}

function addCandidate(candidates, text, source) {
  const normalized = normalizeText(text);
  if (!isPromptLike(normalized, source.kind)) return;
  const key = normalized.replace(/\s+/g, ' ');
  if (!candidates.has(key)) candidates.set(key, { text: normalized, source });
}

function collectRustSliceCandidates(buffer) {
  const candidates = new Map();
  for (const item of extractRustStringSlices(buffer)) addCandidate(candidates, item.text, item.source);
  return [...candidates.values()];
}

function uniqueNames(prompts) {
  const counts = new Map();
  return prompts.map((prompt) => {
    const category = inferCategory(prompt.text);
    const base = inferName(prompt.text);
    const key = `${category}:${base}`;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return { ...prompt, category, name: next === 1 ? base : `${base}-${next}` };
  });
}

function updateReadmeCatalog(catalog) {
  const readme = fs.readFileSync(README_FILE, 'utf8');
  const start = '<!-- BEGIN GENERATED CATALOG -->';
  const end = '<!-- END GENERATED CATALOG -->';
  const startIndex = readme.indexOf(start);
  const endIndex = readme.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) throw new Error('README.md is missing generated catalog markers.');
  const before = readme.slice(0, startIndex + start.length);
  const after = readme.slice(endIndex);
  fs.writeFileSync(README_FILE, `${before}\n\n${catalog}\n${after}`);
}

const grokBin = resolveGrokBinary();
const version = run(grokBin, ['--version']).trim();
let help = '';
try { help = run(grokBin, ['--help']); } catch (err) { help = JSON.stringify({ error: String(err.message ?? err) }, null, 2); }
const binary = fs.readFileSync(grokBin);
const machOSections = parseMachOSections(binary).map((section) => ({
  segname: section.segname,
  sectname: section.sectname,
  addr: `0x${section.addr.toString(16)}`,
  size: section.size,
  offset: section.offset,
}));
const prompts = uniqueNames(collectRustSliceCandidates(binary)).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

fs.rmSync(PROMPTS_DIR, { recursive: true, force: true });
fs.rmSync(SKILLS_DIR, { recursive: true, force: true });
fs.rmSync(SUBAGENTS_DIR, { recursive: true, force: true });
fs.rmSync(RAW_DIR, { recursive: true, force: true });
fs.mkdirSync(PROMPTS_DIR, { recursive: true });
fs.mkdirSync(SKILLS_DIR, { recursive: true });
fs.mkdirSync(SUBAGENTS_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.writeFileSync(path.join(RAW_DIR, 'grok-help.txt'), help);
fs.writeFileSync(path.join(RAW_DIR, 'macho-sections.json'), `${JSON.stringify(machOSections, null, 2)}\n`);
fs.writeFileSync(path.join(RAW_DIR, 'rust-string-slices.json'), `${JSON.stringify(prompts.map((prompt) => ({ name: prompt.name, category: prompt.category, length: prompt.text.length, source: prompt.source, preview: prompt.text.slice(0, 160) })), null, 2)}\n`);
fs.writeFileSync(path.join(RAW_DIR, 'prompt-candidates.json'), `${JSON.stringify(prompts.map((prompt) => ({ name: prompt.name, category: prompt.category, length: prompt.text.length, source: prompt.source })), null, 2)}\n`);

const sections = { prompt: [], subagent: [], skill: [] };
for (const prompt of prompts) {
  const file = `${prompt.name}.md`;
  const dir = prompt.category === 'skill' ? SKILLS_DIR : prompt.category === 'subagent' ? SUBAGENTS_DIR : PROMPTS_DIR;
  const relativeDir = prompt.category === 'skill' ? 'skills' : prompt.category === 'subagent' ? 'subagents' : 'prompts';
  fs.writeFileSync(path.join(dir, file), [`# ${prompt.name}`, '', prompt.text, ''].join('\n'));
  sections[prompt.category].push(`- [${prompt.name}](${relativeDir}/${file})`);
}

const catalog = [
  `Source binary: ${path.relative(ROOT, grokBin)}`,
  `Grok Build: ${version}`,
  '',
  'Notes:',
  '- The extractor dynamically parses Mach-O sections and uses Rust string-slice records for native prompt components.',
  '- Short prompt fragments are intentionally excluded so generated folders are not polluted with one-line strings.',
  '- Treat extracted files as embedded prompt components, not guaranteed fully composed runtime prompts.',
  '',
  '## Prompts',
  '',
  ...(sections.prompt.length ? sections.prompt : ['- (none)']),
  '',
  '## Subagents',
  '',
  ...(sections.subagent.length ? sections.subagent : ['- (none)']),
  '',
  '## Skills',
  '',
  ...(sections.skill.length ? sections.skill : ['- (none)']),
  '',
  '## Raw Artifacts',
  '',
  '- [grok --help](raw/grok-help.txt)',
  '- [Mach-O section metadata](raw/macho-sections.json)',
  '- [Rust string slice metadata](raw/rust-string-slices.json)',
  '- [prompt candidate metadata](raw/prompt-candidates.json)',
].join('\n');
updateReadmeCatalog(catalog);

console.log(`Parsed Mach-O sections from ${grokBin}`);
console.log(`Wrote ${prompts.length} extracted files`);
console.log(`Updated generated catalog in ${README_FILE}`);
