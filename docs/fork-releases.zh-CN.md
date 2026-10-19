# 二开版发布（lauchiwa/edgeever）

本仓库是上游 EdgeEver（`tianma-if/edgeever`）的二次开发 fork。它在自己的 Releases 页面构建并发布 Windows、Linux 与 macOS 桌面版，已安装的二开客户端只从这里更新。不会向上游写入任何内容。English: [fork-releases.md](fork-releases.md).

当前范围：**Windows x64 桌面端、Linux x64 AppImage、macOS arm64 与 x64（见 [macOS](#macos)），以及服务端镜像** `ghcr.io/lauchiwa/edgeever`（API 与浏览器 Web 端）。不发布 Android 和 iOS 的二开版本。Android 只有作为工作流产物的**测试版**，见 [Android 测试版](#android-测试版)。[加密笔记](encrypted-notes.zh-CN.md)等二开功能需要二开客户端与运行二开镜像的服务端同时具备。

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
| 自动更新 | electron-builder 发布到本 fork 并从本 fork 更新；渠道文件为 `rc.yml`（Windows）、`rc-linux.yml`（Linux）和 `rc-mac.yml`（macOS） | 不变量测试、`windows-update-metadata.test.mjs`、`fork-linux-release.test.mjs`、`fork-macos-release.test.mjs` |
| Windows 更新签名 | 只信任本 fork 的 Ed25519 密钥，只接受 `X.Y.Z-rc.N` | `windows-update-trust.test.mjs`、固定的公钥指纹 |
| Linux 更新校验 | 与上游 Linux 预览版相同：来自本 fork Releases 的 HTTPS 下载、`rc-linux.yml` 中的 sha512（electron-updater 校验）和独立的 `SHA256SUMS-linux.txt`；**没有签名清单** | `fork-linux-release.test.mjs`、发布前的真实 AppImage 跨版本更新 |
| macOS 更新校验 | 应用使用本 fork 的自签名证书签名；electron-updater 先校验 `rc-mac.yml` 中的 sha512，Squirrel.Mac 再要求更新满足正在运行应用的指定要求（designated requirement：bundle id `org.edgeever.desktop`，以及任一固定证书的 SHA-1）才会安装；`SHA256SUMS-macos.txt` 列出全部 zip 与磁盘映像。未经公证 | `fork-macos-release.test.mjs`、不变量测试、发布前在两种架构上做真实的已签名应用跨版本更新 |
| 链接 | 诊断、反馈、桌面端下载指向 fork；服务端 Release 说明在二开镜像（`vX.Y.Z-rc.N`）下指向 fork，否则指向上游；保留若干有意指向上游的链接（Android APK 下载、上游服务端 Release 说明、插件文档、移动端的上游更新检查与主页链接、固定到上游 commit 的海报字体） | 上游地址扫描及白名单 |
| Android 测试版 | 沿用包名 `org.edgeever.mobile`，使用二开 keystore；关闭 expo-updates 和应用内 APK 更新，上游 OTA 更新不会替换二开代码；原生解锁加密笔记 | 不变量测试、`fork-workflows.test.mjs`、`fork-android.yml` 中的 manifest 检查 |
| ACP | Windows ACP 修复 | ACP 测试、不变量测试 |
| 加密笔记 | 客户端加密；服务端拒绝明文覆盖，并通告 `features.encryptedNotes` | `encrypted-note*.test.mjs`、`tests/e2e/encrypted-note.spec.ts` |
| 服务端镜像 | `fork-docker-image.yml` 只发布 rc tag，从不发布 `latest` | `fork-workflows.test.mjs` |

需要不变量测试，是因为上游合并可能没有冲突，却悄悄撤销二开逻辑，例如新增一处写死 `tianma-if/edgeever` 的代码。

## 签名密钥

- 两把 Ed25519 密钥：**主密钥**用于签名发布；**备用密钥**冷存储，只在主密钥丢失或泄露时，用于签发一次密钥轮换更新。两把公钥都固定在 `fork-config.mjs` 中，指纹固定在不变量测试中。
- 私钥是用口令加密的 PKCS#8 文件，存放在仓库外，由 `scripts/fork-generate-update-keys.mjs` 生成。
- 为了无需手动步骤即可发布，**主密钥**及其口令保存为 GitHub Environment `fork-release` 的 Secret。只有发布工作流的 `publish` 任务能读取它们；该任务不安装任何依赖，只运行仓库内无依赖的脚本。代价是：**控制了本 GitHub 账号或某次发布运行的人，可以签发已安装客户端会接受的更新。**备用密钥从不进入 GitHub，所以主密钥泄露后，仍可在本机用备用密钥签发一次密钥轮换更新。
- 由你本人在 Windows Terminal 中设置或替换这两个 Secret（`cmd` 重定向让私钥不经过 shell，口令为隐藏输入）：

  ```powershell
  cmd /c "gh secret set FORK_WINDOWS_UPDATE_SIGNING_KEY --env fork-release -R lauchiwa/edgeever < %USERPROFILE%\.config\edgeever-fork\windows-update-ed25519-primary.pem"
  gh secret set FORK_WINDOWS_UPDATE_SIGNING_PASSPHRASE --env fork-release -R lauchiwa/edgeever
  ```
- **两把私钥都丢失时，已安装的客户端将无法再自动更新，只能手动重装。**请在密码管理器或加密的离线存储中备份。

### macOS 签名证书

没有 Apple Developer ID，macOS 版本使用两张自签名证书（RSA-3072，有效期 20 年）进行代码签名：**主证书**签名每个版本；**备用证书**冷存储，用于签发轮换版本。每个二开应用都带有同时指定这两张证书的指定要求，所以之后由任一证书签名的应用都能覆盖安装它；换用第三张证书前，必须先用这两张之一签发一个过渡版本。**两把私钥都丢失时，已安装的 Mac 只能手动重装。**

一次性配置，由维护者本人完成（代理不读取私钥及口令），可以在 Mac 或 Windows 上进行：

1. 创建 Environment：Settings → Environments → New environment `fork-macos`，部署规则与 `fork-release` 相同。先设置部署规则，再添加 Secret。
2. 在仓库目录下运行（需要 Node 24；口令为隐藏输入，使用两个新的、至少 16 个字符的口令）。Mac 上在终端中运行：

   ```sh
   node scripts/fork-generate-macos-signing-certificates.mjs
   ```

   Windows 上在 PowerShell 或 Windows Terminal 中运行（Git Bash 无法隐藏输入）：

   ```powershell
   node scripts/fork-generate-macos-signing-certificates.mjs --skip-self-test
   ```

   在 Mac 上，写入任何文件之前，它会在临时钥匙串中用每个身份签名一个测试二进制文件并校验结果（`"selfTested": true`）。在其他系统上跳过这项自检（`"selfTested": false`）：`macos-sign` 和 `macos-verify` 任务仍会在任何版本发布前检查主证书，但备用证书要到签发轮换版本时才会被实际使用，有 Mac 时应补做自检。本地签名版本也需要 Mac。两种方式都会把加密私钥和 `macos-signing-certificates.json` 写入 `~/.config/edgeever-fork`（Windows 上为 `%USERPROFILE%\.config\edgeever-fork`），并输出两张证书。
3. 通过 PR 把两个 `certificatePem` 固定到 `apps/desktop/src/main/fork-config.mjs` 的 `FORK_MACOS_SIGNING_CERTIFICATES` 中。在此之前，发布检查会拒绝构建版本。
4. 保存主私钥及其口令。Mac 上：

   ```sh
   gh secret set FORK_MACOS_SIGNING_KEY --env fork-macos -R lauchiwa/edgeever < ~/.config/edgeever-fork/macos-signing-rsa-primary.pem
   gh secret set FORK_MACOS_SIGNING_PASSPHRASE --env fork-macos -R lauchiwa/edgeever
   ```

   Windows 上：

   ```powershell
   cmd /c "gh secret set FORK_MACOS_SIGNING_KEY --env fork-macos -R lauchiwa/edgeever < %USERPROFILE%\.config\edgeever-fork\macos-signing-rsa-primary.pem"
   gh secret set FORK_MACOS_SIGNING_PASSPHRASE --env fork-macos -R lauchiwa/edgeever
   ```

5. 把 `macos-signing-rsa-backup.pem` 移到离线存储，两个口令保存在密码管理器中。

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

2. 其余步骤由 `fork-release.yml` 自动完成，无需手动操作：
   - `windows`、`linux` 与 `macos`（arm64 和 x64）任务并行运行，都只持有只读令牌、读不到任何签名密钥。它们都会检查 tag 是否位于 `main` 上、运行发布检查（包括两把公钥都已固定）、写入版本号并构建和试启动应用：
     - `windows` 产出安装包、`rc.yml`、`latest-windows.json` 和 `SHA256SUMS-windows.txt`。
     - `linux` 在 Ubuntu 22.04（glibc 2.35 基线）上产出 AppImage、`rc-linux.yml` 和 `SHA256SUMS-linux.txt`，并做一次真实的跨版本自动更新：旧 AppImage 从只提供本次资产的本地更新源下载新 AppImage，替换自身后以新版本重启。旧版本取上一个带 Linux 资产的已发布二开版本；还没有时，用同一份源码按 `0.0.1-rc.0` 构建。
     - `macos` 为每种架构构建未签名的应用及其更新前置版本（选取方式与 Linux 相同）。
   - `macos-sign` 在 `fork-macos` Environment 中运行，不安装任何依赖，用主证书签名两个应用（以及构建出的前置版本），再分别打包成 zip、磁盘映像、`rc-mac.yml` 和 `SHA256SUMS-macos.txt`。
   - `macos-verify` 校验签名、启动每个已签名应用，并在两种架构上做真实的跨版本更新：旧的已签名应用从本地更新源下载新 zip，Squirrel.Mac 按正在运行应用的指定要求校验后替换应用包，替换后的应用必须与已签名应用完全一致。
   - `draft` 任务只在所有平台都通过后运行，把全部 13 个资产上传为 **Draft** 预发布版本。任一平台失败都不会创建或改动 Draft。
   - `publish` 任务签名 `latest-windows.json`，上传签名，重新下载全部 14 个资产，按客户端的方式完整校验 Windows、Linux 与 macOS 资产，校验通过后才发布。

   客户端看不到 Draft，所以失败后可以安全重试：修复原因后，用同一个 tag 手动运行工作流（Actions → Fork release → 在 `main` 上 Run workflow）。
3. 本机兜底方式，例如 Environment Secret 不可用时（使用 PowerShell 或 Windows Terminal，不要用 Git Bash；口令会提示输入）：

   ```powershell
   $env:EDGE_EVER_WINDOWS_UPDATE_SIGNING_KEY = "$HOME\.config\edgeever-fork\windows-update-ed25519-primary.pem"
   node scripts/fork-sign-release.mjs v1.119.0-rc.0 --publish
   ```

同一个 tag 还会触发 `fork-docker-image.yml` 构建服务端镜像（见下文）。两个工作流互相独立：镜像构建失败不会阻塞桌面端发布，可以用同一个 tag 手动运行该工作流重建。

基线版本打错的 tag 不需要删除，发布一个正确且更高的 tag 即可。**不要删除或重新签名已发布的版本。**

## 服务端镜像

`fork-docker-image.yml` 在 `main` 上的每个 `vX.Y.Z-rc.N` tag 上运行：

- `test` 构建并运行镜像，检查健康状态、Web 端、`/data` 下的 SQLite、`features.encryptedNotes` 以及优雅退出。
- `publish` 把 `linux/amd64` 和 `linux/arm64` 推送到 `ghcr.io/lauchiwa/edgeever`，然后重新拉取并运行已推送的镜像。

镜像 tag：`:vX.Y.Z-rc.N`、`:X.Y.Z-rc.N`，以及跟随最高 rc tag 移动的 `:rc`。**从不发布 `:latest`**，因此仍使用上游默认值的服务端不会意外拉到二开镜像，反之亦然。

新建的 GHCR 包通常默认私有；匿名拉取失败时，`publish` 摘要会给出警告。可以将其设为公开（GitHub → Packages → edgeever → Package settings → Change visibility），或在服务器上用具有 `read:packages` 权限的令牌执行 `docker login ghcr.io`。

### 将服务端切换到二开镜像

安装器每天运行的 `update.sh` 会沿用 `~/edgeever/.env` 中指定的镜像，所以切换只需改该文件中的两行。**先做冷备份：**如果二开镜像的上游基线较旧，它会运行在已被更新的上游镜像迁移过的数据库上。

```sh
cd ~/edgeever
docker compose --env-file .env stop edgeever
docker run --rm -v edgeever_edgeever-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/edgeever-data-$(date +%Y%m%d%H%M).tgz -C /data .
# 修改 .env：
#   EDGE_EVER_IMAGE='ghcr.io/lauchiwa/edgeever'
#   EDGE_EVER_VERSION='v1.119.0-rc.4'   # 固定版本；或写 'rc' 跟随二开发布
docker compose --env-file .env pull && docker compose --env-file .env up -d
curl -fsS http://127.0.0.1:8787/api/v1/auth/session   # 应包含 features.encryptedNotes: true
```

先用 `docker volume ls` 确认数据卷名称。**不要切换到 `X.Y.Z` 低于服务器当前上游版本的二开镜像**，应先同步上游。

回滚：停止服务，把 `EDGE_EVER_IMAGE` 和 `EDGE_EVER_VERSION` 恢复为原值，将 `/data` 备份恢复到空数据卷，然后重新启动。在上游镜像下加密笔记仍是密文：只有切回二开镜像后才能读取，在上游版本中编辑它们会将其覆盖。

## Android 测试版

`fork-android.yml` 构建一个 arm64-v8a APK，供手工测试。它不是 Release 资产，也不会自动更新。

- 修改了移动端的 PR 只运行 `build`：类型检查、加密笔记测试、prebuild、检查 expo-updates 已关闭，以及 Gradle release 构建。这里读不到任何 Secret。
- 在 Actions → Fork Android test build → Run workflow（选 `main`）手动运行时，还会运行 `sign`。它在 `fork-android` Environment 中运行，不安装任何依赖，用二开 keystore 签名 APK，并且只有唯一签名者与 `FORK_ANDROID_SIGNER_SHA256` 一致时才通过。从该运行下载 `edgeever-fork-android-apk`（保留 30 天），摘要中给出其 SHA-256。

一次性配置 keystore，由维护者本人完成（PowerShell；代理不读取 keystore 及其口令）：

1. 创建 Environment：Settings → Environments → New environment `fork-android`，部署分支限制为 `main`。
2. 生成密钥（`keytool` 会提示输入口令；PKCS12 的密钥口令与之相同）：

   ```powershell
   keytool -genkeypair -v -storetype PKCS12 -keystore "$HOME\.config\edgeever-fork\android-fork.p12" -alias edgeever-fork -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=EdgeEver fork"
   keytool -list -v -keystore "$HOME\.config\edgeever-fork\android-fork.p12" -alias edgeever-fork
   ```

3. 保存到 GitHub（通过标准输入传递，keystore 不出现在命令行中；口令为隐藏输入）。变量值取上一步输出的 `SHA256:` 一行：

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\.config\edgeever-fork\android-fork.p12")) | gh secret set FORK_ANDROID_KEYSTORE_BASE64 --env fork-android -R lauchiwa/edgeever
   gh secret set FORK_ANDROID_KEYSTORE_PASSWORD --env fork-android -R lauchiwa/edgeever
   gh variable set FORK_ANDROID_SIGNER_SHA256 -R lauchiwa/edgeever --body "<SHA256 指纹>"
   ```

4. 把 `.p12` 文件及其口令备份到离线位置。丢失后，新构建无法覆盖安装当前版本，只能卸载应用，本地缓存随之丢失（服务端数据不受影响）。

安装：包名与上游相同但签名不同，Android 会拒绝覆盖安装上游应用。先卸载上游应用（其本地缓存和尚未发送的离线修改会丢失），再安装二开 APK 并重新登录。之后的二开构建可以互相覆盖安装。

## Linux AppImage

- 适用于 x64、glibc 2.35 及以上的发行版（如 Ubuntu 22.04+）。运行 AppImage 需要 FUSE 2：Ubuntu 22.04 安装 `libfuse2`，Ubuntu 24.04 安装 `libfuse2t64`。
- 从 Releases 下载 `EdgeEver-X.Y.Z-rc.N-linux-x64.AppImage`，可以先用 `sha256sum --check SHA256SUMS-linux.txt` 核对，然后 `chmod +x` 并直接运行。**只有直接运行 AppImage 文件时才会自动更新**，解包或经第三方工具集成后不会。
- 应用会在后台下载新版本，并用新版本替换这个 AppImage 文件；该文件及其所在目录必须对当前用户可写。
- 上游 Linux 预览版（不带后缀的版本号）不会自动更新到二开版本，需要手动下载二开 AppImage。
- **Linux 更新没有签名：**能修改本 fork Releases 的人（GitHub 账号或一次发布运行）可以发布已安装 Linux 客户端会接受的更新。Windows 的签名密钥同样存放在 GitHub，所以两者的风险边界都是这个 GitHub 账号。

## macOS

- 两个下载文件：`EdgeEver-X.Y.Z-rc.N-mac-arm64.dmg`（Apple 芯片）和 `-mac-x64.dmg`（Intel），要求 macOS 13 及以上。可以先用 `shasum -a 256 -c SHA256SUMS-macos.txt` 核对（未下载的文件会报缺失）。
- **应用未经公证，Gatekeeper 会阻止首次启动。**从磁盘映像把 EdgeEver 拖入“应用程序”，打开一次，然后在“系统设置 → 隐私与安全性”中点“仍要打开”。也可以在终端中移除下载标记：`xattr -dr com.apple.quarantine /Applications/EdgeEver.app`。
- 更新会在后台下载完整 zip（不提供 blockmap，因此没有差分下载），在应用重启时安装。应用必须放在当前用户可写的位置，例如 `/Applications`。
- 二开沿用上游的 bundle id，所以会替换上游安装并保留其数据，但两者不会互相自动更新：它们的指定要求不同。覆盖上游安装后，macOS 很可能会询问一次是否允许 EdgeEver 使用钥匙串项“EdgeEver Safe Storage”（选择“始终允许”）；拒绝会让桌面端退出登录。
- **macOS 更新的信任来自二开证书**，其私钥和 Windows 的一样存放在 GitHub：所有平台的风险边界都是这个 GitHub 账号。
- 微信分享扩展使用同一张证书签名。

## 已安装的客户端

- 在 fork 更新源建立之前构建的版本（例如不带后缀的 `1.119.0`），无法自动更新到版本更低的 `1.119.0-rc.0`。第一个 fork 版本需要手动安装；之后的 fork 版本可以原地自动更新。
- 安装包保持相同的 appId 和数据目录，所以在上游版本上覆盖安装 fork 版本，会保留本地数据。
