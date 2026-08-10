export function parseGpuArchList(gpuArchs: string): string[] {
  const parts = gpuArchs
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 1) {
    throw new Error(`GPU_ARCHS is missing or empty: ${gpuArchs}`);
  }
  return parts;
}

export function formatGpuArchCppStrings(gpuArchs: string[]): string {
  return gpuArchs.map((arch) => `"${arch}"`).join(", ");
}

export function formatGpuArchCppDefines(gpuArchs: string[]): string {
  return gpuArchs.map((arch) => `defined(__${arch}__)`).join(" || \\\n ");
}

export function formatGpuArchCmakeList(gpuArchs: string[]): string {
  return gpuArchs.join(" ");
}
