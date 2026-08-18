import { existsSync, globSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gpuArchListIncludesMi3xxForFavV3 } from "../lib/gpu-archs.js";
import { requireLockEnv } from "../lib/require-env.js";

/** 临时 B1 patch 标记；合入 04.patch.ts 后删除本文件与 bootstrap 钩子。 */
const B1_TMP_MARKER = "CK_SDPA_B1_TMP";
const B1_V2_SENTINEL = "get_ck_fmha_bwd_traits";

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

function b1TraitsFunction(): string {
  return `fmha_bwd_traits get_ck_fmha_bwd_traits(const mask_info &mask,
                                         std::string dtype,
                                         int seqlen_q,
                                         int seqlen_k,
                                         int batch,
                                         int head_size,
                                         int nhead_q,
                                         int nhead_k,
                                         bool has_dropout,
                                         bool enable_bias,
                                         bool bias_requires_grad,
                                         bool deterministic)
{
    return fmha_bwd_traits{seqlen_q,
                           seqlen_k,
                           batch,
                           seqlen_q,
                           seqlen_k,
                           head_size,
                           head_size,
                           nhead_q,
                           nhead_k,
                           dtype,
                           false,
                           mask.type,
                           enable_bias ? bias_enum::elementwise_bias : bias_enum::no_bias,
                           bias_requires_grad,
                           has_dropout,
                           false,
                           deterministic};
}

`;
}

function b1ArgsReturnBlock(): string {
  return `    float p_undrop = 1.0 - p_dropout;

    fmha_bwd_args args{};
    args.q_ptr = q.data_ptr();
    args.k_ptr = k.data_ptr();
    args.v_ptr = v.data_ptr();
    args.bias_ptr = attn_bias_ptr;
    args.o_ptr = out.data_ptr();
    args.lse_ptr = softmax_lse.data_ptr();
    args.do_ptr = dout.data_ptr();
    args.d_ptr = d.data_ptr();
    args.rand_val_ptr = nullptr;
    args.dq_ptr = dq.data_ptr();
    args.dk_ptr = dk.data_ptr();
    args.dv_ptr = dv.data_ptr();
    args.dbias_ptr = dbias_ptr;
    args.workspace_ptr = dq_acc.data_ptr();
    args.sink_ptr = nullptr;
    args.d_sink_ptr = nullptr;
    args.seqstart_q_ptr = nullptr;
    args.seqstart_k_ptr = nullptr;
    args.seqlen_q_ptr = nullptr;
    args.seqlen_k_ptr = nullptr;
    args.cu_seqlen_q_ptr = nullptr;
    args.cu_seqlen_k_ptr = nullptr;
    args.seqlen_q = seqlen_q;
    args.seqlen_k = seqlen_k;
    args.batch = b;
    args.max_seqlen_q = seqlen_q;
    args.max_seqlen_k = seqlen_k;
    args.hdim_q = hdim;
    args.hdim_v = hdim;
    args.nhead_q = h;
    args.nhead_k = h_k;
    args.scale = softmax_scale;
    args.stride_q = stride_q;
    args.stride_k = stride_k;
    args.stride_v = stride_v;
    args.stride_bias = stride_attn_bias;
    args.stride_o = stride_o;
    args.stride_randval = 0;
    args.stride_do = stride_do;
    args.stride_dq = stride_dq;
    args.stride_dk = stride_dk;
    args.stride_dv = stride_dv;
    args.stride_dbias = stride_dbias;
    args.nhead_stride_q = nhead_stride_q;
    args.nhead_stride_k = nhead_stride_k;
    args.nhead_stride_v = nhead_stride_v;
    args.nhead_stride_bias = nhead_stride_bias;
    args.nhead_stride_o = nhead_stride_o;
    args.nhead_stride_randval = 0;
    args.nhead_stride_do = nhead_stride_do;
    args.nhead_stride_lsed = nhead_stride_lse;
    args.nhead_stride_dq = nhead_stride_dq;
    args.nhead_stride_dk = nhead_stride_dk;
    args.nhead_stride_dv = nhead_stride_dv;
    args.nhead_stride_dbias = nhead_stride_dbias;
    args.batch_stride_q = batch_stride_q;
    args.batch_stride_k = batch_stride_k;
    args.batch_stride_v = batch_stride_v;
    args.batch_stride_bias = batch_stride_bias;
    args.batch_stride_o = batch_stride_o;
    args.batch_stride_randval = 0;
    args.batch_stride_do = batch_stride_do;
    args.batch_stride_lsed = batch_stride_lse;
    args.batch_stride_dq = batch_stride_dq;
    args.batch_stride_dk = batch_stride_dk;
    args.batch_stride_dv = batch_stride_dv;
    args.batch_stride_dbias = batch_stride_dbias;
    args.window_size_left = mask.left;
    args.window_size_right = mask.right;
    args.mask_type = static_cast<ck_tile::index_t>(mask.type);
    args.p_drop = p_dropout;
    args.p_undrop = p_undrop;
    args.drop_seed_offset = drop_seed_offset;
    return args;`;
}

function b1CallSiteBlock(): string {
  return `        auto traits = get_ck_fmha_bwd_traits(
                mask,
                q_dtype_str,
                seqlen_q,
                seqlen_k,
                batch_size,
                head_size_8x,
                num_heads,
                num_heads_k,
                is_dropout,
                attn_bias_.has_value(),
                bias_requires_grad,
                deterministic);

        auto ck_args =
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

        float t = fmha_bwd(traits, ck_args, stream_config);`;
}

/** worktree 缓存中 Run #32105033671 已写入的 B1-v1（错误 brace-list）→ v2 升级 */
function buildB1V2UpgradeFromV1Points(): PatchPoint[] {
  return [
    {
      name: "mha-bwd-ck-v2-insert-traits-fn",
      before: `// ${B1_TMP_MARKER}: gfx120x skip fav_v3 — call fmha_bwd directly (no aiter::mha_bwd link)

fmha_bwd_args get_ck_fmha_bwd_args`,
      after: `// ${B1_TMP_MARKER}: gfx120x skip fav_v3 — call fmha_bwd directly (no aiter::mha_bwd link)

${b1TraitsFunction()}fmha_bwd_args get_ck_fmha_bwd_args`,
    },
    {
      name: "mha-bwd-ck-v2-remove-dq-acc-strides",
      before: `    // dq_acc: (split, batch_size, nheads, seqlen_q, hdim)
    ck_tile::index_t split_stride_dq_acc = dq_acc.stride(0);
    ck_tile::long_index_t batch_stride_dq_acc = dq_acc.stride(1);
    ck_tile::index_t stride_dq_acc = dq_acc.stride(3);
    ck_tile::long_index_t nhead_stride_dq_acc = dq_acc.stride(2);

    // bias:`,
      after: `    // bias:`,
    },
    {
      name: "mha-bwd-ck-v2-args-field-assignment",
      before: `    float p_undrop = 1.0 - p_dropout;

    return fmha_bwd_args{
        q.data_ptr(),
        k.data_ptr(),
        v.data_ptr(),
        attn_bias_ptr,
        out.data_ptr(),  // o_ptr
        softmax_lse.data_ptr(),  // lse_ptr
        dout.data_ptr(),  // do_ptr
        d.data_ptr(),
        nullptr,  // rand_val_ptr
        dq.data_ptr(),
        dk.data_ptr(),
        dv.data_ptr(),
        dbias_ptr,
        dq_acc.data_ptr(),  // dq_acc_ptr
        nullptr,  // seqstart_q_ptr
        nullptr,  // seqstart_k_ptr
        nullptr,  // seqlen_q_ptr
        nullptr,  // seqlen_k_ptr
        nullptr,  // cu_seqlen_q_ptr
        nullptr,  // cu_seqlen_k_ptr
        seqlen_q,
        seqlen_k,
        b,  // batch
        seqlen_q,  // max_seqlen_q
        seqlen_k,  // max_seqlen_k
        h,  // nhead_q
        h_k,  // nhead_k
        softmax_scale,  // scale
        stride_q,
        stride_k,
        stride_v,
        stride_attn_bias,  // stride_bias
        stride_o,
        0,  // stride_randval
        stride_do,
        stride_dq_acc,
        stride_dq,
        stride_dk,
        stride_dv,
        stride_dbias,
        nhead_stride_q,
        nhead_stride_k,
        nhead_stride_v,
        nhead_stride_bias,
        nhead_stride_o,
        0,  // nhead_stride_randval
        nhead_stride_do,
        nhead_stride_lse,
        nhead_stride_dq_acc,
        nhead_stride_dq,
        nhead_stride_dk,
        nhead_stride_dv,
        nhead_stride_dbias,
        batch_stride_q,
        batch_stride_k,
        batch_stride_v,
        batch_stride_bias,
        batch_stride_o,
        0,  // batch_stride_randval
        batch_stride_do,
        batch_stride_lse,
        batch_stride_dq_acc,
        batch_stride_dq,
        batch_stride_dk,
        batch_stride_dv,
        batch_stride_dbias,
        split_stride_dq_acc,
        mask.left,  // window_size_left
        mask.right,  // window_size_right
        p_dropout,  // p_drop
        p_undrop,
        drop_seed_offset
    };`,
      after: b1ArgsReturnBlock(),
    },
    {
      name: "mha-bwd-ck-v2-call-site",
      before: `        auto ck_args =
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
      after: b1CallSiteBlock(),
    },
  ];
}

/** 上游 aiter 版（cache miss 或未写入 v1 的 restore）→ 直接 v2 */
function buildB1V2FromUpstreamPoints(): PatchPoint[] {
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
      name: "mha-bwd-ck-v2-header-and-traits",
      before: `namespace pytorch_flash {

aiter::mha_bwd_args get_ck_fmha_bwd_args`,
      after: `namespace pytorch_flash {

// ${B1_TMP_MARKER}: gfx120x skip fav_v3 — call fmha_bwd directly (no aiter::mha_bwd link)

${b1TraitsFunction()}fmha_bwd_args get_ck_fmha_bwd_args`,
    },
    {
      name: "mha-bwd-ck-v2-remove-dq-acc-strides-upstream",
      before: `    // dq_acc: (split, batch_size, nheads, seqlen_q, hdim)
    ck_tile::index_t split_stride_dq_acc = dq_acc.stride(0);
    ck_tile::long_index_t batch_stride_dq_acc = dq_acc.stride(1);
    ck_tile::index_t stride_dq_acc = dq_acc.stride(3);
    ck_tile::long_index_t nhead_stride_dq_acc = dq_acc.stride(2);

    // bias:`,
      after: `    // bias:`,
    },
    {
      name: "mha-bwd-ck-v2-replace-aiter-return",
      before: `    float p_undrop = 1.0 - p_dropout;

    return aiter::mha_bwd_args{
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
        q.data_ptr(),
        k.data_ptr(),
        v.data_ptr(),
        attn_bias_ptr,
        out.data_ptr(),  // o_ptr
        softmax_lse.data_ptr(),  // lse_ptr
        dout.data_ptr(),  // do_ptr
        d.data_ptr(),
        nullptr,  // rand_val_ptr
        dq.data_ptr(),
        dk.data_ptr(),
        dv.data_ptr(),
        dbias_ptr,
        dq_acc.data_ptr(),  // dq_acc_ptr
        nullptr,  // seqstart_q_ptr
        nullptr,  // seqstart_k_ptr
        nullptr,  // seqlen_q_ptr
        nullptr,  // seqlen_k_ptr
        nullptr,  // cu_seqlen_q_ptr
        nullptr,  // cu_seqlen_k_ptr
        seqlen_q,
        seqlen_k,
        b,  // batch
        seqlen_q,  // max_seqlen_q
        seqlen_k,  // max_seqlen_k
        h,  // nhead_q
        h_k,  // nhead_k
        softmax_scale,  // scale
        stride_q,
        stride_k,
        stride_v,
        stride_attn_bias,  // stride_bias
        stride_o,
        0,  // stride_randval
        stride_do,
        stride_dq_acc,
        stride_dq,
        stride_dk,
        stride_dv,
        stride_dbias,
        nhead_stride_q,
        nhead_stride_k,
        nhead_stride_v,
        nhead_stride_bias,
        nhead_stride_o,
        0,  // nhead_stride_randval
        nhead_stride_do,
        nhead_stride_lse,
        nhead_stride_dq_acc,
        nhead_stride_dq,
        nhead_stride_dk,
        nhead_stride_dv,
        nhead_stride_dbias,
        batch_stride_q,
        batch_stride_k,
        batch_stride_v,
        batch_stride_bias,
        batch_stride_o,
        0,  // batch_stride_randval
        batch_stride_do,
        batch_stride_lse,
        batch_stride_dq_acc,
        batch_stride_dq,
        batch_stride_dk,
        batch_stride_dv,
        batch_stride_dbias,
        split_stride_dq_acc,
        mask.left,  // window_size_left
        mask.right,  // window_size_right
        p_dropout,  // p_drop
        p_undrop,
        drop_seed_offset
    };`,
      after: b1ArgsReturnBlock(),
    },
    {
      name: "mha-bwd-ck-v2-call-site-upstream",
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
      after: b1CallSiteBlock(),
    },
  ];
}

function detectMhaBwdCkState(content: string): "v2" | "v1" | "upstream" {
  if (content.includes(B1_V2_SENTINEL) && content.includes("args.workspace_ptr = dq_acc.data_ptr()")) {
    return "v2";
  }
  if (
    content.includes(B1_TMP_MARKER) ||
    content.includes("fmha_bwd(traits, ck_args") ||
    (content.includes("fmha_bwd_args get_ck_fmha_bwd_args") && !content.includes("aiter::mha_bwd_args"))
  ) {
    return "v1";
  }
  if (content.includes("aiter::mha_bwd_args") || content.includes("aiter::mha_bwd(args")) {
    return "upstream";
  }
  throw new Error("patch-tmp: unrecognized mha_bwd_ck.hip state (not upstream, v1, or v2)");
}

/**
 * worktree cache hit 时的增量 B1 patch：skip fav_v3 场景下 mha_bwd_ck 直调 CK Tile fmha_bwd。
 * 支持 upstream / 已缓存 B1-v1（Run #32105033671 save）→ B1-v2 升级。
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
  const state = detectMhaBwdCkState(content);

  if (state === "v2") {
    console.log(`  OK mha-bwd-ck-b1-v2: already applied (${mhaBwdCk})`);
  } else if (state === "v1") {
    console.log(`  OK mha-bwd-ck-b1-v2: upgrading cached B1-v1 → v2`);
    applyPoints(mhaBwdCk, buildB1V2UpgradeFromV1Points());
  } else {
    console.log(`  OK mha-bwd-ck-b1-v2: applying from upstream`);
    applyPoints(mhaBwdCk, buildB1V2FromUpstreamPoints());
  }

  deleteMhaBwdCkObj(root);
  console.log(`Applied 04.patch-tmp B1-v2 at ${root} (GPU_ARCHS=${gpuArchsEnv})`);
}
