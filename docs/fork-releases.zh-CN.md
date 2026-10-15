# 二开版发布（lauchiwa/edgeever）

本仓库是上游 EdgeEver（`tianma-if/edgeever`）的二次开发 fork。它在自己的 Releases 页面构建并发布 Windows 桌面版，已安装的二开客户端只从这里更新。不会向上游写入任何内容。English: [fork-releases.md](fork-releases.md).

当前范围：**仅 Windows x64 桌面端。**不发布 macOS、Linux、Android 和 iOS 的二开版本（Windows 验证稳定后再支持 Linux）。

## 版本号

```text
vX.Y.Z-rc.N
```

- `X.Y.Z` 是本 fork 同步的上游正式版本号，原样照抄。`main` 的 `package.json` 保持这个不带后缀的版本号；只在构建发布时写入后缀（`fork-release-version.mjs apply`）。
- `N` 是本 fork 在该上游版本上的发布次数，从 `0` 开始。

```text
同步上游 1.119.0        v1.119.0-rc.0
发布一次二开改动        v1.119.0-rc.1
上游发布 1.120.0        v1.120.0-rc.0
```

**不发布不带后缀的 `vX.Y.Z`：**按 SemVer 规则，它高于所有 `-rc.N`，会让客户端永久停留在该版本。`rc` 是自定义渠道：electron-updater 只会向 `rc` 客户端提供其他 `rc` 版本；`alpha`/`beta` 则还会接受正式版。发布顺序必须单调递增：更新器会选取最近发布的 `rc` 版本，`fork-release-version.mjs next` 会拒绝低于已发布版本的基线。

## 二开差异及其保护机制

| 方面 | 二开行为 | 保护 |
| --- | --- | --- |
| 仓库身份 | `apps/desktop/src/main/fork-config.mjs`（渲染端对应 `packages/shared/src/fork-config.ts`） | `scripts/fork-invariants.test.mjs` |
| 自动更新 | electron-builder 发布到本 fork 并从本 fork 更新；渠道文件为 `rc.yml` | 不变量测试、`windows-update-metadata.test.mjs` |
| Windows 更新签名 | 只信任本 fork 的 Ed25519 密钥，只接受 `X.Y.Z-rc.N` | `windows-update-trust.test.mjs`、固定的公钥指纹 |
| 链接 | 诊断、反馈、桌面端下载指向 fork；保留 5 处有意指向上游的链接（Android APK、服务端 Release 说明、插件文档） | 上游地址扫描及白名单 |
| ACP | Windows ACP 修复 | ACP 测试、不变量测试 |

需要不变量测试，是因为上游合并可能没有冲突，却悄悄撤销二开逻辑，例如新增一处写死 `tianma-if/edgeever` 的代码。

## 签名密钥

- 两把 Ed25519 密钥：**主密钥**用于签名发布；**备用密钥**冷存储，只在主密钥丢失或泄露时，用于签发一次密钥轮换更新。两把公钥都固定在 `fork-config.mjs` 中，指纹固定在不变量测试中。
- 私钥是用口令加密的 PKCS#8 文件，存放在仓库外，由 `scripts/fork-generate-update-keys.mjs` 生成。私钥**从不进入 GitHub**（不使用 Actions Secret），因此即使工作流或令牌被入侵，也无法签发客户端会接受的更新。
- **两把私钥都丢失时，已安装的客户端将无法再自动更新，只能手动重装。**请在密码管理器或加密的离线存储中备份。

## 同步上游版本

只跟随上游**正式 Release**，不跟随上游 `main`。`main` 受保护（只能通过 PR 合入，禁止强制推送和删除）。上游的 `sync-edgeever-upstream.yml` 已在本仓库设置中停用，因为它会把 `main` 重置为上游快照。

1. `fork-upstream-watch.yml` 每天检查一次。上游有未合入的新版本时，该运行会失败（Issues 已关闭，所以以失败邮件作为通知），摘要中会给出要执行的命令。
2. 在干净的工作区本地执行：

   ```sh
   node scripts/fork-sync-upstream.mjs start vX.Y.Z
   ```

   它会从 `origin/main` 创建 `sync/vX.Y.Z` 分支并合并上游 tag。**它从不推送**，上游 tag 也不会进入 `refs/tags`。
3. 遇到冲突时，它会保留合并状态并停下。解决冲突时保留二开逻辑（fork-config、Windows 更新签名、ACP 修复），然后执行 `git commit`。
4. 运行检查，推送分支并创建 PR；必须通过 `fork-ci.yml`。

   ```sh
   bun install --frozen-lockfile
   bun test scripts/fork-invariants.test.mjs
   bun run typecheck && bun run typecheck:mobile && bun run build:web
   git push -u origin sync/vX.Y.Z
   ```

**不要在 fork 中新增数据库 Migration：**Migration 使用递增编号，会与上游后续编号冲突。

## 发布

1. 在最新的 `main` 上生成并推送 tag：

   ```sh
   git switch main && git pull --ff-only && git fetch --tags
   node scripts/fork-release-version.mjs next      # 例如 v1.119.0-rc.0
   git tag v1.119.0-rc.0 && git push origin v1.119.0-rc.0
   ```

2. `fork-release.yml` 会检查 tag 是否位于 `main` 上，写入版本号，运行发布检查（包括两把公钥都已固定），构建并试启动 Windows 应用，然后上传一个 **Draft** 预发布版本，包含安装包、`rc.yml`、`latest-windows.json` 和 `SHA256SUMS-windows.txt`。**它从不签名。**
3. 在本机签名并发布（使用 PowerShell 或 Windows Terminal，不要用 Git Bash）：

   ```powershell
   $env:EDGE_EVER_WINDOWS_UPDATE_SIGNING_KEY = "$HOME\.config\edgeever-fork\windows-update-ed25519-primary.pem"
   node scripts/fork-sign-release.mjs v1.119.0-rc.0 --publish
   ```

   它会签名 `latest-windows.json`，上传签名，重新下载全部 5 个资产，按客户端的方式完整校验，校验通过后才发布。不加 `--publish` 时，只签名和校验，保留为 Draft。客户端看不到 Draft，所以任何失败都可以安全重试。

基线版本打错的 tag 不需要删除，发布一个正确且更高的 tag 即可。**不要删除或重新签名已发布的版本。**

## 已安装的客户端

- 在 fork 更新源建立之前构建的版本（例如不带后缀的 `1.119.0`），无法自动更新到版本更低的 `1.119.0-rc.0`。第一个 fork 版本需要手动安装；之后的 fork 版本可以原地自动更新。
- 安装包保持相同的 appId 和数据目录，所以在上游版本上覆盖安装 fork 版本，会保留本地数据。
