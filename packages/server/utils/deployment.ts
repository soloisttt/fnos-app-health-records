import { existsSync } from 'node:fs';
import type { AppRuntimeConfig } from './runtime-config';

export function deploymentType(authMode: AppRuntimeConfig['authMode'], docker = existsSync('/.dockerenv')) {
  return docker ? 'Docker' : authMode === 'fnos' ? 'fnOS' : authMode === 'development' ? 'Development' : 'Unknown';
}

export function feedbackUserAgent(version: string, deployment: string, platform = process.platform as string, arch = process.arch as string) {
  const system = ({ linux: 'Linux', darwin: 'macOS', win32: 'Windows' } as Record<string, string>)[platform] || 'Unknown';
  const architecture = ({ x64: 'x86_64', arm64: 'aarch64', ia32: 'x86', arm: 'arm', riscv64: 'riscv64', ppc64: 'ppc64', s390x: 's390x' } as Record<string, string>)[arch] || 'Unknown';
  return `HealthRecords/${version} (${deployment}; ${system}; ${architecture})`;
}
