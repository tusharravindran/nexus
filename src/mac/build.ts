import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LaunchError } from '../errors.ts';

const NATIVE = fileURLToPath(new URL('../../native/mac/', import.meta.url));
const BUILD = path.join(NATIVE, '.build');

/**
 * Compiles a Swift program on first use and again only when its source
 * changes (a hash stamp sits next to the binary). Needs the Xcode command line
 * tools (`xcode-select --install`).
 */
async function buildSwift(source: string, output: string, frameworks: string[]): Promise<string> {
  if (process.platform !== 'darwin') throw new LaunchError('Desktop automation is only available on macOS');
  const code = await readFile(source);
  const hash = createHash('sha256').update(code).digest('hex');
  const stamp = `${output}.sha256`;
  if (existsSync(output) && existsSync(stamp) && (await readFile(stamp, 'utf8')).trim() === hash) return output;

  if (spawnSync('swiftc', ['--version'], { stdio: 'ignore' }).status !== 0) {
    throw new LaunchError('Desktop automation needs the Swift compiler: run `xcode-select --install`');
  }
  await mkdir(path.dirname(output), { recursive: true });
  const args = ['-O', '-swift-version', '5', '-o', output, source, ...frameworks.flatMap((framework) => ['-framework', framework])];
  const errors = await new Promise<string>((resolve, reject) => {
    const compiler = spawn('swiftc', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    compiler.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    compiler.on('error', reject);
    compiler.on('exit', (status) => (status === 0 ? resolve('') : resolve(stderr || `swiftc exited with ${status}`)));
  });
  if (errors) throw new LaunchError(`Building ${path.basename(output)} failed:\n${errors.slice(-3000)}`);
  await writeFile(stamp, hash);
  return output;
}

/** The nexus-mac helper binary, built if needed. */
export function ensureHelper(): Promise<string> {
  return buildSwift(path.join(NATIVE, 'main.swift'), path.join(BUILD, 'nexus-mac'), ['AppKit', 'ApplicationServices']);
}

/**
 * The test fixture app (a window with known controls), built as a minimal
 * .app bundle so it can be launched and activated like any app.
 */
export async function ensureFixtureApp(): Promise<string> {
  const bundle = path.join(BUILD, 'NexusFixture.app');
  await buildSwift(path.join(NATIVE, 'fixture', 'main.swift'), path.join(bundle, 'Contents', 'MacOS', 'NexusFixture'), ['AppKit']);
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  if (!existsSync(plist)) {
    await writeFile(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.nexus.fixture</string>
  <key>CFBundleName</key><string>NexusFixture</string>
  <key>CFBundleExecutable</key><string>NexusFixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`,
    );
  }
  return bundle;
}
