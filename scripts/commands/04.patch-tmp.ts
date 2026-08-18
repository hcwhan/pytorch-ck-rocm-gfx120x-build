import { existsSync, globSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gpuArchListIncludesMi3xxForFavV3 } from "../lib/gpu-archs.js";
import { requireLockEnv } from "../lib/require-env.js";

/** 临时 B1 patch 标记；合入 04.patch.ts 后删除本文件与 bootstrap 钩子。 */
const B1_TMP_MARKER = "CK_SDPA_B1_TMP";

type PatchPoint = {
  name: string;
  before: string;
  after: string;
  replaceAll?: boolean;
};

function readNormalized(filePath: string): { content: string; eol: "\n" | "\r\n" } {
  const raw = readFileSync(filePath, "utf8");
  const eol: "\n" | "\r\n" = raw.includes("\r\n") ? "\r\n" : "\n";
  return { content: raw.replace(/\r\n/g, "\n"), eol };
}

function writeNormalized(
  filePath: string,
  content: string,
  eol: "\n" | "\r\n",
): void {
  const out = eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
  writeFileSync(filePath, out, "utf8");
}

function applyPoints(filePath: string, points: PatchPoint[]): void {
  let { content, eol } = readNormalized(filePath);

  for (const point of points) {
    const count = point.replaceAll
      ? content.split(point.before).length - 1
      : content.includes(point.before)
        ? 1
        : 0;
    if (count < 1) {
      throw new Error(`patch-tmp: before-state not found for '${point.name}' in ${filePath}`);
    }
    console.log(`  OK ${point.name}: before-state found (${count})`);
  }

  for (const point of points) {
    content = point.replaceAll
      ? content.replaceAll(point.before, point.after)
      : content.replace(point.before, point.after);
    console.log(`  OK ${point.name}: patched`);
  }

  writeNormalized(filePath, content, eol);
}

function deleteMhaBwdCkObj(ptSrc: string): void {
  const buildDir = path.join(ptSrc, "build");
  if (!existsSync(buildDir)) {
    console.log("  OK mha-bwd-ck-delete-obj: build/ missing, skip");
    return;
  }

  const matches = globSync("**/CMakeFiles/ck_sdpa.dir/**/mha_bwd_ck.hip.obj", {
    cwd: buildDir,
  }).map((rel) => path.join(buildDir, rel));

  if (matches.length === 0) {
    console.log("  OK mha-bwd-ck-delete-obj: object not found (ninja will build fresh)");
    return;
  }

  for (const objPath of matches) {
    unlinkSync(objPath);
    console.log(`  OK mha-bwd-ck-delete-obj: removed ${objPath}`);
  }
}

function buildMhaBwdCkB1Points(): PatchPoint[] {
  return [
    {
      name: "mha-bwd-ck-drop-aiter-include",
      before: `#include <ATen/native/transformers/hip/flash_attn/flash_common_hip.hpp>
#include <mha_bwd.h>
#include <fmha_bwd.hpp>`,
      after: `#include <ATen/native/transformers/hip/flash_attn/flash_common_hip.hpp>
#include <fmha_bwd.hpp>`,
    },
    {
      name: "mha-bwd-ck-b1-marker",
      before: `namespace pytorch_flash {

aiter::mha_bwd_args get_ck_fmha_bwd_args`,
      after: `namespace pytorch_flash {

// ${B1_TMP_MARKER}: gfx120x skip fav_v3 — call fmha_bwd directly (no aiter::mha_bwd link)

fmha_bwd_args get_ck_fmha_bwd_args`,
    },
    {
      name: "mha-bwd-ck-fmha-bwd-args-return",
      before: `    return aiter::mha_bwd_args{
        // aiter args
        static_cast<int>(mask.type),
        hdim <= 192,   // use_asm_v3: ASM v3 only supports head dim <= 192
        true,   // v3_atomic_fp32
        1,      // v3_bf16_cvt
        false,  // v3_api_check

        // From ck fmha_bwd_traits
        hdim,   // hdim_q
        hdim,   // hdim_v
        dtype,  // data_type
        false,  // is_group_mode
        static_cast<int>(mask.type),  // ck_mask_type
        enable_bias ? static_cast<int>(bias_enum::elementwise_bias) : static_cast<int>(bias_enum::no_bias),
        bias_requires_grad,  // has_dbias
        has_dropout,
        false,  // is_store_randval
        deterministic,  // is_deterministic

        // From ck fmha_bwd_args
        q.data_ptr(),`,
      after: `    return fmha_bwd_args{
        q.data_ptr(),`,
    },
    {
      name: "mha-bwd-ck-direct-fmha-bwd-call",
      before: `        auto args =
            get_ck_fmha_bwd_args(
                mask,
                q_dtype_str,
                is_dropout,
                attn_bias_.has_value(),
                deterministic,
                bias_requires_grad,
                batch_size,
                seqlen_q,
                seqlen_k,
                num_heads,
                num_heads_k,
                head_size_8x,
                q,
                k,
                v,
                attn_bias_,
                grad_bias,
                out,
                softmax_lse,
                dout_padded,
                dq_accum,
                softmax_d,
                dq,
                dk_expanded,
                dv_expanded,
                softmax_scale,
                p_dropout,
                drop_seed_offset);

        float t = aiter::mha_bwd(args, stream_config);`,
      after: `        auto ck_args =
            get_ck_fmha_bwd_args(
                mask,
                q_dtype_str,
                is_dropout,
                attn_bias_.has_value(),
                deterministic,
                bias_requires_grad,
                batch_size,
                seqlen_q,
                seqlen_k,
                num_heads,
                num_heads_k,
                head_size_8x,
                q,
                k,
                v,
                attn_bias_,
                grad_bias,
                out,
                softmax_lse,
                dout_padded,
                dq_accum,
                softmax_d,
                dq,
                dk_expanded,
                dv_expanded,
                softmax_scale,
                p_dropout,
                drop_seed_offset);

        fmha_bwd_traits traits{
            head_size_8x,
            head_size_8x,
            q_dtype_str,
            false,
            static_cast<int>(mask.type),
            attn_bias_.has_value() ? static_cast<int>(bias_enum::elementwise_bias)
                                   : static_cast<int>(bias_enum::no_bias),
            bias_requires_grad,
            is_dropout,
            false,
            deterministic,
        };

        float t = fmha_bwd(traits, ck_args, stream_config);`,
    },
  ];
}

/**
 * worktree cache hit 时的增量 B1 patch：skip fav_v3 场景下 mha_bwd_ck 直调 CK Tile fmha_bwd。
 * 不进入 pt-patch-hash，以保持 WORKTREE_CACHE_KEY 不变；成功后合入 04.patch.ts 并删除本模块。
 */
export function runPatchTmp(options: { ptSrc: string }): void {
  const root = path.resolve(options.ptSrc);
  const gpuArchsEnv = requireLockEnv("GPU_ARCHS");

  if (gpuArchListIncludesMi3xxForFavV3(gpuArchsEnv)) {
    console.log(
      `Skip 04.patch-tmp: GPU_ARCHS includes MI3xx (fav_v3 enabled); B1 tmp is gfx120x-only`,
    );
    return;
  }

  const mhaBwdCk = path.join(
    root,
    "aten/src/ATen/native/transformers/hip/flash_attn/ck/mha_bwd_ck.hip",
  );

  const { content } = readNormalized(mhaBwdCk);
  if (content.includes(B1_TMP_MARKER) || content.includes("fmha_bwd(traits, ck_args")) {
    console.log(`  OK mha-bwd-ck-b1: already applied (${mhaBwdCk})`);
  } else {
    applyPoints(mhaBwdCk, buildMhaBwdCkB1Points());
  }

  deleteMhaBwdCkObj(root);
  console.log(`Applied 04.patch-tmp B1 at ${root} (GPU_ARCHS=${gpuArchsEnv})`);
}
