/**
 * CMake configure 阶段诊断抑制（不影响编译器 -W / clang-cl 标志）。
 *
 * -Wno-dev / -Wno-deprecated / -Wno-unused-cli：cmake 命令行 diagnostic
 * -DCMAKE_WARN_DEPRECATED=OFF：legacy message(DEPRECATION)
 * -DCMAKE_MESSAGE_LOG_LEVEL=ERROR：抑制 message(WARNING)（MPI/XPU/OpenMP/LoadHIP 等）
 */
export const CMAKE_CONFIGURE_QUIET_FLAGS =
  "-Wno-dev -Wno-deprecated -Wno-unused-cli -DCMAKE_WARN_DEPRECATED=OFF -DCMAKE_MESSAGE_LOG_LEVEL=ERROR";

/** ExternalProject `CMAKE_ARGS` 多行缩进追加。 */
export function cmakeConfigureQuietArgsLines(indent = "        "): string {
  return CMAKE_CONFIGURE_QUIET_FLAGS.split(" ")
    .map((flag) => `${indent}${flag}`)
    .join("\n");
}
