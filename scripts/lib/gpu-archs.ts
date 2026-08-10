const CANONICAL_CK_TARGET_ORDER = ["gfx9", "gfx950", "gfx12"] as const;

const HIP_TO_CK_TARGET: Record<string, (typeof CANONICAL_CK_TARGET_ORDER)[number]> =
  {
    gfx908: "gfx9",
    gfx90a: "gfx9",
    gfx940: "gfx9",
    gfx941: "gfx9",
    gfx942: "gfx9",
    gfx943: "gfx9",
    gfx950: "gfx950",
    gfx1200: "gfx12",
    gfx1201: "gfx12",
  };

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

export function hipArchToCkTarget(hipArch: string): string {
  const normalized = hipArch.trim().toLowerCase();
  const ckTarget = HIP_TO_CK_TARGET[normalized];
  if (!ckTarget) {
    throw new Error(
      `GPU arch ${hipArch} has no CK FMHA target mapping; extend HIP_TO_CK_TARGET in gpu-archs.ts`,
    );
  }
  return ckTarget;
}

export function deriveCkTargetFamilies(gpuArchs: string): string[] {
  const families = new Set<string>();
  for (const arch of parseGpuArchList(gpuArchs)) {
    families.add(hipArchToCkTarget(arch));
  }
  return CANONICAL_CK_TARGET_ORDER.filter((target) => families.has(target));
}

export function formatCkTargetsFlag(gpuArchs: string): string {
  const families = deriveCkTargetFamilies(gpuArchs);
  if (families.length < 1) {
    throw new Error(`CK target families are empty for GPU_ARCHS=${gpuArchs}`);
  }
  return `--targets ${families.join(",")}`;
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
