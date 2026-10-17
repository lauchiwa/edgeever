# 二开版发布（lauchiwa/edgeever）

本仓库是上游 EdgeEver（`tianma-if/edgeever`）的二次开发 fork。它在自己的 Releases 页面构建并发布 Windows 桌面版，已安装的二开客户端只从这里更新。不会向上游写入任何内容。English: [fork-releases.md](fork-releases.md).

当前范围：**Windows x64 桌面端，以及服务端镜像** `ghcr.io/lauchiwa/edgeever`（API 与浏览器 Web 端）。不发布 macOS、Linux、Android 和 iOS 的二开版本（Windows 验证稳定后再支持 Linux）。Android 只有作为工作流产物的**测试版**，见 [Android 测试版](#android-测试版)。[加密笔记](encrypted-notes.zh-CN.md)等二开功能需要二开客户端与运行二开镜像的服务端同时具备。

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
| 链接 | 诊断、反馈、桌面端下载指向 fork；服务端 Release 说明在二开镜像（`vX.Y.Z-rc.N`）下指向 fork，否则指向上游；保留若干有意指向上游的链接（Android APK 下载、上游服务端 Release 说明、插件文档、移动端的上游更新检查与主页链接） | 上游地址扫描及白名单 |
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
   - `windows` 任务检查 tag 是否位于 `main` 上，运行发布检查（包括两把公钥都已固定），写入版本号，构建并试启动 Windows 应用，然后上传一个 **Draft** 预发布版本，包含安装包、`rc.yml`、`latest-windows.json` 和 `SHA256SUMS-windows.txt`。
   - `publish` 任务签名 `latest-windows.json`，上传签名，重新下载全部 5 个资产，按客户端的方式完整校验，校验通过后才发布。

   客户端看不到 Draft，所以失败后可以安全重试：修复原因后，用同一个 tag 手动运行工作流（Actions → Fork release → 在 `main` 上 Run workflow）。
3. 本机兜底方式，例如 Environment Secret 不可用时（使用 PowerShell 或 Windows Terminal，不要用 Git Bash；口令会提示输入）：

   ```powershell
   $env:EDGE_EVER_WINDOWS_UPDATE_SIGNING_KEY = "$HOME\.config\edgeever-fork\windows-update-ed25519-primary.pem"
   node scripts/fork-sign-release.mjs v1.119.0-rc.0 --publish
   ```

同一个 tag 还会触发 `fork-docker-image.yml` 构建服务端镜像（见下文）。两个工作流互相独立：镜像构建失败不会阻塞 Windows 发布，可以用同一个 tag 手动运行该工作流重建。

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

## 已安装的客户端

- 在 fork 更新源建立之前构建的版本（例如不带后缀的 `1.119.0`），无法自动更新到版本更低的 `1.119.0-rc.0`。第一个 fork 版本需要手动安装；之后的 fork 版本可以原地自动更新。
- 安装包保持相同的 appId 和数据目录，所以在上游版本上覆盖安装 fork 版本，会保留本地数据。
