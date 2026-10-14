# 本 fork 的 macOS Release

本入口仅向 `victorcheng2333/cindy-feige` 发布中国大陆版 macOS 个人包，固定包含
arm64（Apple Silicon）和 x64（Intel）。使用本机 Developer ID Application:
Tools UG (KQY8A3BNVG) 签名，不做 Apple 公证；应用保持 0.0.0，不参与自动更新。
它不调用 OSS/CDN 发布入口，不修改自动更新配置，不发布其他平台或国际版。

## 使用

在 macOS 上准备 Xcode、项目依赖、可用签名证书，以及已登录的 `gh` 和 GitHub Git
推送权限。`origin` 必须指向本 fork。运行：

```bash
node scripts/release-personal-macos.mjs --tag personal-cn-2026-10-13
```

脚本按 arm64、x64 依次调用 `pnpm package -- --region cn --arch <架构>`，复用
`signMacAppWithIdentity` 逐层签名，重新压缩为 Developer ID ZIP。随后解压验证签名、
证书、bundle ID、架构、版本、源码提交与 SHA256，生成元数据和校验文件，再发布
GitHub 预发布 Release。每次使用新标签；同日可追加 `-2` 等后缀。

只构建和验证，不访问 GitHub：

```bash
node scripts/release-personal-macos.mjs --tag personal-cn-2026-10-13 --prepare-only
```

复用已经生成的**双架构签名包和各自 JSON 元数据**，重新核验后发布：

```bash
node scripts/release-personal-macos.mjs --tag personal-cn-2026-10-13 --reuse-artifacts
```

两参数可组合，仅检查已有产物。复用要求两个架构源码提交一致；不接受旧的 ad-hoc
ZIP 或其 build-info.json 代替签名元数据。`--help` 不执行构建或外部写入。

## 产物与 Git 边界

- 包和签名元数据：`apps/desktop/release/artifacts/cn/unversioned/darwin-<arch>/`。
- 发布说明和 SHA256SUMS.txt：上述 `unversioned/<tag>/`。
- 只向 origin 推送指向包内源码提交的 Release 标签，不推进 main，也不自动提交源码。
  两个架构对应同一个提交，但允许工作区未提交改动；需要完全可追溯时先提交源码再构建。
- 以 `--repo victorcheng2333/cindy-feige` 显式指定每次 GitHub 操作，避免 `gh` 对 fork
  默认选中 upstream。附件只包含两个签名 ZIP、签名元数据与校验文件。
- 上传结束后比对 GitHub 返回的每个附件的大小与 SHA256 digest。
- 不替换已有标签或 Release。上传中断可能留下标签和草稿；先在本 fork 检查它们，
  按需用 `gh release upload --repo victorcheng2333/cindy-feige <tag> <文件>` 补传并
  核对附件，再发布草稿；也可以使用新标签重试，不自动删除既有内容。

个人打包的验证边界沿用 [desktop-development.md](desktop-development.md)：基础入口保留
依赖、资源及数据库迁移完整性校验，跳过启动冒烟；此脚本额外做签名和发布附件校验。
它不会代替单测、类型检查或实机安装验收，也不要求 Apple 公证凭据。
